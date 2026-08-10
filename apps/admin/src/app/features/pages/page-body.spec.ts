import { describe, expect, it } from 'vitest';
import { pageBodySchema, pageTypeSchema, type PageType } from '@speakukrainian/shared';
import { emptyBodyFor, type PageBodySeed } from './page-body';

/*
 * Compile-time assertions, checked by `tsc -p tsconfig.spec.json --noEmit` —
 * the second half of the admin's `typecheck` script — and not by Vitest, which
 * never runs this block's declarations for their values.
 *
 * Each directive *is* its assertion: an `@ts-expect-error` on a line that
 * compiles is itself an error ("unused '@ts-expect-error' directive"), so the
 * day either stops being rejected, the build says so. What would remove either
 * is `PageBodySeed` ceasing to be derived from the schema's input, at which
 * point the runtime guard below is all that is left.
 *
 * There is deliberately no third assertion for "a fourth `PageType` does not
 * compile until it has a seed". A mapped type over `PageType` demands every key
 * whatever its element type is, so such an assertion would pin TypeScript and
 * never `page-body.ts`. What guards that property is `SEEDS`' own mapped type,
 * and then `PARSERS[type](SEEDS[type])` — make `SEEDS` partial and drop a seed
 * and the call reports `undefined` is not a `PageBodySeed<T>`. The loop over
 * `pageTypeSchema.options` below catches the same omission at run time.
 */

// @ts-expect-error - `content` is not defaulted, so a `rich_text` seed must carry it
const _missingRequiredField: PageBodySeed<'rich_text'> = { type: 'rich_text' };

// @ts-expect-error - a `subsection_list` seed cannot carry another type's discriminant
const _misfiledSeed: PageBodySeed<'subsection_list'> = { type: 'h5p_exercise' };

/**
 * A minimal seed per type, written here rather than imported from the module
 * under test: what has to stay independent of `SEEDS` is these *values*, so a
 * default that creeps into a seed shows up as a difference. The type is shared
 * with the module, which costs that independence nothing and makes a typo in
 * this fixture a compile error rather than a puzzling failed comparison.
 */
const MINIMAL: { [T in PageType]: PageBodySeed<T> } = {
  rich_text: { type: 'rich_text', content: {} },
  subsection_list: { type: 'subsection_list' },
  h5p_exercise: { type: 'h5p_exercise' },
};

describe('emptyBodyFor', () => {
  it('answers a body of the type asked for, for every type there is', () => {
    // Driven off `pageTypeSchema.options` rather than a list written here. The
    // compiler now checks which fields a seed carries, but not what the value
    // rules make of them, so a seed that typechecks and still fails to parse
    // needs catching without anyone remembering to add a case.
    for (const type of pageTypeSchema.options) {
      const body = emptyBodyFor(type);

      expect(body.type).toBe(type);
      expect(pageBodySchema.safeParse(body).success).toBe(true);
    }
  });

  it('seeds nothing the schema could have supplied itself', () => {
    // Blind spot, stated so nobody reads more into a pass than is there: a
    // default restated in a seed with the schema's own value is invisible here,
    // as it is to the compiler. A restated default whose value differs is not.
    for (const type of pageTypeSchema.options) {
      expect(emptyBodyFor(type)).toEqual(pageBodySchema.parse(MINIMAL[type]));
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

  it('starts a subsection list on its own parent section, with nothing pinned', () => {
    const body = emptyBodyFor('subsection_list');

    expect(body).toEqual({
      type: 'subsection_list',
      layout: 'grid',
      showImages: true,
      showDescriptions: true,
    });
    // Absent rather than `undefined`: the strict schema rejects a key it does
    // not know, and an omitted source is what means "list my own parent".
    expect(Object.keys(body)).not.toContain('sourceSectionId');
    expect(Object.keys(body)).not.toContain('intro');
  });
});
