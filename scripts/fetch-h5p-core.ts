import { createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { open } from 'yauzl-promise';

/**
 * Downloads the H5P client libraries the API serves from `GET /api/h5p/core/*`
 * and `GET /api/h5p/editor-assets/*`.
 *
 * They are **not** shipped by `@lumieducation/h5p-server`: Joubel releases the
 * browser-side core and editor as two separate PHP-library repositories, and
 * npm carries neither. Without them the H5P client cannot boot, so every asset
 * URL in a player model 404s.
 *
 * Runs from the root `postinstall` and from the API Dockerfile. The two
 * failure modes are deliberately different — see `main`.
 */

export type H5pAssetKind = 'core' | 'editor';

export interface H5pAssetPin {
  /** Directory under the assets root, and the route that serves it. */
  readonly kind: H5pAssetKind;
  readonly repo: string;
  readonly commit: string;
  /** sha256 over the extracted tree; see `contentDigest`. */
  readonly digest: string;
  /**
   * One file that must exist afterwards, used as the on-disk marker.
   *
   * The same two names `apps/api/src/h5p/h5p.client-assets.ts` checks before
   * serving. Kept in both places rather than shared: they are different
   * packages, and a script that imported from the API's sources would drag the
   * API's dependency graph into `postinstall`.
   */
  readonly sentinel: string;
}

/**
 * Commit SHAs, not tags. The two repositories' tags are WordPress release tags
 * (`wp-*`) that do not track the `h5pVersion` the library reports, and upstream's
 * own example server pins SHAs for exactly this reason. A tag can move; a commit
 * cannot.
 */
export const H5P_ASSET_PINS: readonly H5pAssetPin[] = [
  {
    kind: 'core',
    repo: 'h5p/h5p-php-library',
    commit: '2aeb0b83fa603e331381b3a6b8bf42c3773ba140',
    digest: 'fade38e977afad6b819b6875d549cd1beabe5f8f13aa0345f637033fb7393839',
    sentinel: 'js/h5p.js',
  },
  {
    kind: 'editor',
    repo: 'h5p/h5p-editor-php-library',
    commit: 'ab2daa18bd61b19e7f8729e22eec88f3b637a868',
    digest: 'e7fea044a344afcca6d40a219dbc16dfb9445dfd469bf05b634ba0befd0e4e1f',
    sentinel: 'scripts/h5peditor.js',
  },
];

const REPO_ROOT = resolve(import.meta.dirname, '..');

/** Where the API's `H5P_ASSETS_DIR` default (`./h5p`, relative to `apps/api`) lands. */
export const ASSETS_ROOT = join(REPO_ROOT, 'apps', 'api', 'h5p');

/** Records which commit and digest each kind on disk came from. */
export const MARKER_FILE = '.assets.json';

/** Extraction happens here and is renamed into place, so a half-tree is never visible. */
const TEMP_DIRNAME = '.fetch-tmp';

/** The command the warning tells a developer to run. */
export const FETCH_COMMAND = 'pnpm h5p:fetch';

export interface AssetMarkerEntry {
  commit: string;
  digest: string;
}

export type AssetMarker = Partial<Record<H5pAssetKind, AssetMarkerEntry>>;

/** A download that did not happen, as opposed to bytes that were wrong. */
export class AssetDownloadError extends Error {}

/**
 * sha256 over the extracted tree, not over the archive.
 *
 * GitHub's `codeload` zips are not byte-stable — the same commit has been
 * re-encoded before — so a checksum of the container would fail spuriously and
 * teach everyone to update the constant without reading it. The tree is stable
 * by definition: it is the commit.
 *
 * Directories contribute nothing, so an empty directory the archiver did or did
 * not record cannot change the answer. Paths are sorted in byte order and each
 * one is bound to its content by a NUL, so renaming a file between two others
 * changes the digest.
 */
export async function contentDigest(root: string): Promise<string> {
  const files = await listFiles(root);
  files.sort((a, b) => Buffer.compare(Buffer.from(a, 'utf-8'), Buffer.from(b, 'utf-8')));

  const digest = createHash('sha256');
  for (const file of files) {
    const bytes = await readFile(join(root, ...file.split('/')));
    digest.update(`${file}\0${createHash('sha256').update(bytes).digest('hex')}\n`);
  }

  return digest.digest('hex');
}

async function listFiles(root: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(prefix ? join(root, ...prefix.split('/')) : root, {
    withFileTypes: true,
  });

  const files: string[] = [];
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await listFiles(root, path)));
    } else {
      files.push(path);
    }
  }

  return files;
}

