import { HttpException, HttpStatus, InternalServerErrorException, Logger } from '@nestjs/common';
import { AggregateH5pError, H5pError } from '@lumieducation/h5p-server';
import { formatMaxH5pUploadSize } from '@speakukrainian/shared';

const logger = new Logger('H5pErrors');

/**
 * What the caller is told for each error the import and serving paths can
 * actually produce. Read out of the installed library's own sources, not
 * guessed: everything else falls through to a message that at least names the
 * id.
 */
const UNUSABLE_PATH = 'The package contains a file with an unusable path.';
const UNREADABLE_ARCHIVE = 'The file is not a readable ZIP archive, so it is not an H5P package.';
const INVALID_LIBRARY_NAME = 'That is not a valid H5P library name.';
const LIBRARY_NOT_INSTALLED = 'That library is not installed on this server.';

/**
 * One sentence for one fact, said by both halves of the API: the player raises
 * it as an `H5pError`, the admin routes as a `NotFoundException`. Exported so
 * the two cannot drift into two wordings for the same missing exercise.
 */
export const CONTENT_MISSING_MESSAGE = 'That exercise does not exist.';

const MESSAGES: Record<string, string> = {
  'unable-to-unzip': UNREADABLE_ARCHIVE,
  'package-validation-failed': 'The package is not a valid H5P package.',
  'unable-to-parse-package': 'The package contains a JSON file that could not be parsed.',
  'install-missing-libraries':
    'The package needs libraries that are neither installed nor included in it.',
  'import-package-no-id-assigned': 'The package was read but no content could be created from it.',
  'storage-file-implementations:illegal-relative-filename': UNUSABLE_PATH,
  'storage-file-implementations:illegal-absolute-filename': UNUSABLE_PATH,
  'storage-file-implementations:illegal-character': UNUSABLE_PATH,
  // The two ids `h5p.package-scan.ts` raises for a package that is malformed
  // rather than hostile. Both name a rule the uploader can act on, which is the
  // whole reason they are refused up front instead of surfacing as the plain
  // `Error` the library raises mid-import.
  'package-scan:filename-too-long': 'The package contains a file whose name is too long to unpack.',
  'package-scan:not-a-library-folder':
    'Every folder in the package other than "content" must be a library folder containing a library.json.',
  'package-scan:encrypted-entry':
    'The package is password-protected. Upload it again without encryption.',
  'package-scan:unsupported-compression':
    'The package uses a ZIP compression method that cannot be read. Save it again with standard deflate compression.',
  'package-scan:unpacks-too-large': `The package unpacks to more than ${formatMaxH5pUploadSize()}.`,
  // The serving routes. Each of these carries its own HTTP status on the
  // `H5pError`, so what is chosen here is only the wording — and the wording
  // matters, because without it a reader asking for a missing image is told
  // their file could not be imported as an H5P package.
  'h5p-player:content-missing': CONTENT_MISSING_MESSAGE,
  // The same path rule as the three ids above, raised by
  // `assertSafeRequestPath` for a path that arrived in a URL rather than in a
  // package. One rule, two sentences, because "the package contains…" is a
  // statement about something a reader never sent.
  'h5p-request:unusable-path': 'That path is not valid.',
  'content-file-missing': 'That file is not part of this exercise.',
  'library-file-missing': 'That file is not part of this library.',
  'invalid-ubername-pattern': INVALID_LIBRARY_NAME,
  // The editor's ajax surface. `malformed-request` is the library's own refusal
  // of a body or a query it cannot use, and every branch of `postAjax` that
  // raises it names the missing property in `replacements` — which is debugging
  // detail about the H5P client, not something an author can act on, so the
  // sentence stays about the request as a whole.
  'malformed-request': 'The editor sent a request this server could not understand.',
  'h5p-request:unsupported-ajax-action': 'That editor action is not available on this server.',
  // Reachable only if a future auth provider issues subjects that are not
  // path-safe atoms; the uid becomes a path segment under `h5p/temp/`.
  'h5p-request:unusable-owner': 'This account cannot store uploaded files on this server.',
  'storage-file-implementations:temporary-file-not-found':
    'That file is not in temporary storage. It may have expired.',
  'invalid-main-library-name': INVALID_LIBRARY_NAME,
  'not-in-whitelist': 'That kind of file cannot be uploaded into an exercise.',
  'upload-validation-error': 'That file could not be read as the kind of media the field expects.',
  'missing-h5p-extension': 'Upload a file with the .h5p extension.',
  'library-not-found': LIBRARY_NOT_INSTALLED,
  'library-missing': LIBRARY_NOT_INSTALLED,
  // Raised by `rangeCallbackFor`, from inside the endpoint's own call stack.
  'h5p-range:unsatisfiable': 'The requested byte range is outside this file.',
  'h5p-range:malformed': 'The Range header could not be understood.',
  'h5p-range:multipart': 'Only a single byte range can be served.',
};

