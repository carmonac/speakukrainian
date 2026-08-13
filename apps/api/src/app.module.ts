import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { envSchema } from './config/configuration.js';
import { CommonModule } from './common/common.module.js';
import { FirestoreModule } from './infra/firestore/firestore.module.js';
import { StorageModule } from './infra/storage/storage.module.js';
import { AuthModule } from './auth/auth.module.js';
import { UsersModule } from './users/users.module.js';
import { LocalesModule } from './locales/locales.module.js';
import { MediaModule } from './media/media.module.js';
import { SectionsModule } from './sections/sections.module.js';
import { PagesModule } from './pages/pages.module.js';
import { MenuModule } from './menu/menu.module.js';
import { ScheduleModule } from './schedule/schedule.module.js';
import { H5pModule } from './h5p/h5p.module.js';
import { H5pUrlTokenGuard } from './h5p/h5p-url-token.guard.js';
import { FirebaseAuthGuard } from './auth/firebase-auth.guard.js';
import { RolesGuard } from './auth/roles.guard.js';
import { HttpExceptionFilter } from './common/http-exception.filter.js';
import { HealthController } from './health/health.controller.js';

/**
 * Root module. Every feature module is registered here.
 *
 * Authentication is global-by-default: every route requires a valid Firebase
 * token unless it is explicitly marked `@Public()`, which remains the only way
 * out of it.
 *
 * `@H5pUrlToken()` is **not** a second way out. It changes how the caller of
 * three routes is *identified* — from a signed URL token, because Joubel's
 * editor client sends no `Authorization` header — and changes nothing about
 * whether a caller is required or about the `@Roles('editor')` those routes
 * carry.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: (raw) => envSchema.parse(raw),
    }),
    CommonModule,
    FirestoreModule,
    StorageModule,
    AuthModule,
    UsersModule,
    LocalesModule,
    MediaModule,
    SectionsModule,
    PagesModule,
    MenuModule,
    ScheduleModule,
    H5pModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
    // **The order of these three is load-bearing.** Nest applies global guards
    // in registration order. `H5pUrlTokenGuard` has to run before
    // `FirebaseAuthGuard`, because a request carrying a URL token and no bearer
    // header would otherwise already have been refused, and a later guard
    // cannot rescue one. It is a no-op for every route that does not carry
    // `@H5pUrlToken()`, which is every route here but three. `RolesGuard` runs
    // last and is unchanged: it still decides authorization from the caller's
    // current role, however that caller was identified.
    // `useExisting`, not `useClass`: the guard's own collaborators live in
    // `H5pModule`, and `useClass` would build a second instance here, in a
    // context that cannot see them.
    { provide: APP_GUARD, useExisting: H5pUrlTokenGuard },
    { provide: APP_GUARD, useClass: FirebaseAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