export async function readMarker(assetsRoot: string): Promise<AssetMarker> {
  try {
    const raw = await readFile(join(assetsRoot, MARKER_FILE), 'utf-8');
    return JSON.parse(raw) as AssetMarker;
  } catch {
    return {};
  }
}

/**
 * Whether this pin still has to be fetched.
 *
 * The marker alone is not trusted: a developer who deletes `apps/api/h5p/core`
 * to reclaim disk, or a Docker stage that copies the marker without the tree,
 * would otherwise be told everything is installed and get 503s from the asset
 * routes with nothing to explain them. The sentinel is what makes the answer
 * about the files rather than about a note next to them.
 */
export async function needsFetch(assetsRoot: string, pin: H5pAssetPin): Promise<boolean> {
  const recorded = (await readMarker(assetsRoot))[pin.kind];
  if (recorded?.commit !== pin.commit || recorded.digest !== pin.digest) {
    return true;
  }

  return !(await exists(join(assetsRoot, pin.kind, ...pin.sentinel.split('/'))));
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** The single top-level folder a GitHub archive of `<repo>@<commit>` contains. */
export function archiveTopLevel(pin: H5pAssetPin): string {
  const name = pin.repo.slice(pin.repo.indexOf('/') + 1);
  return `${name}-${pin.commit}`;
}

export function archiveUrl(pin: H5pAssetPin): string {
  return `https://github.com/${pin.repo}/archive/${pin.commit}.zip`;
}

/**
 * Strips the archive's single top-level folder, asserting that it is the one
 * the pin's commit produces.
 *
 * A blind `split('/').slice(1)` would happily accept an archive of a different
 * commit — or of a different repository — and the digest check would then be
 * the only thing between us and serving it.
 */
export function relativeEntryPath(name: string, topLevel: string): string | null {
  if (name === `${topLevel}/`) {
    return null;
  }
  if (!name.startsWith(`${topLevel}/`)) {
    throw new Error(`Unexpected archive layout: "${name}" is not under "${topLevel}/".`);
  }

  const relative = name.slice(topLevel.length + 1);
  assertSafeEntryPath(relative, name);
  return relative;
}

/**
 * The same discipline `apps/api/src/h5p/h5p.package-scan.ts` applies to an
 * uploaded package, for the same reason: extraction is a `path.join` onto a
 * destination, and a `..` segment in an entry name is a write anywhere on the
 * filesystem. That these bytes come from a pinned commit does not make the
 * check optional — a redirect, a proxy or a compromised release is exactly the
 * case it exists for.
 */
function assertSafeEntryPath(relative: string, name: string): void {
  const illegal = (reason: string): never => {
    throw new Error(`Refusing archive entry "${name}": ${reason}.`);
  };

  if (relative === '') {
    illegal('the name is empty after stripping the top-level folder');
  }
  if (relative.startsWith('/')) {
    illegal('it is an absolute path');
  }
  if (relative.includes('\\')) {
    illegal('it contains a backslash');
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(relative)) {
    illegal('it contains a control character');
  }

  const segments = relative.endsWith('/') ? relative.slice(0, -1).split('/') : relative.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    illegal('it contains an empty, "." or ".." segment');
  }
}

/** Unpacks `archivePath` into an empty `destination`, top-level folder stripped. */
export async function extractArchive(
  archivePath: string,
  destination: string,
  topLevel: string,
): Promise<void> {
  // Yauzl's own name validation is off so that the rule which decides is the
  // one above, whose message names the archive and the reason.
  const zip = await open(archivePath, { validateFilenames: false });

  try {
    for await (const entry of zip) {
      const relative = relativeEntryPath(entry.filename, topLevel);
      if (relative === null) {
        continue;
      }

      const target = join(destination, ...relative.split('/'));
      if (relative.endsWith('/')) {
        await mkdir(target, { recursive: true });
        continue;
      }

      await mkdir(dirname(target), { recursive: true });
      await pipeline(await entry.openReadStream(), createWriteStream(target));
    }
  } finally {
    await zip.close().catch(() => undefined);
  }
}

