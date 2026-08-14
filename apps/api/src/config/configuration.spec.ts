import { describe, expect, it } from 'vitest';
import { loadConfig } from './configuration.js';

const required = {
  GOOGLE_CLOUD_PROJECT: 'speakukrainian-local',
  STORAGE_BUCKET: 'speakukrainian-media',
  H5P_URL_TOKEN_SECRET: 'a-signing-key-long-enough-to-be-one-0123456789',
};

describe('loadConfig', () => {
  it('applies defaults for optional settings', () => {
    const env = loadConfig(required);
    expect(env.PORT).toBe(8080);
    expect(env.NODE_ENV).toBe('development');
  });

  it('splits CORS_ORIGINS into a trimmed list', () => {
    const env = loadConfig({
      ...required,
      CORS_ORIGINS: 'http://a.test , http://b.test,',
    });
    expect(env.CORS_ORIGINS).toEqual(['http://a.test', 'http://b.test']);
  });

  it('coerces PORT, since Cloud Run supplies it as a string', () => {
    expect(loadConfig({ ...required, PORT: '9090' }).PORT).toBe(9090);
  });

  it('fails fast when a required setting is missing', () => {
    expect(() => loadConfig({ STORAGE_BUCKET: 'b' })).toThrow(/GOOGLE_CLOUD_PROJECT/);
  });

  it('refuses to boot without a signing key for the H5P URL token', () => {
    // No default on purpose: a placeholder in this repository would let anyone
    // mint a token for any uid. `.env.example` ships the key empty, so copying
    // it produces exactly the first case here.
    const { H5P_URL_TOKEN_SECRET: _omitted, ...withoutSecret } = required;

    expect(() => loadConfig(withoutSecret)).toThrow(/H5P_URL_TOKEN_SECRET/);
    expect(() => loadConfig({ ...required, H5P_URL_TOKEN_SECRET: '' })).toThrow(
      /H5P_URL_TOKEN_SECRET/,
    );
    expect(() => loadConfig({ ...required, H5P_URL_TOKEN_SECRET: 'x'.repeat(31) })).toThrow(
      /H5P_URL_TOKEN_SECRET/,
    );
    expect(loadConfig({ ...required, H5P_URL_TOKEN_SECRET: 'x'.repeat(32) })).toBeDefined();
  });

  it('rejects a storage endpoint that is not a URL', () => {
    expect(() => loadConfig({ ...required, STORAGE_API_ENDPOINT: 'localhost:4443' })).toThrow(
      /STORAGE_API_ENDPOINT/,
    );
  });

  it('rejects a stall timeout short enough to cut a healthy read', () => {
    expect(() => loadConfig({ ...required, H5P_STREAM_STALL_TIMEOUT_MS: '1' })).toThrow(
      /H5P_STREAM_STALL_TIMEOUT_MS/,
    );
    expect(() => loadConfig({ ...required, H5P_STREAM_STALL_TIMEOUT_MS: '999' })).toThrow(
      /H5P_STREAM_STALL_TIMEOUT_MS/,
    );
    expect(
      loadConfig({ ...required, H5P_STREAM_STALL_TIMEOUT_MS: '1000' }).H5P_STREAM_STALL_TIMEOUT_MS,
    ).toBe(1000);
  });
});
