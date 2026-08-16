import { z } from 'zod';
import {
  assetRefSchema,
  auditSchema,
  documentIdSchema,
  localizedTextSchema,
  paginationQuerySchema,
  publishStatusSchema,
  richTextSchema,
  slugSchema,
  storedAssetRefSchema,
  storedLocalizedTextSchema,
  storedRichTextSchema,
} from './common.js';

export const pageTypeSchema = z.enum(['rich_text', 'subsection_list', 'h5p_exercise']);
export type PageType = z.infer<typeof pageTypeSchema>;

/**
 * A free-form article, as a stored document holds it. The rich text may embed
 * images and `<audio>` players — audio is a first-class part of the learning
 * content, not a decoration.
 *
 * Its localized fields read through the lenient `stored*` variants (ADR-012);
 * {@link richTextPageBodySchema} below is the bounded shape a request takes.
 */
export const storedRichTextPageBodySchema = z.strictObject({
  type: z.literal('rich_text'),
  content: storedRichTextSchema,
  /**
   * Audio assets referenced by the editor content, tracked separately so we can
   * garbage-collect orphaned uploads and preload the right files.
   */
  audioAssets: z.array(storedAssetRefSchema).default([]),
  imageAssets: z.array(storedAssetRefSchema).default([]),
});

/**
 * An index page that lists the child sections of its parent — this is what
 * produces pages like `/grammar-points/`. Stored shape; see
 * {@link subsectionListPageBodySchema} for the bounded one.
 */
export const storedSubsectionListPageBodySchema = z.strictObject({
  type: z.literal('subsection_list'),
  /**
   * Defaults to the page's own parent section when omitted. Constrained to a
   * document id for the same reason `createContentPageSchema.sectionId` is:
   * rendering the list means handing this value to `collection.doc()`, where a
   * nested path or `..` throws and turns a bad request into a 500.
   *
   * Bounded on the **stored** side as well, which is the norm ADR-012 describes
   * rather than its exception: the page is rendered *from* this value, so there
   * is no useful lenient reading of one that is not an id — the same reason
   * `contentPageSchema` keeps `slug` kebab-case and `path` starting with `/`.
   * The claim this comment used to carry, that nothing has ever written a page
   * document, no longer holds now that pages ship. What carries the bound
   * instead is that the field has been on this schema since it was introduced,
   * so no writer has been able to store a value its alphabet refuses. The
   * reserved-form rule (#47) is the one addition that *is* a tightening — a
   * `PATCH` before #30 stored this value without reading it — so a page
   * carrying `__name__` here would now be unreadable rather than repairable.
   * Accepted because reaching that state took a hand-crafted request through a
   * route #30 has since closed; if such a document ever turns up, the fix is to
   * move this bound to the input variant, as `h5pContentId` below already sits.
   */
  sourceSectionId: documentIdSchema.optional(),
  layout: z.enum(['grid', 'list']).default('grid'),
  showImages: z.boolean().default(true),
  showDescriptions: z.boolean().default(true),
  /** Optional lead-in text rendered above the list. */
  intro: storedRichTextSchema.optional(),
});

/**
 * An interactive H5P exercise plus an optional explanation. The `.h5p` package
 * is uploaded through the admin panel and can be re-edited in place via the
 * H5P authoring widget. Stored shape; see {@link h5pExercisePageBodySchema}.
 */
export const storedH5pExercisePageBodySchema = z.strictObject({
  type: z.literal('h5p_exercise'),
  /** H5P content id assigned by the H5P server. Null until the first upload. */
  h5pContentId: z.string().min(1).nullable().default(null),
  /**
   * Ubername of the H5P library, e.g. `H5P.MultiChoice 1.16`. Informational.
   *
   * The only value any route produces for it is `H5pSaveResult.mainLibrary`,
   * which carries the version; a bare machine name is what nothing writes.
   */
  h5pLibrary: z.string().optional(),
  /** Explanation or instructions shown alongside the exercise. */
  explanation: storedRichTextSchema.optional(),
  explanationPosition: z.enum(['above', 'below']).default('above'),
  /** Whether learner attempts are recorded (xAPI). Off for anonymous practice. */
  trackResults: z.boolean().default(false),
});

