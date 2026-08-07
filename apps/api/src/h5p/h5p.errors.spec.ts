import { HttpException, InternalServerErrorException } from '@nestjs/common';
import { AggregateH5pError, H5pError } from '@lumieducation/h5p-server';
import { describe, expect, it } from 'vitest';
import { toHttpException } from './h5p.errors.js';

function bodyOf(exception: HttpException): Record<string, unknown> {
  const payload = exception.getResponse();
  return typeof payload === 'string' ? { message: payload } : (payload as Record<string, unknown>);
}

describe('toHttpException', () => {
  it('turns a corrupt archive into a 400 that names the archive', () => {
    const exception = toHttpException(new H5pError('unable-to-unzip', {}, 400));

    expect(exception).toBeInstanceOf(HttpException);
    expect(exception?.getStatus()).toBe(400);
    expect(bodyOf(exception!)['message']).toBe(
      'The file is not a readable ZIP archive, so it is not an H5P package.',
    );
  });

  it('lists every rule an aggregate validation failure collected', () => {
    // Without this the admin is told only "validation failed" and has nothing
    // to act on.
    const aggregate = new AggregateH5pError('package-validation-failed', {}, 400, '');
    aggregate.addError(new H5pError('invalid-h5p-json-file'));
    aggregate.addError(new H5pError('not-in-whitelist', { filename: 'evil.exe' }));

    const exception = toHttpException(aggregate);

    expect(exception?.getStatus()).toBe(400);
    expect(bodyOf(exception!)['message']).toBe('The package is not a valid H5P package.');
    expect(bodyOf(exception!)['errors']).toEqual([
      'invalid-h5p-json-file',
      'not-in-whitelist (filename: evil.exe)',
    ]);
  });

  it('omits the errors field when an aggregate collected none', () => {
    const aggregate = new AggregateH5pError('package-validation-failed', {}, 400, '');

    expect(bodyOf(toHttpException(aggregate)!)['errors']).toBeUndefined();
  });

  it('names the id for a 4xx it has no wording for, rather than saying nothing', () => {
    const exception = toHttpException(new H5pError('some-future-error-id', {}, 403));

    expect(exception?.getStatus()).toBe(403);
    expect(bodyOf(exception!)['message']).toBe(
      'The uploaded file could not be imported as an H5P package (some-future-error-id).',
    );
  });

  it('answers a 5xx H5pError generically and keeps the debug message out of the body', () => {
    // `H5pError.message` embeds `debugMessage`, which is where the library puts
    // extraction paths and other server internals.
    const exception = toHttpException(
      new H5pError(
        'server:install-library-lock-timeout',
        { ubername: 'H5P.Foo-1.0' },
        500,
        '/tmp/tmp-9182/SpeakTest.Main-1.0 is locked',
      ),
    );

    expect(exception).toBeInstanceOf(InternalServerErrorException);
    expect(exception?.getStatus()).toBe(500);
    expect(JSON.stringify(bodyOf(exception!))).not.toContain('/tmp/');
    expect(bodyOf(exception!)['message']).toBe(
      'The H5P package could not be imported because of a server error.',
    );
  });

  it.each([
    ['Relative path: content/../../pwned.txt'],
    ['Absolute path: /etc/pwned.txt'],
    ['Invalid characters in filename: content\\..\\pwned.txt'],
  ])('turns a filename rejection from the zip reader (%j) into a 400', (message) => {
    // These are plain `Error`s thrown from inside `yauzl-promise` while it reads
    // the central directory. `assertSafePackageEntries` refuses such names
    // first, so this is the backstop for one it let through — and an unhandled
    // 500 for a file problem is what it exists to prevent.
    const exception = toHttpException(new Error(message));

    expect(exception?.getStatus()).toBe(400);
    expect(bodyOf(exception!)['message']).toBe(
      'The package contains a file with an unusable path.',
    );
  });

  it('keeps the rejected entry name out of the response body', () => {
    const exception = toHttpException(new Error('Relative path: content/../../pwned.txt'));

    expect(JSON.stringify(bodyOf(exception!))).not.toContain('pwned');
  });

  it('returns null for anything that is not an H5pError', () => {
    // A storage outage must not be reported to the admin as a corrupt file.
    expect(toHttpException(new Error('ECONNRESET'))).toBeNull();
    // Close enough to read like one of yauzl's, and still a server fault.
    expect(toHttpException(new Error('Absolute paths are unsupported by this bucket'))).toBeNull();
    expect(toHttpException('boom')).toBeNull();
    expect(toHttpException(undefined)).toBeNull();
  });
});
