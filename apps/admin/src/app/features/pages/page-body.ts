import { pageBodySchema, type PageBody, type PageType } from '@speakukrainian/shared';

/**
 * What a body of type `T` is seeded from: the discriminant, plus whichever
 * fields the schema does not default. Every defaulted field is left out — no
 * default is restated here, so `packages/shared` stays the only place one lives.
 */
type PageBodySeed<T extends PageType> = { type: T } & Partial<Extract<PageBody, { type: T }>>;

/**
 * Keyed on `PageType` and discriminated per key, so a fourth body type added to
 * `pageTypeSchema` does not compile until it has a seed here, and a seed cannot
 * be filed under the wrong type.
 */
const SEEDS: { [T in PageType]: PageBodySeed<T> } = {
  rich_text: { type: 'rich_text', content: {} },
  subsection_list: { type: 'subsection_list' },
  h5p_exercise: { type: 'h5p_exercise' },
};

/**
 * The body a brand-new page of `type` starts from.
 *
 * The page form is a shell that knows no body type, so it cannot pick one value
 * and be right: seeding every page with a `rich_text` body would post that body
 * for a page the author asked to be something else, silently, as soon as the
 * other types get an editor (#10, #13).
 *
 * `pageBodySchema.parse` rather than a literal per type: the defaults come from
 * the schema itself, so an empty body is exactly what the API would store for
 * one, and a seed missing a field the schema requires throws here rather than
 * failing a save later.
 */
export function emptyBodyFor(type: PageType): PageBody {
  return pageBodySchema.parse(SEEDS[type]);
}