/**
 * The bounded variants a request takes, derived from the stored ones so the two
 * cannot drift in anything but the bounds. `.extend()` preserves the strict
 * catchall and the other fields' `.default()`s, so each stays as strict and as
 * defaulted as the block below describes.
 */
export const richTextPageBodySchema = storedRichTextPageBodySchema.extend({
  content: richTextSchema,
  audioAssets: z.array(assetRefSchema).default([]),
  imageAssets: z.array(assetRefSchema).default([]),
});

export const subsectionListPageBodySchema = storedSubsectionListPageBodySchema.extend({
  intro: richTextSchema.optional(),
});

export const h5pExercisePageBodySchema = storedH5pExercisePageBodySchema.extend({
  explanation: richTextSchema.optional(),
  /**
   * The id of another document. Bounded on the input side only, per ADR-012's
   * condition: a page is not addressed or routed by this field, so a stored
   * value the rule refuses leaves the page readable, listable and repairable
   * from its own edit screen — where a stored `sourceSectionId` above is what
   * the page is rendered *from*, and has no useful lenient reading.
   *
   * Bounding the input variant closes every writer: the field is set by the
   * two routes that carry a page body — `POST /api/pages` through
   * `createContentPageSchema.body` and `PATCH /api/pages/:id` through
   * `updateContentPageSchema.body` — and by nothing else, since `h5p.service.ts`
   * records the relationship on the H5P side and deliberately does not write
   * the page.
   */
  h5pContentId: documentIdSchema.nullable().default(null),
});

/**
 * The variants are `strictObject` rather than `object` because zod strips
 * an unrecognized key from a plain object *silently*: a body posted as
 * `{ type: 'subsection_list', content: {…} }` would parse, store none of the
 * content and answer 200, which is a save reporting success for a write that
 * did not happen. Strict members turn the same body into an
 * `unrecognized_keys` issue pathed at `body`.
 *
 * Strictness holds on both shapes, and not because no page document exists —
 * they do now. A stored body carrying a key from another variant is corrupt
 * whichever schema reads it, and no writer can produce one: every page body is
 * written through the bounded variants above. The **length** rules are the ones
 * ADR-012 separates, so they live on the bounded variants alone.
 */
export const pageBodySchema = z.discriminatedUnion('type', [
  richTextPageBodySchema,
  subsectionListPageBodySchema,
  h5pExercisePageBodySchema,
]);

/** What the repository parses a stored body with: the same shape, unbounded. */
export const storedPageBodySchema = z.discriminatedUnion('type', [
  storedRichTextPageBodySchema,
  storedSubsectionListPageBodySchema,
  storedH5pExercisePageBodySchema,
]);
export type PageBody = z.infer<typeof pageBodySchema>;
export type RichTextPageBody = z.infer<typeof richTextPageBodySchema>;
export type SubsectionListPageBody = z.infer<typeof subsectionListPageBodySchema>;
export type H5pExercisePageBody = z.infer<typeof h5pExercisePageBodySchema>;

/**
 * What a caller hands to `pageBodySchema.parse`, as against {@link PageBody},
 * which is what comes back. Every `.default()` is optional here and present
 * there, so a value of this type is exactly "the fields the schema cannot
 * supply on my behalf" — which is what seeds a new body. A caller building a
 * body to send or to store wants `PageBody`; a caller writing the literal that
 * `parse` fills in wants this.
 *
 * Named for `parse` rather than `PageBodyInput`, because every other `*Input`
 * in this package — `CreateContentPageInput` below, `CreateSectionInput`,
 * `UpdateLocaleInput` — is a request schema's *parsed* shape, the opposite side
 * of the same schema.
 */
export type PageBodyParseInput = z.input<typeof pageBodySchema>;

/** A page's own id: `documentIdSchema` under the name the routes use. */
export const pageIdSchema = documentIdSchema;

