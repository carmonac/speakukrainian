import { Injectable } from '@nestjs/common';
import createDOMPurify, { type Config } from 'dompurify';
import { JSDOM } from 'jsdom';
import type { RichText } from '@speakukrainian/shared';

/**
 * DOMPurify needs a DOM. One window for the process: building a JSDOM per call
 * costs milliseconds and buys nothing, since `sanitize` keeps no state between
 * calls when the config is passed per call.
 */
const purify = createDOMPurify(new JSDOM('').window);

/**
 * The allow-list is explicit rather than a set of tweaks on DOMPurify's
 * defaults: the defaults keep `<form>`, `<input>` and `<style>`, none of which
 * an author has any reason to write into a lesson.
 *
 * `ALLOW_DATA_ATTR: false` with `data-asset-path` named in `ALLOWED_ATTR` keeps
 * the one data attribute `audio.extension.ts` writes — the storage path behind
 * the clip — and drops every other `data-*` an attacker could smuggle.
 *
 * `ALLOWED_URI_REGEXP` is deliberately not set: DOMPurify's default already
 * blocks `javascript:` and the other script-bearing schemes, and narrowing it
 * further would break the absolute Cloud Storage URLs that media uploads return.
 *
 * `source` is allowed even though `audio.extension.ts` renders `audio[src]` and
 * never a `<source>` today: an `<audio>` whose only child is stripped becomes a
 * silently empty player, and losing a pronunciation clip without a trace is the
 * worst failure this file can have.
 */
const SANITIZE_CONFIG = {
  ALLOWED_TAGS: [
    'p',
    'br',
    'hr',
    'strong',
    'em',
    's',
    'u',
    'code',
    'pre',
    'blockquote',
    'h2',
    'h3',
    'h4',
    'ul',
    'ol',
    'li',
    'a',
    'img',
    'audio',
    'source',
    'figure',
    'figcaption',
    'table',
    'thead',
    'tbody',
    'tfoot',
    'tr',
    'th',
    'td',
  ],
  ALLOWED_ATTR: [
    'href',
    'rel',
    'title',
    'src',
    'alt',
    'type',
    'width',
    'height',
    'controls',
    'preload',
    'data-asset-path',
    'colspan',
    'rowspan',
    'start',
  ],
  ALLOW_DATA_ATTR: false,
} as const satisfies Config;

/**
 * ADR-003: rich text is stored as HTML, and it is sanitized on write. The admin
 * editor sanitizes too, for immediate feedback, but a caller can post straight
 * at the API with a bearer token — so this is the check that counts.
 */
@Injectable()
export class RichTextSanitizer {
  sanitize(html: string): string {
    return purify.sanitize(html, SANITIZE_CONFIG);
  }

  /**
   * Sanitizes every locale of a localized rich text value. Keys are preserved
   * even when the value sanitizes to `''`: ADR-009 treats a blank locale as
   * missing at render time, and dropping the key here would make an author's
   * emptied tab indistinguishable from one that was never opened.
   */
  sanitizeLocalized<T extends RichText | undefined>(value: T): T {
    if (value === undefined) {
      return value;
    }
    return Object.fromEntries(
      Object.entries(value).map(([locale, html]) => [locale, this.sanitize(html)]),
    ) as T;
  }
}
