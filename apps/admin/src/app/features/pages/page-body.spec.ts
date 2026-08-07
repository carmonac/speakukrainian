import { describe, expect, it } from 'vitest';
import { pageBodySchema, pageTypeSchema } from '@speakukrainian/shared';
import { emptyBodyFor } from './page-body';

describe('emptyBodyFor', () => {
  it('answers a body of the type asked for, for every type there is', () => {
    // Driven off `pageTypeSchema.options` rather than a list written here: a
    // type added to the schema with a seed that does not parse — a required
    // field left out — fails this without anyone remembering to add a case.
    for (const type of pageTypeSchema.options) {
      const body = emptyBodyFor(type);

      expect(body.type).toBe(type);
      expect(pageBodySchema.safeParse(body).success).toBe(true);
    }
  });

  it('starts a rich text page with an empty asset index, not with none', () => {
    // The tracker replaces both arrays on the first edit, but a create that
    // saved before any edit would otherwise post a body with neither.
    expect(emptyBodyFor('rich_text')).toEqual({
      type: 'rich_text',
      content: {},
      audioAssets: [],
      imageAssets: [],
    });
  });
});
