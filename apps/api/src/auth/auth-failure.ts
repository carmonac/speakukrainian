import { Logger, ServiceUnavailableException } from '@nestjs/common';

const logger = new Logger('AuthFailure');

/**
 * The one `getUser` rejection that means the account really is gone.
 *
 * `auth.getUser` has exactly one caller-fault code, so the H5P URL-token guard
 * narrows on this single literal and treats everything else as ours.
 */
const USER_NOT_FOUND_CODE = 'auth/user-not-found';

/**
 * What a caller is told when this server could not check their credential at
 * all.
 *
 * Written to be true even though the admin will not display it: its interceptor
 * shows generic wording for every `>= 500`, so this sentence reaches devtools,
 * the API's own responses and Joubel's error UI inside the editor widget rather
 * than an author's screen. Do not reword it on the assumption someone reads it
 * in the admin.
 */
export const AUTH_UNAVAILABLE_MESSAGE =
  'Your sign-in could not be checked right now. Please try again in a moment.';

/**
 * The codes `verifyIdToken` raises about the caller's own token.
 *
 * Named rather than inferred, and narrowed from the opposite direction to
 * {@link USER_NOT_FOUND_CODE}: `verifyIdToken`'s caller-fault set is large and
 * open — `auth/argument-error` alone covers a bad signature, an unknown `kid`
 * and a JWT that is not a JWT — so treating everything unlisted as the caller's
 * would answer 503 to every forged token, turning any scanner into a fake
 * outage and burying a real one.
 *
 * `auth/user-not-found` belongs here too: `checkRevoked` resolves the account,
 * so a token issued before the account was deleted is a stale credential, which
 * is the caller's problem and not this server's.
 *
 * `auth/argument-error` is also what a failure to fetch Google's public signing
 * certificates arrives as, so a certificate-endpoint outage is answered 401 from
 * this list and is not distinguishable here. ADR-020 records why that residual
 * is named rather than fixed.
 *
 * Read out of `firebase-admin@13`'s own sources — `lib/utils/error.js` defines
 * the codes and `lib/auth/token-verifier.js` chooses between them — so a
 * dependency bump is what would invalidate this list. A renamed caller-fault
 * code widens the 503 branch, which is noisy but safe; the unit tests name every
 * code as a literal so the rename is visible rather than silent.
 */
const CALLER_FAULT_CODES: ReadonlySet<string> = new Set([
  'auth/id-token-expired',
  'auth/id-token-revoked',
  'auth/argument-error',
  'auth/user-disabled',
  USER_NOT_FOUND_CODE,
]);

/**
 * The `code` of a rejection the Firebase SDK diagnosed, or `undefined`.
 *
 * Structural rather than an `instanceof`, because there is nothing to test
 * against: `FirebaseAuthError` and its bases live in `lib/utils/error`, which is
 * not in `firebase-admin`'s `exports` map, and only the `FirebaseError`
 * *interface* is published. `code` is a getter on the prototype rather than an
 * own property, so this reads it the way the SDK's own `base-auth.js` does —
 * `error.code === 'auth/user-not-found'`. `http-exception.filter.ts` narrows
 * `expose`/`status` the same way.
 */
export function firebaseErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * True only for the rejection that means the account is gone.
 *
 * `auth/invalid-uid` deliberately does not count. It is unreachable through the
 * mint path — `verifyH5pUrlToken` already requires a non-empty string subject
 * and Firebase uids are at most 128 characters — and if it ever fires it is our
 * token and our bug, so a logged 5xx is how we would learn.
 */
export function meansUnknownUser(error: unknown): boolean {
  return firebaseErrorCode(error) === USER_NOT_FOUND_CODE;
}

/**
 * True for the codes `verifyIdToken` raises about the caller's own token.
 *
 * A rejection that is not an `Error`, or that carries no string `code`, is
 * ours: the SDK diagnoses what it understands, and an undiagnosed throw is not
 * a statement about the caller's credential.
 */
export function meansBadCredential(error: unknown): boolean {
  const code = firebaseErrorCode(error);
  return code !== undefined && CALLER_FAULT_CODES.has(code);
}

/**
 * Records an Auth failure this server caused, and returns what to answer with.
 * `subject` names what could not be checked, e.g. `a bearer token`.
 *
 * ADR-020 carries the argument — why a 503 rather than a 401, and why `error`
 * rather than `warn`. What is local to this function is what the line says:
 *
 * - It logs and **returns**, so a call site reads `throw authUnavailable(…)`.
 *   The same shape as `h5p.errors.ts`'s `toHttpException`, which also logs the
 *   cause and returns a sanitized exception for its two callers to throw; the
 *   refusal stays a `throw` at the guard, where the control flow is read.
 * - The Firebase `code` goes in the first argument because it is the one useful
 *   field the stack does not carry; the error's message does not, since V8
 *   renders a stack as `Name: message\n    at …`.
 * - **No URL**, for the plain reason that the filter's own line already carries
 *   it (ADR-017) and this line adds nothing by repeating it. Not a redaction
 *   measure: ADR-007 decided that a URL token appears unredacted in this
 *   server's request logs and in Cloud Run's, and that is where the
 *   credentials-in-logs question is settled.
 */
export function authUnavailable(subject: string, error: unknown): ServiceUnavailableException {
  logger.error(
    `Firebase Auth could not answer while checking ${subject}; the request was refused with 503. ` +
      `The failure is this server's, not the caller's (firebase code: ${firebaseErrorCode(error) ?? 'none'}).`,
    error instanceof Error ? error.stack : String(error),
  );

  return new ServiceUnavailableException(AUTH_UNAVAILABLE_MESSAGE);
}
