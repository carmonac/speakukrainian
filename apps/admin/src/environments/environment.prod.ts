import type { Environment } from './environment.model';

export type { Environment };

/**
 * Swapped in by the `production` file replacement in angular.json. The
 * placeholders are substituted by the Cloud Build step before `ng build`.
 */
export const environment: Environment = {
  production: true,
  apiBaseUrl: '/api',
  firebase: {
    apiKey: '__FIREBASE_API_KEY__',
    authDomain: '__FIREBASE_AUTH_DOMAIN__',
    projectId: '__FIREBASE_PROJECT_ID__',
  },
};
