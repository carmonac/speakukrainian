import type { Environment } from './environment.model';

export type { Environment };

export const environment: Environment = {
  production: false,
  apiBaseUrl: 'http://localhost:8080/api',
  serverApiBaseUrl: 'http://localhost:8080/api',
  siteUrl: 'http://localhost:4300',
};
