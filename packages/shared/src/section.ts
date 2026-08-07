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
} from './common.js';

/**
 * `content` sections hold pages and child sections. `link` sections render as a
 * menu entry or card that navigates somewhere else instead of having a body.
 */
export const sectionKindSchema = z.enum(['content', 'link']);
export type SectionKind = z.infer<typeof sectionKindSchema>;

/**
 * The stored shape of a link target, and deliberately *not* where the href
 * shape rule lives — {@link linkTargetSchema} is (ADR-012). A document written
 * before that rule existed can carry an href it would refuse, and refusing to
 * *read* such a document takes the public menu, the admin tree and the section
 * itself down at once, leaving an editor unable to open the very screen that
 * would repair it. So the rule guards the values arriving from a request, and
 * reading stays lenient.
 *
 * Only `sectionSchema` should reach for this one. Anything that *publishes* an
 * href — the menu projection is the first — checks it against
 * {@link linkTargetSchema} first, because a lenient read keeps a bad value
 * repairable, not fit to serve.
 */
export const storedLinkTargetSchema = z.object({
  /** `internal` resolves against the site's own router; `external` is an absolute URL. */
  type: z.enum(['internal', 'external']),
  /**
   * For `internal`: a site-relative path starting with `/`. For `external`: an
   * absolute URL. Neither is stated here — an empty href included, which is a
   * shape rule like any other and lives on {@link linkTargetSchema} with the
   * rest of them, so that a stored one is dropped from the menu rather than
   * taking every read of the collection down with it.
   */
  href: z.string(),
  openInNewTab: z.boolean().default(false),
});
export type LinkTarget = z.infer<typeof storedLinkTargetSchema>;

/**
 * An origin an href can never legitimately resolve to: `.invalid` is reserved by
 * RFC 2606 and can never be registered.
 */
const INTERNAL_HREF_BASE = 'https://internal.invalid';

/**
 * Whether an internal href still points at this site once a browser has resolved
 * it.
 *
 * This is an origin comparison rather than a prefix test because a prefix test
 * cannot express the rule. The WHATWG URL parser folds `\` to `/` for special
 * schemes and strips tab, LF and CR before parsing, so `/\evil.com`,
 * `/\/evil.com` and `/<TAB>/evil.com` all resolve to `http://evil.com/` in a
 * browser — exactly what `//evil.com` does, and a prefix rule has to enumerate
 * spellings it cannot know all of. Resolving against a sentinel origin asks the
 * same parser the browser will use, so every spelling it folds is covered,
 * including the ones nobody has written down yet.
 *
 * The leading `/` is still required on top of that: `grammar` resolves onto the
 * sentinel origin too, but as a *relative* reference it lands somewhere
 * different on every page it is rendered from.
 */
function isInternalHref(href: string): boolean {
  if (!href.startsWith('/')) {
    return false;
  }
  try {
    return new URL(href, INTERNAL_HREF_BASE).origin === INTERNAL_HREF_BASE;
  } catch {
    // The parser refuses some hrefs outright rather than folding them (`/\\`
    // asks for an empty host). Unfollowable is not internal.
    return false;
  }
}

/**
 * A link target with the href shape rule, which lives here and nowhere else:
 * the controller pipes reach it through `createSectionSchema` and
 * `updateSectionSchema`, the admin's own field validator parses through it
 * directly (rule 1), and the menu projection re-checks a stored target against
 * it before publishing the href.
 *
 * It has the plain name because it is what almost every caller wants;
 * {@link storedLinkTargetSchema} is the exception and says so.
 *
 * The internal branch is {@link isInternalHref}. The external branch is a
 * `z.url` restricted to `http`/`https`, which refuses `javascript:`, `ftp:` and
 * bare strings.
 */
export const linkTargetSchema = storedLinkTargetSchema.refine(
  (target) =>
    target.type === 'internal'
      ? isInternalHref(target.href)
      : z.url({ protocol: /^https?$/ }).safeParse(target.href).success,
  {
    message:
      'An internal link is a site-relative path that stays on this site; an external link is an absolute http(s) URL',
    path: ['href'],
  },
);

/**
 * A Firestore document id. Constrained so a hand-crafted path segment cannot
 * reach `collection.doc()` as `..` or a nested path.
 */
export const sectionIdSchema = documentIdSchema;

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
  /**
   * Present only when `kind === 'link'`. Every input schema is built from this
   * table, so the href shape rule applies to every request carrying a target.
   */
  link: linkTargetSchema.optional(),
  /**
   * The number stored against the section, ordering it among its siblings.
   * Create and update write it verbatim and renumber nothing else; only
   * {@link moveSectionSchema} reads a `sortOrder` as a *position* instead.
   */
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

    /**
     * The stored target is read through the lenient
     * {@link storedLinkTargetSchema}, not through `editableSectionFields.link`:
     * this schema is what the repository parses documents *with*, and a stored
     * href the input rule refuses has to stay readable so it can be repaired.
     */
    link: storedLinkTargetSchema.optional(),

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
 *
 * `image` also accepts `null`, meaning "clear it". Every other field is merely
 * optional, and an omitted field is left alone — so without this there would be
 * no way to remove a section's image once one had been set.
 */
export const updateSectionSchema = z
  .object(editableSectionFields)
  .partial()
  .extend({ image: assetRefSchema.nullable().optional() });
export type UpdateSectionInput = z.infer<typeof updateSectionSchema>;

/**
 * Moving a section re-parents it and repositions it among its new siblings.
 *
 * `sortOrder` here is a **position**, 0-based, among the destination's children
 * with the moved section taken out of them, clamped to `[0, n]` — not a raw
 * number to store. The server renumbers that whole child list to contiguous
 * integers from 0 in the same transaction, so the position asked for is the
 * number that ends up stored and a caller never has to know its neighbours'
 * numbers. The source parent's remaining children keep the numbers they have;
 * the gap left behind changes no ordering, since `sortOrder` is only ever
 * compared between children of one parent.
 */
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
