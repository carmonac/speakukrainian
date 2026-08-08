import { BadRequestException } from '@nestjs/common';
import type { Request } from 'express';
import { joinContentFilePath } from './h5p.paths.js';

/**
 * The `*path` wildcard, joined and asserted.
 *
 * Express 5 decodes each segment before handing it over, so
 * `media/..%2f..%2fx` arrives as `['media', '../../x']` — a per-segment check
 * sees two ordinary names. `joinContentFilePath` is where the assert runs after
 * the join, which is the only order that catches it.
 *
 * Its `H5pError` becomes a `BadRequestException` here rather than being carried
 * further: every route that takes a wildcard path refuses it before it reaches
 * `StorageService` or `send`, and the caller is told the same thing whichever
 * one they asked.
 *
 * It lives in a module of its own rather than beside its first caller because
 * every new route with a `*path` needs exactly this, and a traversal guard that
 * gets re-typed in a second controller is how two subtly different rules
 * appear.
 */
export function wildcardPath(req: Request): string {
  const raw: unknown = (req.params as Record<string, unknown>)['path'];
  const segments = Array.isArray(raw) ? raw.map((segment) => String(segment)) : String(raw ?? '');

  try {
    return joinContentFilePath(segments);
  } catch {
    throw new BadRequestException('The requested file path is not valid.');
  }
}
