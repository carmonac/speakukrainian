import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The root `postinstall`, driven as a command rather than as a function.
 *
 * pnpm runs the root project's lifecycle scripts even under `--filter`, so this
 * one line runs in every install of every subset of the workspace — including
 * the ones the admin and web images do, whose build context holds package
 * manifests and nothing else. It shipped once as a bare
 * `node scripts/fetch-h5p-core.ts` and broke both of those image builds on
 * `Cannot find module`, which only the `images` CI job could see.
 *
 * So the command is asserted here, from the manifest, in a directory that has
 * whatever the case under test says it has. It lives in this package because
 * this package owns the script the command runs; it is the only thing here that
 * reaches out to the repository root.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');

/** The path the guard tests for, written out rather than parsed back out of the command. */
const FETCH_SCRIPT = 'scripts/fetch-h5p-core.ts';

function postinstallCommand(): string {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8')) as {
    scripts?: Record<string, string>;
  };
  const command = manifest.scripts?.postinstall;
  if (command === undefined) {
    throw new Error('The root package.json has no `postinstall` script.');
  }
  return command;
}

interface Run {
  status: number | null;
  stdout: string;
}

/** Through a shell, because that is how pnpm hands a lifecycle script to the OS. */
function runPostinstall(cwd: string): Run {
  const result = spawnSync(postinstallCommand(), { cwd, shell: true, encoding: 'utf-8' });
  return { status: result.status, stdout: `${result.stdout}${result.stderr}` };
}

let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'root-postinstall-spec-'));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

/** A stand-in for the real fetch, so no case here touches the network. */
async function installStub(body: string): Promise<void> {
  await mkdir(join(work, 'scripts'), { recursive: true });
  await writeFile(join(work, FETCH_SCRIPT), body, 'utf-8');
}

describe('the root postinstall', () => {
  it('succeeds and does nothing when the fetch script is not part of the install', () => {
    // `pnpm install --filter @speakukrainian/admin...` inside the admin image:
    // the script is not in the build context, and nothing in that image wants
    // the H5P client assets. Failing here fails the whole image build.
    const run = runPostinstall(work);

    expect(run.status).toBe(0);
    // Silence would be worse than the crash: a skipped fetch has to be visible
    // in the log of whoever later wonders where the assets went.
    expect(run.stdout).toContain(FETCH_SCRIPT);
    expect(run.stdout).toMatch(/skipping/i);
  });

  it('runs the fetch script when it is there', async () => {
    // The other half of the guard, and the one that goes quietly wrong: a path
    // that no longer matches would turn every install into the case above and
    // nobody would notice until an asset route answered 503.
    await installStub("require('node:fs').writeFileSync('fetched.txt', 'ran');\n");

    const run = runPostinstall(work);

    expect(run.status).toBe(0);
    expect(existsSync(join(work, 'fetched.txt'))).toBe(true);
  });

  it('fails the install when the fetch script fails', async () => {
    // Wrong bytes exit 1 and must stay fatal. A guard that swallowed the exit
    // code would turn a corrupt asset tree into a clean install.
    await installStub('process.exit(1);\n');

    expect(runPostinstall(work).status).toBe(1);
  });

  it('names a script this repository actually ships', () => {
    // The stub above proves the command runs *a* file at that path. This is
    // what ties the path to the real one, so a rename cannot silently disable
    // the fetch for everybody.
    expect(postinstallCommand()).toContain(FETCH_SCRIPT);
    expect(existsSync(join(REPO_ROOT, FETCH_SCRIPT))).toBe(true);
  });
});

describe('the API image', () => {
  const dockerfile = readFileSync(join(REPO_ROOT, 'apps', 'api', 'Dockerfile'), 'utf-8');

  it('still turns a fetch it cannot do into a failed build', () => {
    // What makes the soft postinstall safe. The API image is the one that has
    // to serve these assets, so it opts in by copying the script and then
    // re-runs it with `--require`, which is the only place the offline case is
    // fatal. Without that line a build with no network would produce an image
    // whose H5P asset routes all answer 503.
    expect(dockerfile).toContain('COPY scripts/fetch-h5p-core.ts scripts/');
    expect(dockerfile).toContain('node scripts/fetch-h5p-core.ts --require');
  });
});
