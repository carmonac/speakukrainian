import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/configuration.js';
import { H5P_WORKING_DIRS, type H5pWorkingDirs } from './h5p.tokens.js';

/**
 * The local scratch directories, in a module of their own.
 *
 * This is not decoration: `MulterModule.registerAsync` resolves its factory
 * inside `MulterModule`'s own injector, which cannot see providers declared in
 * `H5pModule` — passing `inject: [H5P_WORKING_DIRS]` without importing a module
 * that exports the token fails at boot with "Nest can't resolve dependencies of
 * the MULTER_MODULE_OPTIONS". Both `H5pModule` and the Multer dynamic module
 * import this one, so the upload destination and the temporary storage resolve
 * the same paths from one place.
 */
@Module({
  providers: [
    {
      provide: H5P_WORKING_DIRS,
      inject: [ConfigService],
      useFactory: async (config: ConfigService<Env, true>): Promise<H5pWorkingDirs> => {
        const root = resolve(config.get('H5P_TEMP_DIR', { infer: true }));
        const dirs: H5pWorkingDirs = {
          root,
          uploads: resolve(root, 'uploads'),
          editorTemp: resolve(root, 'editor-temp'),
        };

        // `DirectoryTemporaryFileStorage`'s constructor calls `mkdir` without
        // awaiting it; creating the directories first removes that startup race.
        await Promise.all(Object.values(dirs).map((path) => mkdir(path, { recursive: true })));
        return dirs;
      },
    },
  ],
  exports: [H5P_WORKING_DIRS],
})
export class H5pWorkingDirsModule {}
