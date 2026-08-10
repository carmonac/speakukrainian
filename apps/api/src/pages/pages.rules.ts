import type { PageBody, PublishStatus } from '@speakukrainian/shared';

/**
 * The path and publishing arithmetic behind a page, kept apart from Firestore
 * so it is reachable without an emulator — `sections.tree.ts` is the same idea
 * for the section tree. A stale page path is a broken public URL, so every
 * function here fails loudly rather than guessing.
 */

/** A page's public path: its section's path plus its slug. */
export function pagePath(sectionPath: string, slug: string): string {
  return `${sectionPath}/${slug}`;
}

/**
 * The owning section's path, read back off a page path, so a slug change does
 * not need a second document read. Throws when there is no segment to drop: a
 * page path with one segment is corrupt, and guessing a section path for it
 * would cement the corruption.
 */
export function sectionPathOf(path: string): string {
  const cut = path.lastIndexOf('/');
  if (cut <= 0) {
    throw new Error(`Page path "${path}" has no owning section path`);
  }
  return path.slice(0, cut);
}

/** Rewrites one page path for a section that moved from `oldSectionPath` to `newSectionPath`. */
export function rewritePagePath(
  path: string,
  oldSectionPath: string,
  newSectionPath: string,
): string {
  if (!path.startsWith(`${oldSectionPath}/`)) {
    throw new Error(`Page path "${path}" is not under "${oldSectionPath}"`);
  }
  return newSectionPath + path.slice(oldSectionPath.length);
}

/**
 * Half-open `[start, end)` range covering exactly the paths under
 * `sectionPath`, for the descendant scan.
 *
 * `end` ends in `'0'` because that is the byte after `'/'` (0x2F → 0x30), so
 * the range is a prefix match on `<sectionPath>/` without Firestore needing a
 * wildcard operator it does not have. A sibling section at `/olds` is left out:
 * `/olds/intro` does not start with `/old/`. Slugs are ASCII, so JavaScript's
 * UTF-16 comparison and Firestore's UTF-8 ordering agree on the bounds.
 */
export function pagePathRange(sectionPath: string): { start: string; end: string } {
  return { start: `${sectionPath}/`, end: `${sectionPath}0` };
}

/**
 * The section a body lists subsections from, or `null` when it follows the
 * page's own. "Follow my own section" is stored as the *absent* key, so an
 * omitted `sourceSectionId` and a body of another type collapse to the same
 * answer and a caller never has to tell them apart.
 */
export function sourceSectionIdOf(body: PageBody | undefined): string | null {
  return body?.type === 'subsection_list' ? (body.sourceSectionId ?? null) : null;
}

/**
 * `publishedAt` after a status change: stamped the first time a page reaches
 * `published` and never rewritten, so a typo fix that goes draft → published
 * does not renumber the chronology the public site shows. Unpublishing leaves
 * the stamp alone for the same reason.
 */
export function nextPublishedAt(
  current: string | null,
  status: PublishStatus,
  now: string,
): string | null {
  return status === 'published' ? (current ?? now) : current;
}
