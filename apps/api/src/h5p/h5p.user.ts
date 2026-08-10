import type { IUser } from '@lumieducation/h5p-server';

/**
 * The `IUser` every H5P library call is handed on behalf of an authenticated
 * caller.
 *
 * The library's permission system is `LaissezFairePermissionSystem`
 * (`h5p.module.ts`), so this object decides nothing: authorization is the
 * route's `@Roles('editor')`, per CLAUDE.md rule 8. What it *does* decide is
 * the owner prefix a temporary file is stored under, which is why the id is the
 * caller's own uid and never anything derived from a request body.
 *
 * `email` is threaded through because the editor model echoes it back in
 * `integration.user` — the caller's own identity and nobody else's — and `name`
 * is empty because nothing in this product has one to give.
 *
 * One definition rather than one per service: two of these that disagreed about
 * `id` would silently split one editor's temporary files across two prefixes.
 */
export function h5pUserFor(uid: string, email?: string): IUser {
  return { id: uid, email: email ?? '', name: '', type: 'local' };
}
