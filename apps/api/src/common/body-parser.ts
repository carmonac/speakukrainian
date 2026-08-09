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
 * The caller creates the application with `bodyParser: false`. Nest's
 * `ExpressAdapter.registerParserMiddleware` installs its own 100 KB pair during
 * `init()` and `useBodyParser` only *appends*, so a default already in the stack
 * would reject the request first. It is not what makes this call take effect
 * today: Nest skips its defaults when a parser of the same function name is
 * already installed (`layer.handle.name === 'jsonParser'`), and both bootstraps
 * call this before `init()`. The flag is kept so the raised limit depends on
 * neither that name comparison in a third-party file nor on a call order this
 * helper cannot enforce.
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
