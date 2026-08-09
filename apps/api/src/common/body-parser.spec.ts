import { describe, expect, it } from 'vitest';
import { MAX_JSON_BODY_BYTES } from '@speakukrainian/shared';
import { useJsonBodyParser, type BodyParserHost } from './body-parser.js';

describe('useJsonBodyParser', () => {
  it('raises both parsers to the shared limit', () => {
    const calls: [string, unknown][] = [];
    const recorder: BodyParserHost = {
      useBodyParser: (parser, options) => calls.push([parser, options]),
    };

    useJsonBodyParser(recorder);

    // `urlencoded` is here because leaving it at the 100 KB default would make
    // the 413's "Request bodies must be under 1 MB" false for form-encoded
    // bodies. That the limit is actually in force is proved by the e2e suite —
    // this helper is a no-op unless the app was created with `bodyParser: false`.
    expect(calls).toEqual([
      ['json', { limit: MAX_JSON_BODY_BYTES }],
      ['urlencoded', { extended: true, limit: MAX_JSON_BODY_BYTES }],
    ]);
  });
});
