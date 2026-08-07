import { FormControl } from '@angular/forms';
import { describe, expect, it } from 'vitest';
import { sortOrderValidator } from './page-validators';

describe('sortOrderValidator', () => {
  it('accepts a whole number, negative ones included', () => {
    expect(sortOrderValidator(new FormControl(0))).toBeNull();
    expect(sortOrderValidator(new FormControl(12))).toBeNull();
    expect(sortOrderValidator(new FormControl(-3))).toBeNull();
  });

  it('rejects what the schema rejects, so the API never has to say it', () => {
    expect(sortOrderValidator(new FormControl(1.5))).toEqual({ sortOrder: true });
    expect(sortOrderValidator(new FormControl(Number.NaN))).toEqual({ sortOrder: true });
  });

  it('leaves an empty field to Validators.required', () => {
    // A blank `<input type="number">` reads as `null`, and on the create route
    // that means "append after the last page in this section".
    expect(sortOrderValidator(new FormControl(null))).toBeNull();
    expect(sortOrderValidator(new FormControl(''))).toBeNull();
  });
});
