import { describe, expect, it } from 'vitest';
import { resolveLocalized } from './common.js';
import type { LocalizedText, RichText } from './common.js';

describe('resolveLocalized', () => {
  const value: LocalizedText = { en: 'Hello', uk: 'Привіт' };

  it('returns the requested locale', () => {
    expect(resolveLocalized(value, 'uk', 'en')).toBe('Привіт');
  });

  it('falls back to the default locale when the requested key is absent', () => {
    expect(resolveLocalized(value, 'es', 'en')).toBe('Hello');
  });

  it('treats an empty string as a missing translation', () => {
    // The localized editor writes a key for every tab the author opens, so this
    // is the ordinary shape of half-translated content — ADR-009.
    expect(resolveLocalized({ en: 'Hello', es: '' }, 'es', 'en')).toBe('Hello');
  });

  it('treats a whitespace-only string as a missing translation', () => {
    expect(resolveLocalized({ en: 'Hello', es: '   \n ' }, 'es', 'en')).toBe('Hello');
  });

  it('returns an empty string when neither locale is present', () => {
    expect(resolveLocalized({ uk: 'Привіт' }, 'es', 'en')).toBe('');
  });

  it('returns an empty string for an undefined value', () => {
    expect(resolveLocalized(undefined, 'en', 'en')).toBe('');
  });

  it('returns an empty string for a null value', () => {
    expect(resolveLocalized(null, 'en', 'en')).toBe('');
  });

  it('returns an empty string when the requested locale is the blank default', () => {
    expect(resolveLocalized({ en: '' }, 'en', 'en')).toBe('');
  });

  it('resolves rich text with the same rules', () => {
    const body: RichText = { en: '<p>Hi</p>' };
    expect(resolveLocalized(body, 'uk', 'en')).toBe('<p>Hi</p>');
  });
});
