import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { H5PConfig } from '@lumieducation/h5p-server';
import type { Env } from '../config/configuration.js';
import { H5P_CONFIG } from './h5p.tokens.js';
import { signH5pUrlToken, verifyH5pUrlToken, type H5pUrlTokenResult } from './h5p.url-token.js';

/**
 * Mints and verifies the credential the H5P editor's own client carries in its
 * URLs.
 *
 * The lifetime is `H5PConfig.temporaryFileLifetime` — 120 minutes — rather than
 * a number of its own. The token exists to let the widget's client act for the
 * length of one editing session, and that setting is already the library's
 * answer to how long an editing session's scratch state lives; a token that
 * outlived the files it exists to read would buy nothing, and one number means
 * one place to change it. The named cost is that the same setting drives the
 * expiry sweep, so changing it for storage reasons changes a credential
 * lifetime — it is not settable from the environment, so that cannot happen
 * without a code change a reader will see.
 *
 * It is read **per mint** rather than cached in the constructor, so a test can
 * drive expiry by moving the live `H5PConfig` value, which is the lever the
 * editor e2e already uses for the sweep.
 */
@Injectable()
export class H5pUrlTokenService {
  private readonly secret: string;

  constructor(
    config: ConfigService<Env, true>,
    @Inject(H5P_CONFIG) private readonly h5p: H5PConfig,
  ) {
    this.secret = config.get('H5P_URL_TOKEN_SECRET', { infer: true });
  }

  mint(uid: string): string {
    return signH5pUrlToken(this.secret, uid, Date.now() + this.h5p.temporaryFileLifetime);
  }

  verify(token: string): H5pUrlTokenResult {
    return verifyH5pUrlToken(this.secret, token, Date.now());
  }
}