async function download(pin: H5pAssetPin, into: string): Promise<void> {
  let bytes: Buffer;

  try {
    const response = await fetch(archiveUrl(pin));
    if (!response.ok) {
      throw new AssetDownloadError(`${archiveUrl(pin)} answered ${response.status}.`);
    }
    // Buffered rather than streamed: these archives are a few megabytes, and a
    // body that stops half way has to be a failed *download* — streaming it to
    // disk would make it a corrupt archive instead, which is the loud failure
    // mode and the wrong one for a flaky network.
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    if (error instanceof AssetDownloadError) {
      throw error;
    }
    throw new AssetDownloadError(
      `${archiveUrl(pin)} could not be reached: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  await writeFile(into, bytes);
}

/**
 * Downloads, verifies and installs one pin.
 *
 * The destination is replaced by a rename of a fully extracted and verified
 * tree, so a run that fails part way leaves the previous tree intact rather
 * than a directory that is half of two versions.
 */
export async function fetchPin(pin: H5pAssetPin, assetsRoot: string): Promise<void> {
  const tempRoot = join(assetsRoot, TEMP_DIRNAME);
  await mkdir(tempRoot, { recursive: true });
  const staging = await mkdtemp(join(tempRoot, `${pin.kind}-`));
  const archive = join(await mkdtemp(join(tmpdir(), 'h5p-asset-')), `${pin.kind}.zip`);

  try {
    await download(pin, archive);
    await extractArchive(archive, staging, archiveTopLevel(pin));

    const digest = await contentDigest(staging);
    if (digest !== pin.digest) {
      throw new Error(
        `${pin.repo}@${pin.commit} extracted to digest ${digest}, but the pin says ${pin.digest}. ` +
          'Either the archive is not what it claims to be, or the pin was updated without its digest.',
      );
    }

    const destination = join(assetsRoot, pin.kind);
    await rm(destination, { recursive: true, force: true });
    await rename(staging, destination);

    const marker = await readMarker(assetsRoot);
    marker[pin.kind] = { commit: pin.commit, digest: pin.digest };
    await writeFile(join(assetsRoot, MARKER_FILE), `${JSON.stringify(marker, null, 2)}\n`, 'utf-8');
  } finally {
    await rm(dirname(archive), { recursive: true, force: true }).catch(() => undefined);
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Two failure modes, on purpose.
 *
 * A developer on a plane must still be able to run `pnpm install`, so a
 * download that does not happen is a warning and exit 0 — the API boots without
 * the assets and the routes answer 503 naming this command. Bytes that are
 * *wrong* are a different thing entirely and always exit 1.
 *
 * `--require` collapses the first case into the second. The Dockerfile passes
 * it, because an image that cannot serve the H5P client is broken rather than
 * inconvenient, and nobody is watching that build's warnings.
 */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const required = argv.includes('--require');
  let missing = false;

  for (const pin of H5P_ASSET_PINS) {
    if (!(await needsFetch(ASSETS_ROOT, pin))) {
      console.log(`H5P ${pin.kind} assets are already at ${pin.commit.slice(0, 10)}.`);
      continue;
    }

    try {
      console.log(`Fetching H5P ${pin.kind} assets from ${pin.repo}@${pin.commit.slice(0, 10)}…`);
      await fetchPin(pin, ASSETS_ROOT);
      console.log(`Installed H5P ${pin.kind} assets into apps/api/h5p/${pin.kind}.`);
    } catch (error) {
      if (!(error instanceof AssetDownloadError)) {
        throw error;
      }
      missing = true;
      console.warn(
        `Could not download the H5P ${pin.kind} assets (${error.message}). ` +
          `The API will boot, but its H5P asset routes answer 503 until you run \`${FETCH_COMMAND}\`.`,
      );
    }
  }

  await rm(join(ASSETS_ROOT, TEMP_DIRNAME), { recursive: true, force: true }).catch(
    () => undefined,
  );

  return required && missing ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
