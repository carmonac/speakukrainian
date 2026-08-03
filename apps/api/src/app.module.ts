import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { envSchema } from './config/configuration.js';
import { FirestoreModule } from './infra/firestore/firestore.module.js';
import { StorageModule } from './infra/storage/storage.module.js';
import { AuthModule } from './auth/auth.module.js';
import { FirebaseAuthGuard } from './auth/firebase-auth.guard.js';
import { RolesGuard } from './auth/roles.guard.js';
import { HttpExceptionFilter } from './common/http-exception.filter.js';
import { HealthController } from './health/health.controller.js';

/**
 * Root module. Feature modules (locales, sections, pages, schedule, h5p, media)
 * are added here as they land — see the GitHub milestones for the order.
 *
 * Authentication is global-by-default: every route requires a valid Firebase
 * token unless it is explicitly marked `@Public()`.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: (raw) => envSchema.parse(raw),
    }),
    FirestoreModule,
    StorageModule,
    AuthModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
    { provide: APP_GUARD, useClass: FirebaseAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
