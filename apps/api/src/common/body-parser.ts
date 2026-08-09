import type {
  NestExpressBodyParserOptions,
  NestExpressBodyParserType,
} from '@nestjs/platform-express';
import { MAX_JSON_BODY_BYTES } from '@speakukrainian/shared';

/**
 * The slice of the application `useJsonBodyParser` needs, so a spec can pass a
 * recorder without a cast. `Pick<NestExpressApplication, 'useBodyParser'>` would
 * carry the method's `this` return type, which only a real application has.
 */
export interface BodyParserHost {
  useBodyParser(parser: NestExpressBodyParserType, options?: NestExpressBodyParserOptions): unknown;
}

/**
 * Installs the body parsers at `MAX_JSON_BODY_BYTES` instead of Express's 100 KB
 * default, which clips a typical three-locale rich text page.
 *
 * The caller must create the application with `bodyParser: false`. Nest's
 * `ExpressAdapter.registerParserMiddleware` installs its own 100 KB parsers
 * during `init()` and `useBodyParser` only *appends* — so without it the default
 * parser rejects the request first and this call is dead code that no unit test
 * would notice.
 *
 * Both bootstraps call this — `main.ts` and `test/emulator.ts` — because an e2e
 * suite running at a different limit tests a server that does not exist.
 *
 * `urlencoded` is raised alongside `json` even though nothing posts form-encoded
 * today: leaving it at the default would make the 413's wording false for one of
 * the two parsers.
 */
export function useJsonBodyParser(app: BodyParserHost): void {
  app.useBodyParser('json', { limit: MAX_JSON_BODY_BYTES });
  app.useBodyParser('urlencoded', { extended: true, limit: MAX_JSON_BODY_BYTES });
}
