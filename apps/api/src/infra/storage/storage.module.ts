import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Storage } from '@google-cloud/storage';
import type { Env } from '../../config/configuration.js';
import { StorageService } from './storage.service.js';
import { CLOUD_STORAGE } from './storage.tokens.js';

/**
 * Provides the Cloud Storage client. Locally `STORAGE_API_ENDPOINT` points it
 * at the `fake-gcs-server` container; in Cloud Run it is unset and the client
 * uses the real service with the runtime service account.
 */
@Global()
@Module({
  providers: [
    {
      provide: CLOUD_STORAGE,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        const apiEndpoint = config.get('STORAGE_API_ENDPOINT', { infer: true });
        return new Storage({
          projectId: config.get('GOOGLE_CLOUD_PROJECT', { infer: true }),
          ...(apiEndpoint ? { apiEndpoint, useAuthWithCustomEndpoint: false } : {}),
        });
      },
    },
    StorageService,
  ],
  exports: [CLOUD_STORAGE, StorageService],
})
export class StorageModule {}
