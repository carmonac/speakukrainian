import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';
import type { Env } from '../config/configuration.js';
import { FIREBASE_AUTH } from './auth.tokens.js';
import { FirebaseAuthGuard } from './firebase-auth.guard.js';
import { RolesGuard } from './roles.guard.js';

@Global()
@Module({
  providers: [
    {
      provide: FIREBASE_AUTH,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): Auth => {
        const projectId = config.get('GOOGLE_CLOUD_PROJECT', { infer: true });
        const app =
          getApps()[0] ??
          initializeApp({
            projectId,
            // Cloud Run supplies the service account; locally the Auth emulator
            // accepts any credential.
            ...(process.env['FIREBASE_AUTH_EMULATOR_HOST']
              ? {}
              : { credential: applicationDefault() }),
          });
        return getAuth(app);
      },
    },
    FirebaseAuthGuard,
    RolesGuard,
  ],
  exports: [FIREBASE_AUTH, FirebaseAuthGuard, RolesGuard],
})
export class AuthModule {}
