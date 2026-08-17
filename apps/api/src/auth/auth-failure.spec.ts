import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AUTH_UNAVAILABLE_MESSAGE,
  authUnavailable,
  firebaseErrorCode,
  meansBadCredential,
  meansUnknownUser,
} from './auth-failure.js';

/** The shape `firebase-admin` rejects with: an `Error` carrying a `<prefix>/<code>`. */
const firebaseError = (code: string, message = 'boom'): Error =>
  Object.assign(new Error(message), { code });

/**
 * How the SDK really carries `code`: a getter on the prototype, so an
 * implementation reading own properties only would miss it entirely.
 */
class PrototypeCodeError extends Error {
  get code(): string {
    return 'auth/user-not-found';
  }
}

describe('firebaseErrorCode', () => {
  it('reads the code off a Firebase rejection', () => {
    expect(firebaseErrorCode(firebaseError('app/network-error'))).toBe('app/network-error');
  });

  it('reads a code that is a prototype getter rather than an own property', () => {
    expect(firebaseErrorCode(new PrototypeCodeError('boom'))).toBe('auth/user-not-found');
  });

  it('has nothing to report for a rejection the SDK did not diagnose', () => {
    expect(firebaseErrorCode(new Error('boom'))).toBeUndefined();
    expect(firebaseErrorCode('nope')).toBeUndefined();
    expect(firebaseErrorCode(undefined)).toBeUndefined();
    expect(firebaseErrorCode(Object.assign(new Error('boom'), { code: 503 }))).toBeUndefined();
  });
});

describe('meansUnknownUser', () => {
  it('is true for the one code that means the account is gone', () => {
    expect(meansUnknownUser(firebaseError('auth/user-not-found'))).toBe(true);
  });

  it.each([
    'app/network-error',
    'auth/internal-error',
    'auth/invalid-uid',
    'auth/insufficient-permission',
  ])('is false for %s, which says nothing about whether the account exists', (code) => {
    expect(meansUnknownUser(firebaseError(code))).toBe(false);
  });

  it('is false for a rejection with no code at all', () => {
    expect(meansUnknownUser(new Error('boom'))).toBe(false);
  });
});

describe('meansBadCredential', () => {
  it.each([
    'auth/id-token-expired',
    'auth/id-token-revoked',
    'auth/argument-error',
    'auth/user-disabled',
    'auth/user-not-found',
  ])('is true for %s, which is a fault in the token the caller sent', (code) => {
    expect(meansBadCredential(firebaseError(code))).toBe(true);
  });

  it.each([
    'app/network-error',
    'app/network-timeout',
    'app/unable-to-parse-response',
    'auth/internal-error',
    'auth/invalid-credential',
    'auth/insufficient-permission',
    'auth/invalid-uid',
  ])('is false for %s, which is this server failing to check', (code) => {
    expect(meansBadCredential(firebaseError(code))).toBe(false);
  });

  it('is false for a rejection the SDK did not diagnose', () => {
    expect(meansBadCredential(new Error('boom'))).toBe(false);
    expect(meansBadCredential('nope')).toBe(false);
  });
});

describe('authUnavailable', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('answers 503 with the sentence that says the check could not be made', () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const exception = authUnavailable('a bearer token', firebaseError('app/network-error'));

    expect(exception).toBeInstanceOf(ServiceUnavailableException);
    expect(exception.getStatus()).toBe(503);
    expect(exception.message).toBe(AUTH_UNAVAILABLE_MESSAGE);
  });

  it('records the credential path, the firebase code and the stack, exactly once', () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const cause = firebaseError('app/network-error');

    authUnavailable('a bearer token', cause);

    expect(error).toHaveBeenCalledTimes(1);
    const [line, stack] = error.mock.calls[0] as [string, string];
    expect(line).toContain('a bearer token');
    expect(line).toContain('firebase code: app/network-error');
    expect(line).toContain("this server's");
    expect(stack).toBe(cause.stack);
  });

  it('names no credential, so a later edit adding the request URL fails here', () => {
    // Every other assertion is `toContain` and so can only catch a removal. This
    // is the one that catches an *addition*: the URL-token routes carry the
    // token in `?token=` and in a path segment, and the bearer path has the
    // header, so a line built from `request.url` or from the header would show
    // up as one of these two fragments.
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    authUnavailable(
      'the account an H5P editor URL token names (uid uid-1)',
      firebaseError('app/network-error', 'GET /api/h5p/ajax?token=a-secret failed'),
    );

    const [line] = error.mock.calls[0] as [string, string];
    expect(line).not.toContain('token=');
    expect(line).not.toContain('Bearer');
  });

  it('still answers, and says so, when the rejection carries no code', () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const exception = authUnavailable('a bearer token', new Error('socket hang up'));

    expect(exception.getStatus()).toBe(503);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toContain('firebase code: none');
  });
});
