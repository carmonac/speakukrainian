import { crc32 } from 'node:zlib';
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AssetDownloadError,
  FETCH_COMMAND,
  H5P_ASSET_PINS,
  MARKER_FILE,
  archiveTopLevel,
  archiveUrl,
  contentDigest,
  digestOfFiles,
  extractArchive,
  main,
  needsFetch,
  type H5pAssetPin,
} from './fetch-h5p-core.ts';

/**
 * A stored-method ZIP writer, local to this spec.
 *
 * It exists for the same reason `apps/api/src/h5p/h5p.raw-zip.ts` does: every
 * real writer refuses to emit the names the extractor has to be proved against,
 * which is correct of them and useless here. It is duplicated rather than
 * imported because `scripts` is a separate package that does not depend on the
 * API, and a shared helper would have to be published by one of them.
 */
function buildZip(entries: { name: string; content?: string }[]): Buffer {
  const LOCAL = 0x04034b50;
  const CENTRAL = 0x02014b50;
  const END = 0x06054b50;
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf-8');
    const body = Buffer.from(entry.content ?? '', 'utf-8');
    const checksum = crc32(body);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(name.length, 26);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(CENTRAL, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt32LE(checksum, 16);
    header.writeUInt32LE(body.length, 20);
    header.writeUInt32LE(body.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);

    parts.push(local, name, body);
    central.push(header, name);
    offset += local.length + name.length + body.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...parts, directory, end]);
}

let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'fetch-h5p-spec-'));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

async function writeTree(root: string, files: [path: string, content: string][]): Promise<void> {
  for (const [path, content] of files) {
    const target = join(root, ...path.split('/'));
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, content, 'utf-8');
  }
}

