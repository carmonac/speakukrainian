import { z } from 'zod';
import { localeCodeSchema } from './common.js';

/**
 * One entry of `GET /api/menu`. A projection rather than a stored document
 * (ADR-010): it is built field by field from a `Section`, so it carries no
 * `audit`, no `status` and nothing else an anonymous reader has no business
 * seeing. An interface rather than a Zod schema for the same reason
 * `SectionTreeNode` is one — nothing ever parses input into this shape.
 */
export interface MenuEntry {
  id: string;
  /** Already resolved for the requested locale — `menuLabel`, else `title` (ADR-009). */
  label: string;
  /** The link target for a `link` section, the section's own `path` otherwise. */
  href: string;
  openInNewTab: boolean;
  children: MenuEntry[];
}

/** Query for `GET /api/menu`. An absent `locale` means the site's default locale. */
export const menuQuerySchema = z.object({ locale: localeCodeSchema.optional() });
export type MenuQuery = z.infer<typeof menuQuerySchema>;