/** The SEO block as a stored document holds it — lenient, per ADR-012. */
export const storedSeoSchema = z.object({
  metaTitle: storedLocalizedTextSchema.optional(),
  metaDescription: storedLocalizedTextSchema.optional(),
  ogImage: storedAssetRefSchema.optional(),
  noIndex: z.boolean().default(false),
});

/** The same block as a request may carry it: every localized field is bounded. */
export const seoSchema = storedSeoSchema.extend({
  metaTitle: localizedTextSchema.optional(),
  metaDescription: localizedTextSchema.optional(),
  ogImage: assetRefSchema.optional(),
});
export type Seo = z.infer<typeof seoSchema>;

/**
 * The fields an admin edits, without their defaults — see the same split in
 * `section.ts`. `.partial()` keeps a field's inner `.default()`, so a patch
 * schema derived from the create schema would fill in `status` and `sortOrder`
 * on every request and unpublish or reorder a page nobody asked to touch.
 * `sectionId` is absent because a page is moved between sections by its own
 * operation, which has to recompute `path`.
 */
export const editableContentPageFields = {
  slug: slugSchema,
  title: localizedTextSchema,
  body: pageBodySchema,
  seo: seoSchema.optional(),
  sortOrder: z.number().int(),
  status: publishStatusSchema,
};

export const contentPageSchema = z
  .object({
    id: z.string().min(1),
    /** Every page lives inside a section or subsection. */
    sectionId: z.string().min(1),
    slug: editableContentPageFields.slug,
    /** Full public path, e.g. `/grammar-points/present-simple/intro`. */
    path: z.string().startsWith('/'),
    /**
     * Read through the lenient variants (ADR-012): the localized length and
     * entry-count bounds arrived after documents existed, and this schema is
     * what the repository parses every document it reads with.
     */
    title: storedLocalizedTextSchema,
    body: storedPageBodySchema,
    seo: storedSeoSchema.optional(),
    sortOrder: editableContentPageFields.sortOrder.default(0),
    status: editableContentPageFields.status.default('draft'),
    publishedAt: z.string().nullable().default(null),
    audit: auditSchema,
  })
  .refine(
    (p) => p.status !== 'published' || p.body.type !== 'h5p_exercise' || p.body.h5pContentId,
    {
      message: 'An H5P page cannot be published before its H5P content is uploaded',
      path: ['body', 'h5pContentId'],
    },
  );

export type ContentPage = z.infer<typeof contentPageSchema>;

export const createContentPageSchema = z.object({
  /**
   * ADR-012: the document-id rule guards a value arriving on a request, so it
   * lives here and not on `contentPageSchema.sectionId` — a stored id written
   * before the rule existed must stay readable, and this value goes straight
   * into `collection.doc()`.
   */
  sectionId: documentIdSchema,
  slug: editableContentPageFields.slug,
  title: editableContentPageFields.title,
  body: editableContentPageFields.body,
  seo: editableContentPageFields.seo,
  /** Omitted means "append after the last sibling", which the repository resolves. */
  sortOrder: editableContentPageFields.sortOrder.optional(),
  status: editableContentPageFields.status.default('draft'),
});
export type CreateContentPageInput = z.infer<typeof createContentPageSchema>;

/**
 * Body of `PATCH /api/pages/:id`: every key optional, none defaulted, so a
 * request that carries one field changes exactly that field.
 */
export const updateContentPageSchema = z.object(editableContentPageFields).partial();
export type UpdateContentPageInput = z.infer<typeof updateContentPageSchema>;

/**
 * Query for `GET /api/pages`. `type` filters the body variant, which the
 * document stores at `body.type` — the repository is what knows that; a caller
 * says `type`.
 */
export const listPagesQuerySchema = paginationQuerySchema.extend({
  sectionId: documentIdSchema.optional(),
  status: publishStatusSchema.optional(),
  type: pageTypeSchema.optional(),
});
export type ListPagesQuery = z.infer<typeof listPagesQuerySchema>;
