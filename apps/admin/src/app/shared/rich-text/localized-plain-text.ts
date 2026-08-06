import type { AbstractControl, ValidationErrors, ValidatorFn } from '@angular/forms';
import type { LocaleCode, LocalizedText, RichText } from '@speakukrainian/shared';

/**
 * The two halves of the seam between `LocalizedRichTextEditor`, which is the
 * only text control the product allows (rule 3), and a `localizedTextSchema`
 * field, which stores plain text. A section's `title` and an image's `alt`
 * render into a menu, a breadcrumb and the browser tab, where markup cannot go,
 * and the API sanitizes only `description` (ADR-003, `SectionsService`) — so
 * the conversion happens here, and it has to happen in both directions.
 *
 * Both halves map every key, including one whose text is empty:
 * `{ en: 'Hello', uk: '' }` is what half-translated content looks like
 * (ADR-009), so a tab the author opened and left blank is kept rather than
 * pruned.
 */

/** Editor HTML → the plain text that gets stored. */
export function toPlainLocalized(value: RichText | null | undefined): LocalizedText {
  const plain: LocalizedText = {};
  for (const [locale, html] of Object.entries(value ?? {})) {
    plain[locale] = htmlToPlainText(html);
  }
  return plain;
}

/**
 * Stored plain text → the HTML the editor is handed.
 *
 * Without this the editor parses stored text as markup, so a title reading
 * `Modal verbs <can>` opens as `Modal verbs ` and the next save — with no edit
 * at all — writes that truncation back over the author's text.
 */
export function fromPlainLocalized(value: LocalizedText | null | undefined): RichText {
  const html: RichText = {};
  for (const [locale, text] of Object.entries(value ?? {})) {
    html[locale] = escapeHtml(text);
  }
  return html;
}

/**
 * `&` first: escaping it last would re-escape the ampersands of the entities
 * this function has just written, and `a < b` would come back as `a &lt; b`.
 */
function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * Requires text in the default locale's tab. A `null` default code means the
 * locales list failed to load, which is no reason to block authoring.
 */
export function localizedRequired(defaultCode: LocaleCode | null): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    if (defaultCode === null) {
      return null;
    }
    const plain = toPlainLocalized(control.value as RichText | null)[defaultCode] ?? '';
    return plain.length > 0 ? null : { required: true };
  };
}

function htmlToPlainText(html: string): string {
  // Constructed per call, never at module scope: the admin is browser-only, but
  // module-scope DOM access is the habit rule 6 is about.
  const document = new DOMParser().parseFromString(html, 'text/html');
  for (const element of document.body.querySelectorAll('script, style')) {
    element.remove();
  }

  // Block elements are joined with a space so two paragraphs do not run into
  // one word. A value with no element children is bare text, which the body
  // itself carries.
  const blocks = Array.from(document.body.children, (child) => child.textContent ?? '');
  const text = blocks.length > 0 ? blocks.join(' ') : (document.body.textContent ?? '');
  return text.replace(/\s+/g, ' ').trim();
}
