import { z } from 'zod';
import {
  assetRefSchema,
  auditSchema,
  localizedTextSchema,
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
 * Sections form a tree via `parentId`. A root section (`parentId: null`) is what
 * the product calls a "section"; a section with a parent is a "subsection".
 * Nesting deeper than {@link MAX_SECTION_DEPTH} is rejected.
 */
export const sectionSchema = z
  .object({
    id: z.string().min(1),
    parentId: z.string().min(1).nullable(),
    /** Root-to-node id chain excluding self — lets us fetch a whole subtree in one query. */
    ancestorIds: z.array(z.string().min(1)).default([]),
    /** 0 for a root section, 1 for a subsection, and so on. Derived from `ancestorIds`. */
    depth: z.number().int().min(0).max(4),
    kind: sectionKindSchema,

    slug: slugSchema,
    /** Full public path built from the ancestor slugs, e.g. `/grammar-points/present-simple`. */
    path: z.string().startsWith('/'),
    title: localizedTextSchema,
    description: richTextSchema.optional(),
    image: assetRefSchema.optional(),

    /** Whether this section appears in the site navigation menu. */
    showInMenu: z.boolean().default(false),
    /** Overrides `title` in the menu when set — for shorter or different menu wording. */
    menuLabel: localizedTextSchema.optional(),

    /** Present only when `kind === 'link'`. */
    link: linkTargetSchema.optional(),

    sortOrder: z.number().int().default(0),
    status: publishStatusSchema.default('draft'),
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
  parentId: z.string().min(1).nullable().default(null),
  kind: sectionKindSchema.default('content'),
  slug: slugSchema,
  title: localizedTextSchema,
  description: richTextSchema.optional(),
  image: assetRefSchema.optional(),
  showInMenu: z.boolean().default(false),
  menuLabel: localizedTextSchema.optional(),
  link: linkTargetSchema.optional(),
  sortOrder: z.number().int().optional(),
  status: publishStatusSchema.default('draft'),
});
export type CreateSectionInput = z.infer<typeof createSectionSchema>;

export const updateSectionSchema = createSectionSchema.partial().omit({ parentId: true });
export type UpdateSectionInput = z.infer<typeof updateSectionSchema>;

/** Moving a section re-parents it and repositions it among its new siblings. */
export const moveSectionSchema = z.object({
  parentId: z.string().min(1).nullable(),
  sortOrder: z.number().int(),
});
export type MoveSectionInput = z.infer<typeof moveSectionSchema>;

/** A section with its children resolved — what the menu and list pages render from. */
export interface SectionTreeNode extends Section {
  children: SectionTreeNode[];
}
