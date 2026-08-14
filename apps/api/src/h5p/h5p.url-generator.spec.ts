import { describe, expect, it } from 'vitest';
import type { IUser } from '@lumieducation/h5p-server';
import { createH5pConfig } from './h5p.config.js';
import {
  TEMP_FILES_TOKEN_PATH,
  createH5pUrlGenerator,
  temporaryFilesUrlFor,
} from './h5p.url-generator.js';
import { signH5pUrlToken, verifyH5pUrlToken } from './h5p.url-token.js';

const SECRET = 'a-signing-key-long-enough-to-be-one-0123456789';

const userWith = (id: string): IUser => ({ id, email: '', name: '', type: 'local' });

const mint = (uid: string): string => signH5pUrlToken(SECRET, uid, Date.now() + 60_000);

/** The value of `?token=` in a URL the generator produced. */
const tokenIn = (url: string): string => {
  const match = /[?&]token=([^&]*)/.exec(url);
  if (!match?.[1]) {
    throw new Error(`no token query parameter in ${url}`);
  }
  return match[1];
};

describe('the H5P URL generator', () => {
  const generator = createH5pUrlGenerator(createH5pConfig('/api/h5p'), mint);

  it('puts a token that verifies for the caller into the ajax endpoint', () => {
    const url = generator.ajaxEndpoint(userWith('editor-one'));

    // The format is the library's: `?<name>=<value>&action=`, with the action
    // concatenated onto the end by `H5PEditor.getAjaxUrl`.
    expect(url).toMatch(/^\/api\/h5p\/ajax\?token=[A-Za-z0-9_.-]+&action=$/);
    expect(verifyH5pUrlToken(SECRET, tokenIn(url), Date.now())).toEqual({
      ok: true,
      uid: 'editor-one',
    });
  });

  it('mints a token per caller, so one editor’s URL never names another', () => {
    const first = generator.ajaxEndpoint(userWith('editor-one'));
    const second = generator.ajaxEndpoint(userWith('editor-two'));

    expect(verifyH5pUrlToken(SECRET, tokenIn(first), Date.now())).toEqual({
      ok: true,
      uid: 'editor-one',
    });
    expect(verifyH5pUrlToken(SECRET, tokenIn(second), Date.now())).toEqual({
      ok: true,
      uid: 'editor-two',
    });
  });

  it('leaves the routes this API does not serve untokenised', () => {
    // `trackResults` is off and no `IContentUserDataStorage` is wired, so a
    // token in either of these would be a credential in a URL nothing requests.
    const user = userWith('editor-one');

    expect(generator.contentUserData(user)).not.toContain('token=');
    expect(generator.setFinished(user)).not.toContain('token=');
  });

  it.each([
    ['the relative production default', '/api/h5p', '/api/h5p/temp/abc'],
    [
      'an absolute development base',
      'http://localhost:8080/api/h5p',
      'http://localhost:8080/api/h5p/temp/abc',
    ],
  ])('builds the preview prefix for %s', (_shape, baseUrl, expected) => {
    expect(temporaryFilesUrlFor(baseUrl, 'abc')).toBe(expected);
  });

  it('keeps the token a whole path segment of its own', () => {
    // `H5P.getPath` appends `'/' + path` to this prefix, so a segment carrying
    // a `/` would silently change which route the browser asks for.
    expect(TEMP_FILES_TOKEN_PATH).not.toContain('/');
    expect(temporaryFilesUrlFor('/api/h5p', mint('editor-one')).split('/')).toHaveLength(5);
  });
});
