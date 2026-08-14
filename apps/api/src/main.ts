import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';
import { useJsonBodyParser } from './common/body-parser.js';
import { securityHeaders } from './common/security-headers.js';
import { loadConfig } from './config/configuration.js';

async function bootstrap(): Promise<void> {
  const env = loadConfig();
  // `bodyParser: false` so the limit raised below does not depend on Nest
  // skipping its own 100 KB defaults; see the helper for why.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    bodyParser: false,
  });

  app.setGlobalPrefix('api', { exclude: ['healthz', 'readyz'] });
  app.enableShutdownHooks();

  app.use(securityHeaders(env.NODE_ENV));

  app.enableCors({
    origin: env.CORS_ORIGINS,
    credentials: true,
  });

  // After CORS: a 413 raised ahead of that middleware carries no
  // `Access-Control-Allow-Origin`, and the admin's `fetch` then reports an
  // opaque network failure instead of the status it could have shown.
  useJsonBodyParser(app);

  if (env.NODE_ENV !== 'production') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Speak Ukrainian API')
      .setDescription('Content, media, H5P and scheduling API')
      .setVersion('0.1.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, swaggerConfig));
  }

  // Cloud Run routes traffic to 0.0.0.0:$PORT — binding to localhost fails health checks.
  await app.listen(env.PORT, '0.0.0.0');
  Logger.log(`API listening on :${env.PORT} (${env.NODE_ENV})`, 'Bootstrap');
}

void bootstrap();