/**
 * How `yauzl-promise` rejects an entry name: a plain `Error` from an assertion,
 * with no code and no class to match on.
 *
 * `assertSafePackageEntries` refuses every name that could produce one of these
 * before the importer opens the package, so reaching this list means yauzl's
 * reader rejected a name our scan accepted — an encoding difference, or a
 * future yauzl validating something new. It is still the uploaded file's
 * problem and not the server's, so it answers 4xx rather than escaping as an
 * unhandled 500. Deliberately narrow: every other plain `Error` still returns
 * `null` and stays a 500.
 */
const YAUZL_FILENAME_ERRORS = [
  'Invalid characters in filename: ',
  'Absolute path: ',
  'Relative path: ',
];

/**
 * How `yauzl-promise` rejects an entry's *data* once it starts reading it: the
 * same shape, a plain `Error` from an assertion or from a validating stream.
 *
 * `assertSafePackageEntries` reads every entry the importer would, so a package
 * that produces one of these is refused before the importer opens it — the
 * same relationship the list above has with the scan's name rules. This stays
 * as the backstop for a read that only fails the second time, and because
 * without it such a failure is not merely a 500 but a request that never
 * answers at all.
 *
 * Patterns rather than prefixes because two of the messages are complete as
 * written: an unanchored `Unexpected end of file` would also swallow a storage
 * read that failed with those words, which is a server fault and must stay a
 * 500.
 *
 * Yauzl's own wording only, and deliberately not zlib's. A deflate stream that
 * will not inflate fails with `invalid code lengths set` and its siblings,
 * which are not here: those same words come out of any inflating stream in the
 * request path — a gzip-encoded storage response included — where they are a
 * server fault. So a data failure of that shape, were the scan ever to miss
 * one, would answer 500 rather than 400.
 */
const YAUZL_DATA_ERRORS = [
  /^CRC32 validation failed\. /,
  /^File data overflows file bounds: /,
  /^Not enough bytes in the stream\. /,
  /^Too many bytes in the stream\. /,
  /^Invalid Local File Header signature$/,
  /^Unexpected end of file$/,
];

/**
 * Ids the library raises with its own default status of 500 although they say
 * nothing about this server.
 *
 * `H5PEditor.saveContentFile` writes `new H5pError('not-in-whitelist', {…})`
 * with no status argument, and `H5pError`'s constructor defaults to 500 — so an
 * author dropping a `.exe` into an exercise field is told the server broke,
 * which hides both the rule and the fix. A list of exactly one id rather than a
 * heuristic: every other 500 the library raises stays a 500, because the
 * judgement about who is at fault is per id and not per shape.
 */
const CLIENT_FAULT_IDS = new Set(['not-in-whitelist']);

/**
 * Maps an error from the H5P library onto an HTTP response, or returns `null`
 * when it is not one this API can attribute to the request.
 *
 * An `H5pError` carries its own status and is mapped straight through. A plain
 * `Error` is mapped only when it matches one of the two narrow zip-reader
 * families above; everything else returns `null`.
 *
 * That `null` is the point of the function. A storage outage, a bug in an
 * adapter or a broken Firestore connection is not the caller's file being
 * wrong, so it is rethrown, logged by the global filter and answered as a 500 —
 * rather than being reported to the admin as "your file is corrupt", which
 * would send them looking for a problem in a file that is fine.
 */
