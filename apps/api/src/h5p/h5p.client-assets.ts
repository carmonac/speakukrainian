import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/configuration.js';

export type H5pAssetKind = 'core' | 'editor';

/**
 * One file per kind that must exist for the tree to be usable.
 *
 * The same two names `scripts/fetch-h5p-core.ts` writes into its pins. They are
 * repeated rather than shared: the fetch script is a different package, and
 * importing the API's sources from `postinstall` would drag the API's whole
 * dependency graph into an install.
 */
const SENTINELS: Record<H5pAssetKind, string> = {
  core: 'js/h5p.js',
  editor: 'scripts/h5peditor.js',
};

/** What every message about missing assets tells the reader to run. */
export const FETCH_ASSETS_COMMAND = 'pnpm h5p:fetch';

export const missingAssetsMessage = (kind: H5pAssetKind): string =>
  `The H5P ${kind} client library is not installed on this server. Run \`${FETCH_ASSETS_COMMAND}\`.`;

/**
 * Where the H5P client libraries live on disk.
 *
 * They are not part of `@lumieducation/h5p-server` and are not committed:
 * `scripts/fetch-h5p-core.ts` downloads them from two pinned commits during
 * `postinstall` and during the Docker build.
 */
@Injectable()
export class H5pClientAssets implements OnModuleInit {
  private readonly logger = new Logger(H5pClientAssets.name);
  private readonly root: string;

  constructor(config: ConfigService<Env, true>) {
    this.root = resolve(config.get('H5P_ASSETS_DIR', { infer: true }));
  }

  /** Absolute root of one kind's tree, which is what `res.sendFile` gets as its `root`. */
  rootOf(kind: H5pAssetKind): string {
    return resolve(this.root, kind);
  }

  /**
   * Whether that tree is actually there.
   *
   * The sentinel file rather than the directory: a failed or interrupted fetch
   * can leave the directory behind, and a `stat` on it would then report
   * assets that are not there.
   */
  async isInstalled(kind: H5pAssetKind): Promise<boolean> {
    try {
      await access(resolve(this.rootOf(kind), ...SENTINELS[kind].split('/')));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Warns, and never throws.
   *
   * A developer with no network still has to be able to boot the API and work
   * on locales, sections and pages. The asset routes turn the same condition
   * into a 503 carrying the same sentence, so the failure is legible in a
   * browser's network tab instead of being an unexplained 404.
   */
  async onModuleInit(): Promise<void> {
    for (const kind of Object.keys(SENTINELS) as H5pAssetKind[]) {
      if (!(await this.isInstalled(kind))) {
        this.logger.warn(missingAssetsMessage(kind));
      }
    }
  }
}
