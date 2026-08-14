import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The one purpose a URL token may be minted and accepted for.
 *
 * It is in the signed payload so that a token minted with the same secret for
 * some future purpose cannot be replayed on these routes. There is exactly one
 * value today, and {@link verifyH5pUrlToken} always compares against it.
 */
export const H5P_URL_TOKEN_SCOPE = 'h5p-editor';

/** The query parameter `UrlGenerator`'s csrf hook writes the token into. */
export const H5P_URL_TOKEN_QUERY = 'token';

/** The route parameter the temporary-file preview route carries the token in. */
export const H5P_URL_TOKEN_PARAM = 'token';

/** The payload version, so a future format change is a refusal and not a misread. */
const TOKEN_VERSION = 1;

/**
 * A token that verified but whose editing session has run out.
 *
 * Distinguishable from the other two on purpose: the widget reads `ajaxPath`
 * and `filesPath` once, when it mounts, and cannot refresh them — so after the
 * lifetime elapses a still-open editor stops fetching, and the only thing that
 * repairs it is reloading the screen. Saving is unaffected, because it goes
 * over `HttpClient` with a bearer token.
 */
export const H5P_URL_TOKEN_EXPIRED_MESSAGE =
  'That editing session has expired. Reload the exercise editor to continue.';

/** A token that is malformed, carries a bad signature, or names another purpose. */
export const H5P_URL_TOKEN_INVALID_MESSAGE = 'That editing link is not valid.';

/** A token that verified, for a Firebase account that is gone or disabled. */
export const H5P_URL_TOKEN_UNKNOWN_USER_MESSAGE =
  'That editing link belongs to an account that can no longer sign in.';

/**
 * Why a token was refused.
 *
 * A result rather than a throw because the caller maps three outcomes onto
 * three different messages; a thrown error would have to carry the same
 * discriminant and would also make a malformed value a stack trace.
 */
export type H5pUrlTokenResult =
  | { ok: true; uid: string }
  | { ok: false; reason: 'malformed' | 'signature' | 'scope' | 'expired' };

interface H5pUrlTokenPayload {
  v: number;
  sub: string;
  scope: string;
  exp: number;
}

/**
 * A signed, self-describing credential naming *who* is asking, for how long.
 *
 * **It carries no role, deliberately.** The guard that accepts it resolves the
 * caller's current claims from Firebase and `@Roles('editor')` then decides, so
 * a token minted before a demotion stops working the moment the demotion lands.
 * A role in the payload would make the token a grant with a staleness window of
 * its whole lifetime.
 *
 * **Signed rather than looked up, and that is forced rather than chosen.**
 * `UrlGenerator`'s `csrfProtection.queryParamGenerator` is synchronous, so the
 * mint site cannot do I/O — a stored token would need an async write there.
 *
 * `base64url` on both halves because the same string has to survive a query
 * parameter *and* a path segment, which `+`, `/` and `=` do not.
 */
export function signH5pUrlToken(secret: string, uid: string, expiresAt: number): string {
  const payload: H5pUrlTokenPayload = {
    v: TOKEN_VERSION,
    sub: uid,
    scope: H5P_URL_TOKEN_SCOPE,
    exp: expiresAt,
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

  return `${encoded}.${signatureOf(secret, encoded)}`;
}

/**
 * The uid a token names, or why it was refused.
 *
 * **The order is load-bearing.** The signature is recomputed over the encoded
 * payload and compared before the payload is parsed at all: parsing first would
 * hand an attacker's bytes to `JSON.parse` on an unauthenticated route, and
 * would make the time this function takes depend on payload content.
 *
 * `exp` is compared with `>`, so a token whose expiry is exactly now has
 * expired.
 */
export function verifyH5pUrlToken(secret: string, token: string, now: number): H5pUrlTokenResult {
  const parts = token.split('.');
  if (parts.length !== 2) {
    return { ok: false, reason: 'malformed' };
  }

  const [encoded, signature] = parts as [string, string];
  if (!matches(signatureOf(secret, encoded), signature)) {
    return { ok: false, reason: 'signature' };
  }

  const payload = parsePayload(encoded);
  if (!payload) {
    return { ok: false, reason: 'malformed' };
  }
  if (payload.scope !== H5P_URL_TOKEN_SCOPE) {
    // A different diagnosis from a bad signature, and only one of the two means
    // somebody is trying things: this one is a token we minted, for elsewhere.
    return { ok: false, reason: 'scope' };
  }
  if (!(payload.exp > now)) {
    return { ok: false, reason: 'expired' };
  }

  return { ok: true, uid: payload.sub };
}

function signatureOf(secret: string, encodedPayload: string): string {
  return createHmac('sha256', secret).update(encodedPayload).digest('base64url');
}

/** Constant-time once the lengths agree; `timingSafeEqual` throws when they do not. */
function matches(expected: string, actual: string): boolean {
  const expectedBytes = Buffer.from(expected, 'utf8');
  const actualBytes = Buffer.from(actual, 'utf8');

  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

/**
 * The payload of a token whose signature has already been verified.
 *
 * Every shape failure is `undefined` and never a throw: this runs inside a
 * guard, so a codec that threw would answer a value a caller typed with a 500.
 */
function parsePayload(encoded: string): H5pUrlTokenPayload | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }

  const { v, sub, scope, exp } = parsed as Record<string, unknown>;
  if (v !== TOKEN_VERSION) {
    return undefined;
  }
  if (typeof sub !== 'string' || sub === '') {
    return undefined;
  }
  if (typeof scope !== 'string' || typeof exp !== 'number' || !Number.isFinite(exp)) {
    return undefined;
  }

  return { v, sub, scope, exp };
}
