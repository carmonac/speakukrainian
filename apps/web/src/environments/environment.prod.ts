import type { Environment } from './environment.model';

export type { Environment };

/** Placeholders are substituted by the Cloud Build step before `ng build`. */
export const environment: Environment = {
  production: true,
  apiBaseUrl: '/api',
  serverApiBaseUrl: '__API_INTERNAL_URL__',
  siteUrl: '__PUBLIC_SITE_URL__',
};
