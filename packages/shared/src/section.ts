import { z } from 'zod';
import {
  assetRefSchema,
  auditSchema,
  localizedTextSchema,
  paginationQuerySchema,
  publishStatusSchema,
  richTextSchema,
  slugSchema,
} from './common.js';

/**
 * `content` sections hold pages and child sections. `link` sections render as a
 * menu entry or card that navigates somewhere else instead of having a body.
 */
export const sectionKindSchema = z.enum(['content', 'link']);
export type SectionKind = z.infer<typeof sectionKindSchema>;

export const linkTargetSchema = z.object({
  /** `internal` resolves against the site's own router; `external` is an absolute URL. */
  type: z.enum(['internal', 'external']),
  /** For `internal`: a site-relative path starting with `/`. For `external`: an absolute URL. */
  href: z.string().min(1),
  openInNewTab: z.boolean().default(false),
});
export type LinkTarget = z.infer<typeof linkTargetSchema>;

/**
 * A Firestore document id. Constrained so a hand-crafted path segment cannot
 * reach `collection.doc()` as `..` or a nested path.
 */
export const sectionIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, 'Must be a Firestore document id');

/**
 * The fields an admin edits, without their defaults. A stored document and a
 * create body both want the defaults, so they are applied in `sectionSchema`
 * and `createSectionSchema` below — but never in the patch schema: `.partial()`
 * wraps a field in optional and keeps its inner `.default()`, so a patch schema
 * derived from the create schema would fill in every field the request left out
 * and silently rewrite the stored value. `parentId` is absent because a section
 * is re-parented through `PATCH /:id/move`, which recomputes the whole subtree.
 */
export const editableSectionFields = {
  kind: sectionKindSchema,
  slug: slugSchema,
  title: localizedTextSchema,
  description: richTextSchema.optional(),
  image: assetRefSchema.optional(),
  /** Whether this section appears in the site navigation menu. */
  showInMenu: z.boolean(),
  /** Overrides `title` in the menu when set — for shorter or different menu wording. */
  menuLabel: localizedTextSchema.optional(),
  /** Present only when `kind === 'link'`. */
  link: linkTargetSchema.optional(),
  sortOrder: z.number().int(),
  status: publishStatusSchema,
};

/**
 * Sections form a tree via `parentId`. A root section (`parentId: null`) is what
 * the product calls a "section"; a section with a parent is a "subsection".
 * Nesting deeper than {@link MAX_SECTION_DEPTH} is rejected.
 */
export const sectionSchema = z
  .object({
    id: sectionIdSchema,
    parentId: sectionIdSchema.nullable(),
    /** Root-to-node id chain excluding self — lets us fetch a whole subtree in one query. */
    ancestorIds: z.array(sectionIdSchema).default([]),
    /** 0 for a root section, 1 for a subsection, and so on. Derived from `ancestorIds`. */
    depth: z.number().int().min(0).max(4),
    kind: editableSectionFields.kind,

    slug: editableSectionFields.slug,
    /** Full public path built from the ancestor slugs, e.g. `/grammar-points/present-simple`. */
    path: z.string().startsWith('/'),
    title: editableSectionFields.title,
    description: editableSectionFields.description,
    image: editableSectionFields.image,

    showInMenu: editableSectionFields.showInMenu.default(false),
    menuLabel: editableSectionFields.menuLabel,

    link: editableSectionFields.link,

    sortOrder: editableSectionFields.sortOrder.default(0),
    status: editableSectionFields.status.default('draft'),
    audit: auditSchema,
  })
  .refine((s) => (s.kind === 'link' ? s.link !== undefined : s.link === undefined), {
    message: 'A `link` section requires a `link` target, and a `content` section must not have one',
    path: ['link'],
  })
  .refine((s) => s.depth === s.ancestorIds.length, {
    message: '`depth` must equal the number of ancestors',
    path: ['depth'],
  });

export type Section = z.infer<typeof sectionSchema>;

export const MAX_SECTION_DEPTH = 4;

export const createSectionSchema = z.object({
  parentId: sectionIdSchema.nullable().default(null),
  kind: editableSectionFields.kind.default('content'),
  slug: editableSectionFields.slug,
  title: editableSectionFields.title,
  description: editableSectionFields.description,
  image: editableSectionFields.image,
  showInMenu: editableSectionFields.showInMenu.default(false),
  menuLabel: editableSectionFields.menuLabel,
  link: editableSectionFields.link,
  /** Omitted means "append after the last sibling", which the repository resolves. */
  sortOrder: editableSectionFields.sortOrder.optional(),
  status: editableSectionFields.status.default('draft'),
});
export type CreateSectionInput = z.infer<typeof createSectionSchema>;

/**
 * Body of `PATCH /api/sections/:id`: every key optional, none defaulted, so a
 * request that carries one field changes exactly that field.
 */
export const updateSectionSchema = z.object(editableSectionFields).partial();
export type UpdateSectionInput = z.infer<typeof updateSectionSchema>;

/** Moving a section re-parents it and repositions it among its new siblings. */
export const moveSectionSchema = z.object({
  parentId: sectionIdSchema.nullable(),
  sortOrder: z.number().int(),
});
export type MoveSectionInput = z.infer<typeof moveSectionSchema>;

/** A section with its children resolved — what the menu and list pages render from. */
export interface SectionTreeNode extends Section {
  children: SectionTreeNode[];
}

/**
 * Query for `GET /api/sections`. A query string cannot carry `null`, so the
 * literal `root` is the sentinel for "sections with no parent"; an absent
 * `parentId` means every section. Firestore auto-ids are 20 characters, so
 * `root` can never collide with a real id.
 */
export const SECTION_ROOT_PARENT = 'root';

export const listSectionsQuerySchema = paginationQuerySchema.extend({
  parentId: z.union([z.literal(SECTION_ROOT_PARENT), sectionIdSchema]).optional(),
  status: publishStatusSchema.optional(),
});
export type ListSectionsQuery = z.infer<typeof listSectionsQuerySchema>;
