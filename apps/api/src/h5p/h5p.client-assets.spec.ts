import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../config/configuration.js';
import { H5pClientAssets, missingAssetsMessage } from './h5p.client-assets.js';

let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'h5p-assets-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(work, { recursive: true, force: true });
});

function assetsAt(directory: string): H5pClientAssets {
  const config = {
    get: (key: string) => (key === 'H5P_ASSETS_DIR' ? directory : undefined),
  } as unknown as ConfigService<Env, true>;

  return new H5pClientAssets(config);
}

/** Writes one kind's sentinel, which is what makes a tree count as installed. */
async function install(directory: string, kind: 'core' | 'editor'): Promise<void> {
  const file =
    kind === 'core' ? join(directory, 'core', 'js') : join(directory, 'editor', 'scripts');
  await mkdir(file, { recursive: true });
  await writeFile(join(file, kind === 'core' ? 'h5p.js' : 'h5peditor.js'), 'x', 'utf-8');
}

describe('H5pClientAssets', () => {
  it('resolves each kind under the configured directory', () => {
    const assets = assetsAt(work);

    expect(assets.rootOf('core')).toBe(join(work, 'core'));
    expect(assets.rootOf('editor')).toBe(join(work, 'editor'));
  });

  it('resolves a relative directory against the process root, as the app is started', () => {
    // `H5P_ASSETS_DIR` is `./h5p` by default and the API runs with `apps/api` as
    // its working directory, the same way `H5P_TEMP_DIR` does.
    expect(assetsAt('./h5p').rootOf('core')).toBe(resolve('./h5p', 'core'));
  });

  it('reports a kind as installed only when its sentinel file is there', async () => {
    await install(work, 'core');

    await expect(assetsAt(work).isInstalled('core')).resolves.toBe(true);
    await expect(assetsAt(work).isInstalled('editor')).resolves.toBe(false);
  });

  it('reports a kind as missing when the directory exists but the files do not', async () => {
    // A failed or interrupted fetch leaves the directory behind. Stat-ing the
    // directory would report assets that are not there, and the routes would
    // then 404 per file with nothing to explain it.
    await mkdir(join(work, 'core'), { recursive: true });

    await expect(assetsAt(work).isInstalled('core')).resolves.toBe(false);
  });

  it('warns once per missing kind at boot and does not throw', async () => {
    // A developer with no network still has to be able to boot the API and work
    // on everything that is not H5P.
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await install(work, 'core');

    await expect(assetsAt(work).onModuleInit()).resolves.toBeUndefined();

    expect(warn.mock.calls.map(([message]) => message)).toEqual([missingAssetsMessage('editor')]);
  });

  it('says nothing at boot when both trees are installed', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await install(work, 'core');
    await install(work, 'editor');

    await assetsAt(work).onModuleInit();

    expect(warn).not.toHaveBeenCalled();
  });

  it('names the command that fixes it', () => {
    expect(missingAssetsMessage('core')).toContain('pnpm h5p:fetch');
  });
});
