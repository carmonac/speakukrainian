import { Controller, Get, Inject } from '@nestjs/common';
import type { Firestore } from '@google-cloud/firestore';
import { ApiTags } from '@nestjs/swagger';
import { FIRESTORE } from '../infra/firestore/firestore.tokens.js';
import { Public } from '../auth/public.decorator.js';

/**
 * Cloud Run probes `/healthz` for liveness and `/readyz` for readiness. Keep
 * `/healthz` dependency-free so a Firestore blip never restarts the container.
 */
@ApiTags('health')
@Controller()
export class HealthController {
  constructor(@Inject(FIRESTORE) private readonly firestore: Firestore) {}

  @Public()
  @Get('healthz')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Public()
  @Get('readyz')
  async ready(): Promise<{ status: string; firestore: string }> {
    try {
      await this.firestore.listCollections();
      return { status: 'ok', firestore: 'ok' };
    } catch (error) {
      return { status: 'degraded', firestore: (error as Error).message };
    }
  }
}
