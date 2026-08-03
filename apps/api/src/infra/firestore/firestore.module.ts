import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Firestore } from '@google-cloud/firestore';
import type { Env } from '../../config/configuration.js';
import { FIRESTORE } from './firestore.tokens.js';

/**
 * Provides the single Firestore client for the process. When
 * `FIRESTORE_EMULATOR_HOST` is set the client talks to the local emulator from
 * docker compose and no credentials are needed.
 */
@Global()
@Module({
  providers: [
    {
      provide: FIRESTORE,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        const firestore = new Firestore({
          projectId: config.get('GOOGLE_CLOUD_PROJECT', { infer: true }),
          ignoreUndefinedProperties: true,
        });
        return firestore;
      },
    },
  ],
  exports: [FIRESTORE],
})
export class FirestoreModule {}