export function toHttpException(error: unknown): HttpException | null {
  if (!(error instanceof H5pError)) {
    return unreadableArchiveException(error);
  }

  const status = CLIENT_FAULT_IDS.has(error.errorId)
    ? HttpStatus.BAD_REQUEST
    : error.httpStatusCode;
  if (status < HttpStatus.BAD_REQUEST || status >= HttpStatus.INTERNAL_SERVER_ERROR) {
    // `error.message` carries `debugMessage` and can name a server path, so it
    // is logged and never returned.
    //
    // Kept even though `HttpExceptionFilter` now logs every 5xx `HttpException`
    // as well: what it is handed is the sanitized exception built below, whose
    // message is the generic sentence and whose stack starts here, so this is
    // the only line that names the cause. Two lines at the same level,
    // correlated by the URL.
    logger.error(`An H5P request failed: ${error.message}`);
    return new InternalServerErrorException(
      'The H5P request could not be completed because of a server error.',
    );
  }

  // Deliberately neutral about which route raised it: the same mapper now
  // serves the import path and the read paths, and a reader who asked for a
  // missing exercise must not be told their upload failed.
  const message =
    MESSAGES[error.errorId] ?? `The H5P request could not be completed (${error.errorId}).`;

  // An aggregate knows *which* rules failed. Without forwarding them the admin
  // is told only that validation failed, which is not actionable.
  const errors =
    error instanceof AggregateH5pError ? error.getErrors().map(describeH5pError) : undefined;

  return new HttpException(
    { statusCode: status, message, ...(errors?.length ? { errors } : {}) },
    status,
  );
}

/**
 * Runs an operation that calls into the H5P library, with its errors already
 * mapped onto HTTP: what `toHttpException` can attribute to the request is
 * thrown as an `HttpException`, and everything else is rethrown untouched so it
 * stays a 500.
 *
 * It lives here beside `toHttpException` rather than as a private helper on a
 * service because every service that drives the library needs exactly this
 * decision — the player's read paths, the editor's ajax surface and the save
 * path to come — and the same four lines restated once per service is four
 * places for "which errors are the caller's fault" to drift apart.
 */
export async function mapH5pErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const http = toHttpException(error);
    if (http) {
      throw http;
    }
    throw error;
  }
}

/** The backstop for the two families of plain `Error` the zip reader raises. */
function unreadableArchiveException(error: unknown): HttpException | null {
  if (!(error instanceof Error)) {
    return null;
  }

  // Both messages name the offending entry, which came from the uploaded file
  // and not from this server, but they are logged rather than returned: the
  // client is told the rule, in the same words the same problem already gets
  // when it is caught earlier.
  if (YAUZL_FILENAME_ERRORS.some((prefix) => error.message.startsWith(prefix))) {
    logger.warn(`A package entry name was rejected by the zip reader: ${error.message}`);
    return badRequest(UNUSABLE_PATH);
  }
  if (YAUZL_DATA_ERRORS.some((pattern) => pattern.test(error.message))) {
    logger.warn(`A package entry could not be read: ${error.message}`);
    return badRequest(UNREADABLE_ARCHIVE);
  }

  return null;
}

function badRequest(message: string): HttpException {
  return new HttpException({ statusCode: HttpStatus.BAD_REQUEST, message }, HttpStatus.BAD_REQUEST);
}

/**
 * The error id and its replacements, deliberately without `debugMessage` —
 * that is the field the library fills with internal detail such as extraction
 * paths.
 */
function describeH5pError(error: H5pError): string {
  const replacements = Object.entries(error.replacements)
    .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
    .join(', ');

  return replacements ? `${error.errorId} (${replacements})` : error.errorId;
}
