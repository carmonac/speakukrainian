import {
  h5pExercisePageBodySchema,
  richTextPageBodySchema,
  subsectionListPageBodySchema,
  type PageBody,
  type PageBodyParseInput,
  type PageType,
} from '@speakukrainian/shared';

/**
 * What a body of type `T` is seeded from: the schema's *input*, so every
 * `.default()` is optional and everything else is required.
 *
 * The compiler enforces the discriminant and the presence of every
 * non-defaulted field — omitting `content` from a `rich_text` seed does not
 * compile. It does **not** enforce that a default is left out: restating
 * `layout: 'grid'` still typechecks, because `z.input` makes a defaulted field
 * optional rather than forbidden. Nor does it check any value rule (`min(1)`,
 * `z.url()`); those are only checked when the seed is parsed.
 */
export type PageBodySeed<T extends PageType> = Extract<PageBodyParseInput, { type: T }>;

/**
 * Keyed on `PageType` and discriminated per key, so a fourth body type added to
 * `pageTypeSchema` does not compile until it has a seed here, a seed cannot be
 * filed under the wrong type, and a seed missing a field the schema requires
 * does not compile either. No default is restated, so `packages/shared` stays
 * the only place one lives.
 */
const SEEDS: { [T in PageType]: PageBodySeed<T> } = {
  rich_text: { type: 'rich_text', content: {} },
  subsection_list: { type: 'subsection_list' },
  h5p_exercise: { type: 'h5p_exercise' },
};

/**
 * A map rather than a `switch`, because a `switch` over a generic `T` cannot
 * narrow what it returns without a cast — and a cast believes the seed instead
 * of checking it, which is the hole `PageBodySeed` exists to close. Indexing
 * this and `SEEDS` on one generic key is what lets `emptyBodyFor` return a
 * narrowed body cast-free, and the return type rejects a key wired to another
 * variant's schema.
 *
 * What it does not check: a parser that ignores its parameter and names a seed
 * itself, `rich_text: () => richTextPageBodySchema.parse(SEEDS.subsection_list)`.
 * `parse` takes `unknown`, so that compiles and throws at run time. What catches
 * it is `page-body.spec.ts`, which parses every type through `emptyBodyFor` and
 * compares the result against a seed written independently of this file.
 */
const PARSERS: {
  [T in PageType]: (seed: PageBodySeed<T>) => Extract<PageBody, { type: T }>;
} = {
  rich_text: (seed) => richTextPageBodySchema.parse(seed),
  subsection_list: (seed) => subsectionListPageBodySchema.parse(seed),
  h5p_exercise: (seed) => h5pExercisePageBodySchema.parse(seed),
};

/**
 * The body a brand-new page of `type` starts from.
 *
 * The page form is a shell that knows no body type, so it cannot pick one value
 * and be right: seeding every page with a `rich_text` body would post that body
 * for a page the author asked to be something else, silently, as soon as the
 * other types get an editor (#10, #13).
 *
 * Parsed from the schema rather than written as a literal per type: the defaults
 * come from the schema itself, so an empty body is exactly what the API would
 * store for one.
 *
 * The return narrows with the argument, so a caller that knows its type gets
 * that variant and not the union — the subsection editor needs a
 * `SubsectionListPageBody` for its initial value, and #13's H5P editor should
 * call this rather than parse a third seed of its own.
 */
export function emptyBodyFor<T extends PageType>(type: T): Extract<PageBody, { type: T }> {
  return PARSERS[type](SEEDS[type]);
}

/**
 * The body types this release can author: the list the "New page" menu offers
 * and the list the page form will enable Save for. Stated once, so those two
 * cannot disagree.
 *
 * It does **not** tie either of them to the `@case` branches in
 * `page-form-page.html`: a type added here with no branch enables Save over the
 * `@default` placeholder, and what holds that is the spec
 * `gives a subsection list page its own editor, and lets it be saved`, not the
 * compiler. Nor is this the only place a reachable type is named —
 * `sections/section-form-page.html`'s "Add page" link hardcodes `type: 'rich_text'`
 * in a query param.
 *
 * #13 gives `h5p_exercise` an editor, and `PageFormPage.bodyEditorAvailable`,
 * the `@default` branch and `BODY_TYPE_UNAVAILABLE` then go away. The menu still
 * needs something to iterate; presumably `pageTypeSchema.options`, which is when
 * this constant goes too.
 */
export const AUTHORABLE_PAGE_TYPES: readonly PageType[] = ['rich_text', 'subsection_list'];
