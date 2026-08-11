import { describe, expect, it } from 'vitest';
import { MAX_H5P_UPLOAD_BYTES } from '@speakukrainian/shared';
import { createH5pConfig } from './h5p.config.js';

const BASE_URL = '/api/h5p';

describe('createH5pConfig', () => {
  it('states one size limit, the API-wide one', () => {
    // The stock defaults are 16 MiB per file and 64 MiB total, enforced by
    // `PackageValidator` before anything else runs. Drop these overrides and a
    // 70 MB package that passes the route's 100 MB limit dies inside the
    // library quoting a limit no part of this API advertises.
    const config = createH5pConfig(BASE_URL);

    expect(config.maxFileSize).toBe(MAX_H5P_UPLOAD_BYTES);
    expect(config.maxTotalSize).toBe(MAX_H5P_UPLOAD_BYTES);
    expect(config.maxFileSize).not.toBe(16 * 1024 * 1024);
  });

  it('budgets a library install for object storage, not for a local disk', () => {
    // The stock 10 s answers a cold install of a real content type with a 500
    // about two runs in three: every library directory of a package installs
    // concurrently under its own lock key, so each one's budget has to cover
    // the whole import rather than its own share of it.
    const config = createH5pConfig(BASE_URL);

    expect(config.installLibraryLockMaxOccupationTime).toBe(300_000);
    expect(config.installLibraryLockMaxOccupationTime).not.toBe(10_000);
    // Unreachable in this configuration — the occupation timer is armed for a
    // waiter too — and kept above the budget to mirror the library's own ratio.
    expect(config.installLibraryLockTimeout).toBe(600_000);
    expect(config.installLibraryLockTimeout).toBeGreaterThan(
      config.installLibraryLockMaxOccupationTime,
    );
  });

  it('leaves result tracking off, since nothing stores user data', () => {
    expect(createH5pConfig(BASE_URL).setFinishedEnabled).toBe(false);
  });

  it('switches off every feature that would use the H5P hub', () => {
    // Necessary and *not* sufficient: `fetchingDisabled` is only a field in the
    // registration payload, so `content-type-cache` still POSTs to
    // `hubRegistrationEndpoint` unless the key-value cache is seeded. That
    // seeding is `h5p.module.ts`'s, and the e2e is where it is pinned.
    const config = createH5pConfig(BASE_URL);

    expect(config.contentHubEnabled).toBe(false);
    expect(config.fetchingDisabled).toBe(1);
    expect(config.sendUsageStatistics).toBe(false);
  });

  it('generates URLs from the base URL it is given', () => {
    // It has to be absolute wherever the page's origin differs from the API's,
    // which is every local development setup, so it cannot be a constant here.
    expect(createH5pConfig('http://localhost:8080/api/h5p').baseUrl).toBe(
      'http://localhost:8080/api/h5p',
    );
    expect(createH5pConfig(BASE_URL).baseUrl).toBe(BASE_URL);
  });

  it('serves the editor client library from a path that does not collide with the editor model', () => {
    // The stock value is `/editor`, which is where the editor *model* route
    // goes. Asserted against the config object rather than a literal, because
    // `H5PConfig`'s defaults loop silently drops any key whose class default is
    // `undefined` and a no-op override would otherwise look correct.
    const config = createH5pConfig(BASE_URL);

    expect(config.editorLibraryUrl).toBe('/editor-assets');
    expect(config.editorLibraryUrl).not.toBe('/editor');
  });

  it('keeps the routes the serving endpoints are mounted at', () => {
    // Each of these is the suffix `UrlGenerator` puts after `baseUrl`, so a
    // change here silently 404s every asset URL in a player model.
    const config = createH5pConfig(BASE_URL);

    expect(config.coreUrl).toBe('/core');
    expect(config.librariesUrl).toBe('/libraries');
    expect(config.contentFilesUrl).toBe('/content');
    expect(config.playUrl).toBe('/play');
  });

  it('keeps txt and js on the whitelists the fixture package relies on', () => {
    const config = createH5pConfig(BASE_URL);

    expect(config.contentWhitelist.split(' ')).toContain('txt');
    expect(config.libraryWhitelist.split(' ')).toContain('js');
  });
});
