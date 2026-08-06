import { z } from 'zod';
import {
  assetRefSchema,
  auditSchema,
  localizedTextSchema,
  publishStatusSchema,
  richTextSchema,
  slugSchema,
} from './common.js';

export const pageTypeSchema = z.enum(['rich_text', 'subsection_list', 'h5p_exercise']);
export type PageType = z.infer<typeof pageTypeSchema>;

/**
 * A free-form article. The rich text may embed images and `<audio>` players —
 * audio is a first-class part of the learning content, not a decoration.
 */
export const richTextPageBodySchema = z.object({
  type: z.literal('rich_text'),
  content: richTextSchema,
  /**
   * Audio assets referenced by the editor content, tracked separately so we can
   * garbage-collect orphaned uploads and preload the right files.
   */
  audioAssets: z.array(assetRefSchema).default([]),
  imageAssets: z.array(assetRefSchema).default([]),
});

/**
 * An index page that lists the child sections of its parent — this is what
 * produces pages like `/grammar-points/`.
 */
export const subsectionListPageBodySchema = z.object({
  type: z.literal('subsection_list'),
  /** Defaults to the page's own parent section when omitted. */
  sourceSectionId: z.string().min(1).optional(),
  layout: z.enum(['grid', 'list']).default('grid'),
  showImages: z.boolean().default(true),
  showDescriptions: z.boolean().default(true),
  /** Optional lead-in text rendered above the list. */
  intro: richTextSchema.optional(),
});

/**
 * An interactive H5P exercise plus an optional explanation. The `.h5p` package
 * is uploaded through the admin panel and can be re-edited in place via the
 * H5P authoring widget.
 */
export const h5pExercisePageBodySchema = z.object({
  type: z.literal('h5p_exercise'),
  /** H5P content id assigned by the H5P server. Null until the first upload. */
  h5pContentId: z.string().min(1).nullable().default(null),
  /** Machine name of the H5P library, e.g. `H5P.MultiChoice`. Informational. */
  h5pLibrary: z.string().optional(),
  /** Explanation or instructions shown alongside the exercise. */
  explanation: richTextSchema.optional(),
  explanationPosition: z.enum(['above', 'below']).default('above'),
  /** Whether learner attempts are recorded (xAPI). Off for anonymous practice. */
  trackResults: z.boolean().default(false),
});

export const pageBodySchema = z.discriminatedUnion('type', [
  richTextPageBodySchema,
  subsectionListPageBodySchema,
  h5pExercisePageBodySchema,
]);
export type PageBody = z.infer<typeof pageBodySchema>;
export type RichTextPageBody = z.infer<typeof richTextPageBodySchema>;
export type SubsectionListPageBody = z.infer<typeof subsectionListPageBodySchema>;
export type H5pExercisePageBody = z.infer<typeof h5pExercisePageBodySchema>;

export const seoSchema = z.object({
  metaTitle: localizedTextSchema.optional(),
  metaDescription: localizedTextSchema.optional(),
  ogImage: assetRefSchema.optional(),
  noIndex: z.boolean().default(false),
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
    title: editableContentPageFields.title,
    body: editableContentPageFields.body,
    seo: editableContentPageFields.seo,
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
  sectionId: z.string().min(1),
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
