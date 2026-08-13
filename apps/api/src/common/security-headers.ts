import helmet from 'helmet';
import type { Env } from '../config/configuration.js';

/**
 * The response headers this API sets on **every** route.
 *
 * One function rather than an options object inlined in `main.ts`, because the
 * e2e's `createTestApp` installs the same middleware: what helmet sets is
 * observable — `Cross-Origin-Resource-Policy: same-origin` is the header that
 * decides whether a browser will load a subresource from here — so a test app
 * without it cannot tell "the route sets a header" from "the route beats the
 * global default", and the two bootstraps drifting is exactly what would make
 * that distinction quietly untestable again.
 *
 * **CORP is deliberately left at helmet's `same-origin` here.** The five H5P
 * routes that serve subresources to a page on another origin override it per
 * route with `CROSS_ORIGIN_HEADERS` (`h5p/h5p.responses.ts`); relaxing it
 * globally would relax it for every JSON, media and schedule route for no gain.
 *
 * `Cross-Origin-Opener-Policy` and `X-Frame-Options` are irrelevant to the H5P
 * widget and are left alone on purpose: the editor's iframe is created with no
 * `src` and populated through `contentDocument.write`, so there is no HTTP
 * response for XFO to apply to, and this API never serves a top-level document
 * for COOP to govern.
 */
export function securityHeaders(nodeEnv: Env['NODE_ENV']): ReturnType<typeof helmet> {
  return helmet({
    // The public site embeds H5P iframes served from this origin.
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: nodeEnv === 'production' ? undefined : false,
  });
}
