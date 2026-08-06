import type { AbstractControl, ValidationErrors, ValidatorFn } from '@angular/forms';
import type { LocaleCode, LocalizedText, RichText } from '@speakukrainian/shared';

/**
 * Turns the editor's HTML into the plain text a `localizedTextSchema` field
 * stores. `title` and `image.alt` are plain text: the API sanitizes only
 * `description` (ADR-003, `SectionsService`), and they render into a menu, a
 * breadcrumb and the browser tab, where markup cannot go.
 *
 * Every key is mapped, including one whose text is empty: `{ en: 'Hello', uk: '' }`
 * is what half-translated content looks like (ADR-009), so a tab the author
 * opened and left blank is kept rather than pruned.
 */
export function toPlainLocalized(value: RichText | null | undefined): LocalizedText {
  const plain: LocalizedText = {};
  for (const [locale, html] of Object.entries(value ?? {})) {
    plain[locale] = htmlToPlainText(html);
  }
  return plain;
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
