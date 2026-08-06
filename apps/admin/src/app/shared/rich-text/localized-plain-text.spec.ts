import { FormControl } from '@angular/forms';
import { describe, expect, it } from 'vitest';
import { fromPlainLocalized, localizedRequired, toPlainLocalized } from './localized-plain-text';

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

describe('fromPlainLocalized', () => {
  it('escapes text the editor would otherwise parse as markup', () => {
    expect(fromPlainLocalized({ en: 'Modal verbs <can>' })).toEqual({
      en: 'Modal verbs &lt;can&gt;',
    });
  });

  it('maps every key, including a locale left blank', () => {
    expect(fromPlainLocalized({ en: 'Hi', uk: '' })).toEqual({ en: 'Hi', uk: '' });
  });

  it('answers with an empty record for a value that was never stored', () => {
    expect(fromPlainLocalized(null)).toEqual({});
    expect(fromPlainLocalized(undefined)).toEqual({});
  });

  // Anything this form has written round-trips byte for byte, which is what
  // makes opening a stored section and pressing Save with no edit safe. That
  // holds for every character the write side keeps — the exception is
  // whitespace, pinned by the two cases below.
  it.each([
    ['a tag-shaped title', 'Modal verbs <can>'],
    ['a bare ampersand', 'Tom & Jerry'],
    ['a greater-than sign', 'a > b'],
    ['text that already looks escaped', 'Tom &amp; Jerry &lt;3'],
    ['an unbalanced angle bracket', 'Use < for less than'],
  ])('round-trips %s unchanged', (_name, text) => {
    expect(toPlainLocalized(fromPlainLocalized({ en: text }))).toEqual({ en: text });
  });

  it('collapses whitespace no author could have typed here in the first place', () => {
    // Only content written by something other than this form — a seed script,
    // a direct API call — can carry it, because the write side collapses too.
    expect(toPlainLocalized(fromPlainLocalized({ en: 'Present  Simple\ttab\nnewline' }))).toEqual({
      en: 'Present Simple tab newline',
    });
  });

  it('is idempotent, so a second save stores what the first one did', () => {
    // The property the seam actually offers, and the one #6 and #9 can rely on:
    // one pass normalizes, every pass after that is a no-op. The ampersand is
    // there so an escape that ran twice would drift instead of settling.
    const once = toPlainLocalized(fromPlainLocalized({ en: 'Tom &  Jerry\ttab' }));

    expect(once).toEqual({ en: 'Tom & Jerry tab' });
    expect(toPlainLocalized(fromPlainLocalized(once))).toEqual(once);
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
