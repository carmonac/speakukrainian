/**
 * Shape of the build-time environment. Kept in its own file because
 * `environment.ts` is swapped for `environment.prod.ts` at build time.
 */
export interface Environment {
  production: boolean;
  /** Base URL the browser uses to reach the API. */
  apiBaseUrl: string;
  /**
   * Base URL the SSR server uses. In Cloud Run this is the API's internal
   * address, which avoids a round trip back out through the public load
   * balancer on every render.
   */
  serverApiBaseUrl: string;
  siteUrl: string;
}
