import { HttpException, HttpStatus, InternalServerErrorException, Logger } from '@nestjs/common';
import { AggregateH5pError, H5pError } from '@lumieducation/h5p-server';

const logger = new Logger('H5pErrors');

/**
 * What the caller is told for each error the import path can actually produce.
 * Read out of the installed library's own sources, not guessed: everything else
 * falls through to a message that at least names the id.
 */
const UNUSABLE_PATH = 'The package contains a file with an unusable path.';

const MESSAGES: Record<string, string> = {
  'unable-to-unzip': 'The file is not a readable ZIP archive, so it is not an H5P package.',
  'package-validation-failed': 'The package is not a valid H5P package.',
  'unable-to-parse-package': 'The package contains a JSON file that could not be parsed.',
  'install-missing-libraries':
    'The package needs libraries that are neither installed nor included in it.',
  'import-package-no-id-assigned': 'The package was read but no content could be created from it.',
  'storage-file-implementations:illegal-relative-filename': UNUSABLE_PATH,
  'storage-file-implementations:illegal-absolute-filename': UNUSABLE_PATH,
  'storage-file-implementations:illegal-character': UNUSABLE_PATH,
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
 * Maps an `H5pError` onto an HTTP response, or returns `null` for anything
 * else.
 *
 * The `null` is the point of the function. A storage outage, a bug in an
 * adapter or a broken Firestore connection is not an `H5pError`, so it is
 * rethrown, logged by the global filter and answered as a 500 — rather than
 * being reported to the admin as "your file is corrupt", which would send them
 * looking for a problem in a file that is fine.
 */
export function toHttpException(error: unknown): HttpException | null {
  if (!(error instanceof H5pError)) {
    return unusablePathException(error);
  }

  const status = error.httpStatusCode;
  if (status < HttpStatus.BAD_REQUEST || status >= HttpStatus.INTERNAL_SERVER_ERROR) {
    // `error.message` carries `debugMessage` and can name a server path, so it
    // is logged and never returned.
    logger.error(`H5P import failed: ${error.message}`);
    return new InternalServerErrorException(
      'The H5P package could not be imported because of a server error.',
    );
  }

  const message =
    MESSAGES[error.errorId] ??
    `The uploaded file could not be imported as an H5P package (${error.errorId}).`;

  // An aggregate knows *which* rules failed. Without forwarding them the admin
  // is told only that validation failed, which is not actionable.
  const errors =
    error instanceof AggregateH5pError ? error.getErrors().map(describeH5pError) : undefined;

  return new HttpException(
    { statusCode: status, message, ...(errors?.length ? { errors } : {}) },
    status,
  );
}

function unusablePathException(error: unknown): HttpException | null {
  if (!(error instanceof Error)) {
    return null;
  }
  if (!YAUZL_FILENAME_ERRORS.some((prefix) => error.message.startsWith(prefix))) {
    return null;
  }

  // The message names the offending entry, which came from the uploaded file
  // and not from this server, but it is logged rather than returned: the client
  // is told the rule, in the same words a rejected path already gets.
  logger.warn(`A package entry name was rejected by the zip reader: ${error.message}`);
  return new HttpException(
    { statusCode: HttpStatus.BAD_REQUEST, message: UNUSABLE_PATH },
    HttpStatus.BAD_REQUEST,
  );
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
