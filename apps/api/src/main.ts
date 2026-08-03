import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import { loadConfig } from './config/configuration.js';

async function bootstrap(): Promise<void> {
  const env = loadConfig();
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  app.setGlobalPrefix('api', { exclude: ['healthz', 'readyz'] });
  app.enableShutdownHooks();

  app.use(
    helmet({
      // The public site embeds H5P iframes served from this origin.
      crossOriginEmbedderPolicy: false,
      contentSecurityPolicy: env.NODE_ENV === 'production' ? undefined : false,
    }),
  );

  app.enableCors({
    origin: env.CORS_ORIGINS,
    credentials: true,
  });

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
