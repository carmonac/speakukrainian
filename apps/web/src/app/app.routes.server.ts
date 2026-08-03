import { RenderMode, type ServerRoute } from '@angular/ssr';

/**
 * Content lives in Firestore and admins publish at any time, so pages are
 * rendered per request rather than prerendered at build time. Cloud Run caches
 * the resulting HTML at the CDN edge via the `Cache-Control` header set in
 * `server.ts`.
 */
export const serverRoutes: ServerRoute[] = [
  {
    path: '**',
    renderMode: RenderMode.Server,
  },
];
