import { HttpException, InternalServerErrorException } from '@nestjs/common';
import { AggregateH5pError, H5pError } from '@lumieducation/h5p-server';
import { describe, expect, it } from 'vitest';
import { mapH5pErrors, toHttpException } from './h5p.errors.js';

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

  it.each([
    [
      'package-scan:filename-too-long',
      'The package contains a file whose name is too long to unpack.',
    ],
    [
      'package-scan:not-a-library-folder',
      'Every folder in the package other than "content" must be a library folder containing a library.json.',
    ],
    [
      'package-scan:encrypted-entry',
      'The package is password-protected. Upload it again without encryption.',
    ],
    [
      'package-scan:unsupported-compression',
      'The package uses a ZIP compression method that cannot be read. Save it again with standard deflate compression.',
    ],
    ['package-scan:unpacks-too-large', 'The package unpacks to more than 100 MB.'],
  ])('words %s as a rule the uploader can act on', (errorId, message) => {
    // Without wording of its own each of these falls through to the generic
    // "could not be imported (<id>)", which names an id nobody outside this
    // repo has ever seen.
    const exception = toHttpException(new H5pError(errorId, { filename: 'x' }, 400));

    expect(exception?.getStatus()).toBe(400);
    expect(bodyOf(exception!)['message']).toBe(message);
  });

  it.each([
    ['h5p-player:content-missing', 404, 'That exercise does not exist.'],
    ['content-file-missing', 404, 'That file is not part of this exercise.'],
    ['library-file-missing', 404, 'That file is not part of this library.'],
    ['invalid-ubername-pattern', 400, 'That is not a valid H5P library name.'],
    ['h5p-request:unusable-path', 400, 'That path is not valid.'],
  ] as const)('words %s for a reader rather than for an uploader', (errorId, status, message) => {
    // The same mapper serves the play and asset routes. Without wording of
    // their own these fall through to a sentence about importing a package,
    // which is not what the caller did.
    const exception = toHttpException(new H5pError(errorId, { name: 'x' }, status));

    expect(exception?.getStatus()).toBe(status);
    expect(bodyOf(exception!)['message']).toBe(message);
    expect(bodyOf(exception!)['message']).not.toContain('package');
  });

  it.each([
    ['malformed-request', 400, 'The editor sent a request this server could not understand.'],
    [
      'h5p-request:unsupported-ajax-action',
      400,
      'That editor action is not available on this server.',
    ],
    ['h5p-request:unusable-owner', 400, 'This account cannot store uploaded files on this server.'],
    [
      'storage-file-implementations:temporary-file-not-found',
      404,
      'That file is not in temporary storage. It may have expired.',
    ],
    ['invalid-main-library-name', 400, 'That is not a valid H5P library name.'],
    [
      'upload-validation-error',
      400,
      'That file could not be read as the kind of media the field expects.',
    ],
    ['missing-h5p-extension', 400, 'Upload a file with the .h5p extension.'],
    ['library-not-found', 404, 'That library is not installed on this server.'],
    ['library-missing', 404, 'That library is not installed on this server.'],
  ] as const)('words %s for an author using the editor', (errorId, status, message) => {
    // Every one of these is reachable from `GET`/`POST /api/h5p/ajax`. Without
    // wording of its own each falls through to the generic sentence naming an
    // id nobody outside this repo has seen.
    const exception = toHttpException(new H5pError(errorId, { name: 'x' }, status));

    expect(exception?.getStatus()).toBe(status);
    expect(bodyOf(exception!)['message']).toBe(message);
    expect(bodyOf(exception!)['message']).not.toContain('package');
  });

  it('reports a file type the editor may not upload as the author’s mistake, not a 500', () => {
    // `H5PEditor.saveContentFile` raises this with no status argument, so
    // `H5pError` defaults it to 500. Reported that way the author is told the
    // server broke, and neither the rule nor the fix is anywhere in the answer.
    const exception = toHttpException(
      new H5pError('not-in-whitelist', { filename: 'evil.exe', 'files-allowed': 'png mp3' }),
    );

    expect(exception?.getStatus()).toBe(400);
    expect(bodyOf(exception!)['message']).toBe(
      'That kind of file cannot be uploaded into an exercise.',
    );
  });

  it('leaves every other 500 from the library a 500', () => {
    // The override above is a list of one id on purpose. A library install that
    // timed out is this server's problem and must not become a 400 because it
    // arrived through the same mapper.
    expect(toHttpException(new H5pError('upload-package-failed-tmp', {}, 500))?.getStatus()).toBe(
      500,
    );
  });

  it('names the id for a 4xx it has no wording for, rather than saying nothing', () => {
    const exception = toHttpException(new H5pError('some-future-error-id', {}, 403));

    expect(exception?.getStatus()).toBe(403);
    expect(bodyOf(exception!)['message']).toBe(
      'The H5P request could not be completed (some-future-error-id).',
    );
    // It must not claim the caller uploaded anything: this mapper is now on the
    // read paths too.
    expect(bodyOf(exception!)['message']).not.toContain('uploaded');
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
      'The H5P request could not be completed because of a server error.',
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

  it.each([
    ['CRC32 validation failed. Expected 958480011, received 3978791044.'],
    ['File data overflows file bounds: 4096 + 512 > 4210'],
    ['Invalid Local File Header signature'],
    ['Unexpected end of file'],
  ])('turns a data rejection from the zip reader (%j) into a 400', (message) => {
    // These come out of `entry.openReadStream()` and the streams it returns,
    // from inside `PackageImporter.extractPackage` — long after the scan has
    // finished, because a checksum and a truncation are facts about the bytes
    // rather than about the central directory. A one-bit corruption of a real
    // package is what acceptance criterion 4 calls a corrupt archive, and it
    // used to answer 500.
    const exception = toHttpException(new Error(message));

    expect(exception?.getStatus()).toBe(400);
    expect(bodyOf(exception!)['message']).toBe(
      'The file is not a readable ZIP archive, so it is not an H5P package.',
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
    // Yauzl's own message is exactly `Unexpected end of file`, which is why
    // that one is matched whole: a bucket read that ended early is ours.
    expect(
      toHttpException(new Error('Unexpected end of file reading the object from the bucket')),
    ).toBeNull();
    expect(toHttpException('boom')).toBeNull();
    expect(toHttpException(undefined)).toBeNull();
  });
});

describe('mapH5pErrors', () => {
  it('returns what the operation resolved with when nothing failed', async () => {
    await expect(mapH5pErrors(async () => 'the model')).resolves.toBe('the model');
  });

  it('turns an error about the request into its HTTP answer', async () => {
    const failing = mapH5pErrors(async () => {
      throw new H5pError('h5p-player:content-missing', {}, 404);
    });

    await expect(failing).rejects.toMatchObject({
      status: 404,
      response: { message: 'That exercise does not exist.' },
    });
  });

  it('rethrows a server fault untouched, so it stays a 500', async () => {
    // The half that matters: a bucket that was unreachable must not reach the
    // caller as a sentence about their file.
    const outage = new Error('ECONNRESET');

    await expect(mapH5pErrors(async () => Promise.reject(outage))).rejects.toBe(outage);
  });
});
