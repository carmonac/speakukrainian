/**
 * Shape of the build-time environment. It lives in its own file because
 * `environment.ts` is swapped for `environment.prod.ts` at build time — if the
 * production file imported the type from the file it replaces, the import
 * would dangle.
 */
export interface Environment {
  production: boolean;
  apiBaseUrl: string;
  firebase: {
    apiKey: string;
    authDomain: string;
    projectId: string;
  };
  /** Set for local dev so the Firebase SDK talks to the Auth emulator. */
  authEmulatorUrl?: string;
}
