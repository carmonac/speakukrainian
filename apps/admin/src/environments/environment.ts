import type { Environment } from './environment.model';

export type { Environment };

export const environment: Environment = {
  production: false,
  apiBaseUrl: 'http://localhost:8080/api',
  firebase: {
    apiKey: 'demo-api-key',
    authDomain: 'localhost',
    projectId: 'speakukrainian-local',
  },
  authEmulatorUrl: 'http://localhost:9099',
};
