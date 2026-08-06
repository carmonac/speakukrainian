import { FormControl } from '@angular/forms';
import { describe, expect, it } from 'vitest';
import { localizedRequired, toPlainLocalized } from './localized-plain-text';

describe('toPlainLocalized', () => {
  it('decodes entities rather than storing them', () => {
    // The API deliberately does not sanitize `title`, so an escaped ampersand
    // would be stored and rendered as `&amp;` in menus and the browser tab.
    expect(toPlainLocalized({ en: '<p>Tom &amp; Jerry</p>' })).toEqual({ en: 'Tom & Jerry' });
  });

  it('joins block elements with a space', () => {
    expect(toPlainLocalized({ en: '<p>Present</p><p>Simple</p>' })).toEqual({
      en: 'Present Simple',
    });
  });

  it('drops script and style content', () => {
    expect(
      toPlainLocalized({ en: '<p>Grammar</p><script>alert(1)</script><style>p{}</style>' }),
    ).toEqual({ en: 'Grammar' });
  });

  it('keeps a tab the author opened and left blank', () => {
    // ADR-009: `{ en: 'Hi', uk: '' }` is what half-translated content looks
    // like, so pruning the empty key would lose that distinction.
    expect(toPlainLocalized({ en: '<p>Hi</p>', uk: '' })).toEqual({ en: 'Hi', uk: '' });
  });

  it('collapses the whitespace the editor lays out its markup with', () => {
    expect(toPlainLocalized({ en: '<p>  Present   simple\n</p>' })).toEqual({
      en: 'Present simple',
    });
  });

  it('handles a bare-text value that has no elements at all', () => {
    expect(toPlainLocalized({ en: 'Listening' })).toEqual({ en: 'Listening' });
  });

  it('answers with an empty record for a value that was never set', () => {
    expect(toPlainLocalized(null)).toEqual({});
    expect(toPlainLocalized(undefined)).toEqual({});
  });
});

describe('localizedRequired', () => {
  it('errors on a blank default-locale tab even when another locale has text', () => {
    const validate = localizedRequired('en');

    expect(validate(new FormControl({ en: '<p></p>', uk: '<p>Привіт</p>' }))).toEqual({
      required: true,
    });
    expect(validate(new FormControl({}))).toEqual({ required: true });
  });

  it('passes once the default locale has text', () => {
    expect(localizedRequired('en')(new FormControl({ en: '<p>Grammar</p>' }))).toBeNull();
  });

  it('does not block authoring when the locales list failed to load', () => {
    expect(localizedRequired(null)(new FormControl({}))).toBeNull();
  });
});
