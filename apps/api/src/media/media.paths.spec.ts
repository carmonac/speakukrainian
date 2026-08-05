import { describe, expect, it } from 'vitest';
import { buildObjectPath } from './media.paths.js';

describe('buildObjectPath', () => {
  it('puts an image under images/<yyyy>/<mm>/<uuid>.<ext>', () => {
    const path = buildObjectPath('image', 'image/png', new Date('2026-03-09T00:00:00Z'));

    expect(path).toMatch(/^images\/2026\/03\/[0-9a-f-]{36}\.png$/);
  });

  it('puts audio under its own prefix with the extension of its content type', () => {
    const path = buildObjectPath('audio', 'audio/mpeg', new Date('2026-03-09T00:00:00Z'));

    expect(path).toMatch(/^audio\/2026\/03\/[0-9a-f-]{36}\.mp3$/);
  });

  it('zero-pads a single-digit month', () => {
    const path = buildObjectPath('image', 'image/webp', new Date('2026-01-15T12:00:00Z'));

    expect(path.startsWith('images/2026/01/')).toBe(true);
  });

  it('reads the date in UTC, not the runner timezone', () => {
    // 2026-01-01T00:30Z is still 2025-12-31 in the Americas; a local-time
    // reading would file the object under the previous year.
    const path = buildObjectPath('audio', 'audio/ogg', new Date('2026-01-01T00:30:00Z'));

    expect(path.startsWith('audio/2026/01/')).toBe(true);
  });

  it('never returns the same path twice for identical arguments', () => {
    // This is what makes two uploads of the same filename two objects.
    const now = new Date('2026-03-09T00:00:00Z');

    const paths = new Set(
      Array.from({ length: 20 }, () => buildObjectPath('image', 'image/png', now)),
    );

    expect(paths.size).toBe(20);
  });
});
