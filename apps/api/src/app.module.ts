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
import { FirebaseAuthGuard } from './auth/firebase-auth.guard.js';
import { RolesGuard } from './auth/roles.guard.js';
import { HttpExceptionFilter } from './common/http-exception.filter.js';
import { HealthController } from './health/health.controller.js';

/**
 * Root module. Every feature module is registered here.
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
    { provide: APP_GUARD, useClass: FirebaseAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
