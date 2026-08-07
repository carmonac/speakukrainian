import { describe, expect, it } from 'vitest';
import { MAX_H5P_UPLOAD_BYTES } from '@speakukrainian/shared';
import { createH5pConfig } from './h5p.config.js';

describe('createH5pConfig', () => {
  it('states one size limit, the API-wide one', () => {
    // The stock defaults are 16 MiB per file and 64 MiB total, enforced by
    // `PackageValidator` before anything else runs. Drop these overrides and a
    // 70 MB package that passes the route's 100 MB limit dies inside the
    // library quoting a limit no part of this API advertises.
    const config = createH5pConfig();

    expect(config.maxFileSize).toBe(MAX_H5P_UPLOAD_BYTES);
    expect(config.maxTotalSize).toBe(MAX_H5P_UPLOAD_BYTES);
    expect(config.maxFileSize).not.toBe(16 * 1024 * 1024);
  });

  it('budgets a library install for object storage, not for a local disk', () => {
    // The stock 10 s answers a cold install of a real content type with a 500
    // about two runs in three: `PackageImporter` queues ~68 library directories
    // at once and the occupation timer starts at queueing, so the budget has to
    // cover the whole import.
    const config = createH5pConfig();

    expect(config.installLibraryLockMaxOccupationTime).toBe(300_000);
    expect(config.installLibraryLockMaxOccupationTime).not.toBe(10_000);
    // A waiter must not be refused while the holder is still inside its budget.
    expect(config.installLibraryLockTimeout).toBe(600_000);
    expect(config.installLibraryLockTimeout).toBeGreaterThan(
      config.installLibraryLockMaxOccupationTime,
    );
  });

  it('leaves result tracking off, since nothing stores user data', () => {
    expect(createH5pConfig().setFinishedEnabled).toBe(false);
  });

  it('keeps the server off the H5P hub entirely', () => {
    const config = createH5pConfig();

    expect(config.contentHubEnabled).toBe(false);
    expect(config.fetchingDisabled).toBe(1);
    expect(config.sendUsageStatistics).toBe(false);
  });

  it('generates URLs under the API prefix the app is mounted at', () => {
    expect(createH5pConfig().baseUrl).toBe('/api/h5p');
  });

  it('keeps txt and js on the whitelists the fixture package relies on', () => {
    const config = createH5pConfig();

    expect(config.contentWhitelist.split(' ')).toContain('txt');
    expect(config.libraryWhitelist.split(' ')).toContain('js');
  });
});