const exists = async (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

describe('contentDigest', () => {
  /**
   * Computed once from this exact tree and pinned, so the whole formula is
   * under test — the sort, the NUL between a path and its content hash, and
   * the newline between entries. An expected value recomputed in the test with
   * the same code would assert nothing.
   */
  const TREE: [string, string][] = [
    ['README.txt', 'hello\n'],
    ['js/h5p.js', 'window.H5P = {};\n'],
    ['js/vendor/jquery.js', '// jquery\n'],
  ];
  const TREE_DIGEST = '404b68ef8b676c1ee1abbf99e721c240c4abffdc3e4d61892a1d5834b15223f4';

  it('hashes the extracted tree, not the archive that carried it', async () => {
    await writeTree(work, TREE);

    await expect(contentDigest(work)).resolves.toBe(TREE_DIGEST);
  });

  it('changes when one byte of one file changes', async () => {
    await writeTree(work, TREE);
    await writeFile(join(work, 'js', 'h5p.js'), 'window.H5P = {};\r\n', 'utf-8');

    await expect(contentDigest(work)).resolves.not.toBe(TREE_DIGEST);
  });

  it('changes when a file is renamed but its bytes are not', async () => {
    // The NUL is what binds a path to its content. Without it, `a` + `bc` and
    // `ab` + `c` would hash identically and a moved file would be invisible.
    await writeTree(work, [
      ['README.txt', 'hello\n'],
      ['js/h5p.min.js', 'window.H5P = {};\n'],
      ['js/vendor/jquery.js', '// jquery\n'],
    ]);

    await expect(contentDigest(work)).resolves.not.toBe(TREE_DIGEST);
  });

  it('ignores an empty directory, which an archive may or may not record', async () => {
    await writeTree(work, TREE);
    await mkdir(join(work, 'styles', 'empty'), { recursive: true });

    await expect(contentDigest(work)).resolves.toBe(TREE_DIGEST);
  });
});

describe('digestOfFiles', () => {
  const FILES: [string, string][] = [
    ['README.txt', 'a'.repeat(64)],
    ['js/h5p.js', 'b'.repeat(64)],
    ['js/vendor/jquery.js', 'c'.repeat(64)],
  ];

  it('does not depend on the order the file list arrives in', () => {
    // Driven here rather than through the filesystem on purpose: APFS returns
    // directory entries already sorted, so a test that only reorders the
    // *writes* passes with the sort deleted, and a CI runner on ext4 would then
    // be the first thing to notice.
    const shuffled = [FILES[2], FILES[0], FILES[1]] as [string, string][];

    expect(digestOfFiles(shuffled)).toBe(digestOfFiles(FILES));
    expect(digestOfFiles([...FILES].reverse())).toBe(digestOfFiles(FILES));
  });

  it('sorts by bytes, not by locale', () => {
    // `localeCompare` puts `a.txt` before `Z.txt`; byte order does not. A digest
    // that changed with the machine's locale would fail on someone else's.
    const upper: [string, string] = ['Z.txt', 'd'.repeat(64)];
    const lower: [string, string] = ['a.txt', 'e'.repeat(64)];

    expect(digestOfFiles([upper, lower])).toBe(digestOfFiles([lower, upper]));
    expect(digestOfFiles([upper, lower])).not.toBe(
      digestOfFiles([
        [upper[0], lower[1]],
        [lower[0], upper[1]],
      ]),
    );
  });

  it('binds each path to its content, so swapping two files changes the digest', () => {
    const swapped: [string, string][] = [
      ['README.txt', 'b'.repeat(64)],
      ['js/h5p.js', 'a'.repeat(64)],
      ['js/vendor/jquery.js', 'c'.repeat(64)],
    ];

    expect(digestOfFiles(swapped)).not.toBe(digestOfFiles(FILES));
  });
});

describe('needsFetch', () => {
  const pin: H5pAssetPin = {
    kind: 'core',
    repo: 'h5p/h5p-php-library',
    commit: 'a'.repeat(40),
    digest: 'b'.repeat(64),
    sentinel: 'js/h5p.js',
  };

  const install = async (marker: unknown, withSentinel: boolean): Promise<void> => {
    await writeFile(join(work, MARKER_FILE), JSON.stringify(marker), 'utf-8');
    if (withSentinel) {
      await writeTree(work, [['core/js/h5p.js', 'window.H5P = {};\n']]);
    }
  };

  it('skips when the marker matches the pin and the sentinel is on disk', async () => {
    await install({ core: { commit: pin.commit, digest: pin.digest } }, true);

    await expect(needsFetch(work, pin)).resolves.toBe(false);
  });

  it('fetches when the commit matches but the digest is stale', async () => {
    // A pin whose commit was bumped without its digest, or a tree written by an
    // older version of this script. Trusting the commit alone would serve it.
    await install({ core: { commit: pin.commit, digest: 'c'.repeat(64) } }, true);

    await expect(needsFetch(work, pin)).resolves.toBe(true);
  });

  it('fetches when the marker matches but the tree is gone', async () => {
    // A developer reclaiming disk, or a Docker stage that copied the marker
    // without the files. Trusting the marker leaves the asset routes at 503
    // with nothing to explain them.
    await install({ core: { commit: pin.commit, digest: pin.digest } }, false);

    await expect(needsFetch(work, pin)).resolves.toBe(true);
  });

  it('fetches when there is no marker at all', async () => {
    await expect(needsFetch(work, pin)).resolves.toBe(true);
  });
});

describe('extractArchive', () => {
  const TOP = 'h5p-php-library-abcdef';

  const extract = async (entries: { name: string; content?: string }[]): Promise<string> => {
    const archive = join(work, 'archive.zip');
    await writeFile(archive, buildZip(entries));
    const destination = join(work, 'out');
    await extractArchive(archive, destination, TOP);
    return destination;
  };

  it('strips the top-level folder and writes the tree underneath it', async () => {
    const destination = await extract([
      { name: `${TOP}/` },
      { name: `${TOP}/js/` },
      { name: `${TOP}/js/h5p.js`, content: 'window.H5P = {};\n' },
    ]);

    await expect(readdir(destination)).resolves.toEqual(['js']);
    await expect(exists(join(destination, 'js', 'h5p.js'))).resolves.toBe(true);
  });

  it.each([
    ['a traversal segment', `${TOP}/../pwned.txt`],
    ['a traversal segment after a real one', `${TOP}/js/../../pwned.txt`],
    ['an absolute path inside the folder', `${TOP}//etc/pwned.txt`],
    ['a backslash', `${TOP}/..\\pwned.txt`],
    ['a NUL', `${TOP}/js/\u0000pwned.txt`],
    ['a "." segment', `${TOP}/./pwned.txt`],
  ])(
    'refuses an entry with %s and writes nothing outside the destination',
    async (_shape, name) => {
      const escape = join(work, 'pwned.txt');

      await expect(
        extract([{ name: `${TOP}/js/h5p.js`, content: 'ok\n' }, { name }]),
      ).rejects.toThrow(/Refusing archive entry/);
      await expect(exists(escape)).resolves.toBe(false);
    },
  );

  it('refuses an archive whose top-level folder is not the pinned one', async () => {
    // A blind `slice(1)` would accept an archive of some other commit, and the
    // digest would then be the only thing between us and serving it.
    await expect(
      extract([{ name: 'h5p-php-library-999999/js/h5p.js', content: 'ok\n' }]),
    ).rejects.toThrow(/Unexpected archive layout/);
  });

  it('refuses an entry that sits beside the top-level folder rather than inside it', async () => {
    await expect(extract([{ name: 'pwned.txt', content: 'ok\n' }])).rejects.toThrow(
      /Unexpected archive layout/,
    );
  });
});

describe('H5P_ASSET_PINS', () => {
  it('pins one core and one editor tree by full commit sha and tree digest', () => {
    // Cheap, and it catches a truncated paste — a 39-character commit is a 404
    // that only shows up on a machine with no assets yet.
    expect(H5P_ASSET_PINS.map((pin) => pin.kind)).toEqual(['core', 'editor']);

    for (const pin of H5P_ASSET_PINS) {
      expect(pin.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(pin.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(pin.repo).toMatch(/^h5p\/[a-z0-9-]+$/);
    }
  });

  it('builds the archive URL and the top-level folder from the commit', () => {
    const [core] = H5P_ASSET_PINS;
    expect(core).toBeDefined();
    if (!core) {
      return;
    }

    expect(archiveUrl(core)).toBe(`https://github.com/${core.repo}/archive/${core.commit}.zip`);
    expect(archiveTopLevel(core)).toBe(`h5p-php-library-${core.commit}`);
  });
});

describe('main', () => {
  /**
   * Two pins so that "carries on to the next one" is a claim this file can make.
   * Neither is real: `install` is injected, so nothing here reaches the network
   * or the repository's own asset tree.
   */
  const PINS: readonly H5pAssetPin[] = [
    {
      kind: 'core',
      repo: 'h5p/h5p-php-library',
      commit: 'a'.repeat(40),
      digest: 'b'.repeat(64),
      sentinel: 'js/h5p.js',
    },
    {
      kind: 'editor',
      repo: 'h5p/h5p-editor-php-library',
      commit: 'c'.repeat(40),
      digest: 'd'.repeat(64),
      sentinel: 'scripts/h5peditor.js',
    },
  ];

  /** Records which pins were installed and lets a chosen kind fail. */
  function installer(fail?: { kind: H5pAssetPin['kind']; error: Error }): {
    install: (pin: H5pAssetPin, assetsRoot: string) => Promise<void>;
    installed: () => string[];
  } {
    const installed: string[] = [];
    return {
      install: (pin) => {
        if (fail && pin.kind === fail.kind) {
          return Promise.reject(fail.error);
        }
        installed.push(pin.kind);
        return Promise.resolve();
      },
      installed: () => [...installed],
    };
  }

  const run = (
    argv: readonly string[],
    install: (pin: H5pAssetPin, assetsRoot: string) => Promise<void>,
  ): Promise<number> => main(argv, { assetsRoot: work, pins: PINS, install });

  let warnings: string[];

  beforeEach(() => {
    warnings = [];
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('installs every pin that is not already on disk and exits 0', async () => {
    const { install, installed } = installer();

    await expect(run([], install)).resolves.toBe(0);
    expect(installed()).toEqual(['core', 'editor']);
    expect(warnings).toEqual([]);
  });

  it('warns and still exits 0 when a download does not happen', async () => {
    // `pnpm install` on a plane. The assets are absent, the API boots without
    // them and its asset routes answer 503 — an inconvenience, not a broken
    // install, so failing here would make the whole repository unusable offline.
    const { install, installed } = installer({
      kind: 'core',
      error: new AssetDownloadError('github.com answered 503.'),
    });

    await expect(run([], install)).resolves.toBe(0);
    // The other pin is still installed: one repository being unreachable says
    // nothing about the other.
    expect(installed()).toEqual(['editor']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('github.com answered 503.');
    // The warning has to name the way out, because it scrolls past inside a
    // much longer install log.
    expect(warnings[0]).toContain(FETCH_COMMAND);
  });

  it('exits 1 for that same download under --require', async () => {
    // The whole contract of the `h5p-assets` Dockerfile stage and of CI's fetch
    // step: an image or a job that cannot serve the H5P client is broken, and
    // nobody reads a warning in a build log.
    const { install } = installer({
      kind: 'editor',
      error: new AssetDownloadError('fetch failed'),
    });

    await expect(run(['--require'], install)).resolves.toBe(1);
    expect(warnings).toHaveLength(1);
  });

  it('exits 0 under --require when every download succeeded', async () => {
    const { install } = installer();

    await expect(run(['--require'], install)).resolves.toBe(0);
  });

  it('raises anything that is not a failed download, flag or no flag', async () => {
    // A digest that does not match is wrong bytes rather than no bytes: it must
    // be loud on every path, which is why it is not caught into `missing`.
    const { install } = installer({
      kind: 'core',
      error: new Error('extracted to digest 00…, but the pin says ff…'),
    });

    await expect(run([], install)).rejects.toThrow(/the pin says/);
  });

  it('skips a pin that is already installed', async () => {
    const [core] = PINS;
    expect(core).toBeDefined();
    if (!core) {
      return;
    }
    await writeFile(
      join(work, MARKER_FILE),
      JSON.stringify({ core: { commit: core.commit, digest: core.digest } }),
      'utf-8',
    );
    await writeTree(work, [['core/js/h5p.js', 'window.H5P = {};\n']]);
    const { install, installed } = installer();

    await expect(run(['--require'], install)).resolves.toBe(0);
    expect(installed()).toEqual(['editor']);
  });

  it('leaves no staging directory behind when a download fails', async () => {
    // The run that exits 1 is the one most likely to be repeated, and an empty
    // `.fetch-tmp` is a puzzle for whoever looks at what the failure did.
    await mkdir(join(work, '.fetch-tmp', 'core-xyz'), { recursive: true });
    const { install } = installer({
      kind: 'core',
      error: new AssetDownloadError('fetch failed'),
    });

    await run(['--require'], install);

    await expect(exists(join(work, '.fetch-tmp'))).resolves.toBe(false);
  });
});
