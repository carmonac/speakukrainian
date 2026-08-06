import { FormControl } from '@angular/forms';
import { describe, expect, it } from 'vitest';
import { slugValidator } from './section-validators';
import { slugify } from './slug';

describe('slugify', () => {
  it('kebab-cases a plain title', () => {
    expect(slugify('Present Simple')).toBe('present-simple');
  });

  it('folds accents rather than dropping the letters they sit on', () => {
    expect(slugify('Café & Crème')).toBe('cafe-creme');
  });

  it('trims the separators a messy title leaves at the ends', () => {
    expect(slugify('  --Hello--World-- ')).toBe('hello-world');
  });

  it('caps a long title without leaving a trailing hyphen', () => {
    // A naive slice lands mid-separator, and `slugSchema` refuses a slug that
    // ends in one — so the suggestion would be unsaveable.
    const suggestion = slugify(`${'ab '.repeat(40)}tail`);

    expect(suggestion.length).toBeLessThanOrEqual(80);
    expect(suggestion.endsWith('-')).toBe(false);
    expect(slugValidator(new FormControl(suggestion))).toBeNull();
  });

  it('suggests nothing for a title in a script it cannot transliterate', () => {
    expect(slugify('Привіт')).toBe('');
  });
});
