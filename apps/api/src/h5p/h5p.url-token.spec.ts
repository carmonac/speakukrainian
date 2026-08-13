import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  H5P_URL_TOKEN_SCOPE,
  signH5pUrlToken,
  verifyH5pUrlToken,
  type H5pUrlTokenResult,
} from './h5p.url-token.js';

const SECRET = 'a-secret-long-enough-to-pass-the-schema-0123456789';
const OTHER_SECRET = 'a-different-secret-of-the-same-shape-0123456789012';
const UID = 'AaG7dQ1x2Yb3Zc4Vd5We6Xf7Yg8Z';
const NOW = Date.UTC(2026, 4, 1, 12, 0, 0);

/**
 * The wire format, restated independently of the implementation.
 *
 * Signing through `signH5pUrlToken` here would make the malformed-payload cases
 * unreachable — they need a *correct* signature over an incorrect payload, so
 * that verification gets past the signature step and has to decide what the
 * payload is. Restating the formula is also what makes a change to it a failing
 * test rather than a silent re-encoding.
 */
const sign = (encodedPayload: string, secret = SECRET): string =>
  `${encodedPayload}.${createHmac('sha256', secret).update(encodedPayload).digest('base64url')}`;

const encode = (payload: unknown): string =>
  Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

const payloadOf = (token: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;

const reasonOf = (result: H5pUrlTokenResult): string => (result.ok ? 'ok' : result.reason);

describe('the H5P URL token', () => {
  it('verifies a token it minted and answers with the uid it was minted for', () => {
    const token = signH5pUrlToken(SECRET, UID, NOW + 60_000);

    expect(verifyH5pUrlToken(SECRET, token, NOW)).toEqual({ ok: true, uid: UID });
  });

  it('refuses a payload re-signed for another user, which is what binds it to one', () => {
    // The unit half of "a token issued for one user does not authenticate
    // another user's request": editing `sub` is trivial, and the only thing
    // that stops it is that the signature no longer covers the payload.
    const token = signH5pUrlToken(SECRET, UID, NOW + 60_000);
    const tampered = `${encode({ ...payloadOf(token), sub: 'somebody-else' })}.${token.split('.')[1] ?? ''}`;

    expect(verifyH5pUrlToken(SECRET, tampered, NOW)).toEqual({ ok: false, reason: 'signature' });
  });

  it('refuses a token signed with another secret', () => {
    const token = signH5pUrlToken(OTHER_SECRET, UID, NOW + 60_000);

    expect(verifyH5pUrlToken(SECRET, token, NOW)).toEqual({ ok: false, reason: 'signature' });
  });

  it('refuses a token with any single character of its signature changed', () => {
    const token = signH5pUrlToken(SECRET, UID, NOW + 60_000);
    const [encoded, signature] = token.split('.') as [string, string];

    for (let index = 0; index < signature.length; index += 1) {
      const original = signature[index] as string;
      const flipped = original === 'A' ? 'B' : 'A';
      const mutated = `${encoded}.${signature.slice(0, index)}${flipped}${signature.slice(index + 1)}`;

      expect(verifyH5pUrlToken(SECRET, mutated, NOW)).toEqual({
        ok: false,
        reason: 'signature',
      });
    }
    // Otherwise a signature that had somehow become empty would pass vacuously.
    expect(signature.length).toBeGreaterThan(40);
  });

  it('treats an expiry exactly at the current instant as expired', () => {
    const token = signH5pUrlToken(SECRET, UID, NOW);

    expect(verifyH5pUrlToken(SECRET, token, NOW)).toEqual({ ok: false, reason: 'expired' });
  });

  it('accepts an expiry one millisecond away', () => {
    const token = signH5pUrlToken(SECRET, UID, NOW + 1);

    expect(verifyH5pUrlToken(SECRET, token, NOW)).toEqual({ ok: true, uid: UID });
  });

  it('refuses a token minted for another purpose as a scope failure, not a forgery', () => {
    // Two different diagnoses: a bad signature means somebody is trying things,
    // a wrong scope means a token this server really minted is being replayed
    // somewhere it was not meant for.
    const token = sign(encode({ v: 1, sub: UID, scope: 'something-else', exp: NOW + 60_000 }));

    expect(verifyH5pUrlToken(SECRET, token, NOW)).toEqual({ ok: false, reason: 'scope' });
  });

  it.each([
    ['an empty string', ''],
    ['a value with no separator', 'a'],
    ['three parts', 'a.b.c'],
  ])('refuses %s as malformed', (_shape, token) => {
    expect(verifyH5pUrlToken(SECRET, token, NOW)).toEqual({ ok: false, reason: 'malformed' });
  });

  it.each([
    ['a payload half that is not base64url', sign('!!! not base64url !!!')],
    [
      'a payload half that decodes to something that is not JSON',
      sign(Buffer.from('not json', 'utf8').toString('base64url')),
    ],
    ['a payload that is JSON but not an object', sign(encode('a string'))],
    ['a payload that is an array', sign(encode([1, 2, 3]))],
    [
      'a payload of another version',
      sign(encode({ v: 2, sub: UID, scope: H5P_URL_TOKEN_SCOPE, exp: NOW + 1 })),
    ],
    ['a payload with no subject', sign(encode({ v: 1, scope: H5P_URL_TOKEN_SCOPE, exp: NOW + 1 }))],
    [
      'a payload whose subject is empty',
      sign(encode({ v: 1, sub: '', scope: H5P_URL_TOKEN_SCOPE, exp: NOW + 1 })),
    ],
    [
      'a payload whose expiry is a string',
      sign(encode({ v: 1, sub: UID, scope: H5P_URL_TOKEN_SCOPE, exp: '1' })),
    ],
    [
      'a payload whose expiry is not a number at all',
      sign(encode({ v: 1, sub: UID, scope: H5P_URL_TOKEN_SCOPE, exp: Number.NaN })),
    ],
  ])('refuses %s as malformed rather than throwing', (_shape, token) => {
    // A codec that threw inside a guard would answer a value the caller typed
    // with a 500. Each of these carries a *correct* signature, so verification
    // really does reach the parse.
    expect(() => verifyH5pUrlToken(SECRET, token, NOW)).not.toThrow();
    expect(reasonOf(verifyH5pUrlToken(SECRET, token, NOW))).toBe('malformed');
  });

  it('is safe in both a query parameter and a path segment', () => {
    // The same string has to survive `?token=<t>` and `…/temp/<t>/images/x.png`,
    // which `+`, `/` and `=` do not.
    const token = signH5pUrlToken(SECRET, UID, NOW + 60_000);

    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(token)).toBe(token);
  });
});
