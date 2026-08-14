import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import type { Env } from '../config/configuration.js';
import { securityHeaders } from './security-headers.js';

/** Every header the middleware set, and whether it called `next`. */
function headersFor(nodeEnv: Env['NODE_ENV']): Record<string, string> {
  const headers: Record<string, string> = {};
  const response = {
    setHeader(name: string, value: string): void {
      headers[name] = value;
    },
    removeHeader(name: string): void {
      delete headers[name];
    },
    getHeader(name: string): string | undefined {
      return headers[name];
    },
  };

  let reached = false;
  securityHeaders(nodeEnv)({} as IncomingMessage, response as unknown as ServerResponse, () => {
    reached = true;
  });
  if (!reached) {
    throw new Error('the security headers middleware did not call next()');
  }

  return headers;
}

describe('securityHeaders', () => {
  it('leaves cross-origin resource policy at same-origin, which the H5P asset routes override', () => {
    // **This is what makes the global default explicit**, so that the per-route
    // `cross-origin` asserted in the H5P e2e is an override of something rather
    // than a header nobody would have contradicted. It fails if a helmet
    // upgrade changes the default, which is the change that would silently
    // widen or narrow what a browser may load from this API.
    expect(headersFor('development')['Cross-Origin-Resource-Policy']).toBe('same-origin');
  });

  it('keeps the two headers that are irrelevant to H5P at their defaults', () => {
    // Named so that nobody "fixes" them while chasing a cross-origin problem:
    // the editor's iframe is srcless, and this API serves no top-level document.
    const headers = headersFor('development');

    expect(headers['Cross-Origin-Opener-Policy']).toBe('same-origin');
    expect(headers['X-Frame-Options']).toBe('SAMEORIGIN');
  });

  it('sets no embedder policy, because the public site embeds H5P iframes from here', () => {
    expect(headersFor('production')).not.toHaveProperty('Cross-Origin-Embedder-Policy');
  });

  it('sets a content security policy only in production', () => {
    expect(headersFor('development')).not.toHaveProperty('Content-Security-Policy');
    expect(headersFor('test')).not.toHaveProperty('Content-Security-Policy');
    expect(headersFor('production')['Content-Security-Policy']).toContain("default-src 'self'");
  });

  it('still sets the headers every response wants', () => {
    // Otherwise "no CSP outside production" above could be passing because the
    // middleware does nothing at all.
    expect(headersFor('development')['X-Content-Type-Options']).toBe('nosniff');
  });
});
