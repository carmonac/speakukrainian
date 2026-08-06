import { FormControl, FormGroup, type AbstractControl } from '@angular/forms';
import { describe, expect, it } from 'vitest';
import { linkHrefValidator, slugValidator, sortOrderValidator } from './section-validators';

describe('slugValidator', () => {
  it('accepts a kebab-case slug', () => {
    expect(slugValidator(new FormControl('present-simple'))).toBeNull();
  });

  it('rejects what slugSchema rejects, without restating its regex', () => {
    expect(slugValidator(new FormControl('Not Kebab'))).toEqual({ slug: true });
    expect(slugValidator(new FormControl(''))).toEqual({ slug: true });
    expect(slugValidator(new FormControl('trailing-'))).toEqual({ slug: true });
    expect(slugValidator(new FormControl('a'.repeat(81)))).toEqual({ slug: true });
  });
});

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
    // that means "append after the last sibling".
    expect(sortOrderValidator(new FormControl(null))).toBeNull();
    expect(sortOrderValidator(new FormControl(''))).toBeNull();
  });
});

describe('linkHrefValidator', () => {
  /**
   * The type reaches the validator through the getter the form passes it, so a
   * group here is only what makes the two controls move together — the same
   * arrangement the form has.
   */
  function group(type: 'internal' | 'external', href: string): FormGroup {
    const typeControl = new FormControl(type, { nonNullable: true });
    return new FormGroup({
      type: typeControl,
      href: new FormControl(
        href,
        linkHrefValidator(() => typeControl.value),
      ),
    });
  }

  function hrefOf(form: FormGroup): AbstractControl {
    const control = form.get('href');
    if (control === null) {
      throw new Error('Expected an href control');
    }
    return control;
  }

  it('accepts a site path for an internal target and an absolute URL for an external one', () => {
    expect(hrefOf(group('internal', '/grammar-points')).errors).toBeNull();
    expect(hrefOf(group('external', 'https://example.com/x')).errors).toBeNull();
  });

  it('rejects each shape under the other target type', () => {
    expect(hrefOf(group('internal', 'https://example.com')).errors).toEqual({ href: true });
    expect(hrefOf(group('external', '/grammar-points')).errors).toEqual({ href: true });
  });

  it('rejects what linkTargetSchema rejects, without restating its rule', () => {
    // `//evil.com` looks like a path and leaves the site.
    expect(hrefOf(group('internal', '//evil.com')).errors).toEqual({ href: true });
    expect(hrefOf(group('external', 'javascript:alert(1)')).errors).toEqual({ href: true });
    expect(hrefOf(group('external', 'ftp://x.test')).errors).toEqual({ href: true });
  });

  it('leaves an empty field to Validators.required', () => {
    const validator = linkHrefValidator(() => 'internal');

    expect(validator(new FormControl(''))).toBeNull();
    expect(validator(new FormControl(null))).toBeNull();
  });

  it('re-decides when the sibling type changes', () => {
    const form = group('internal', 'https://example.com');
    expect(hrefOf(form).errors).toEqual({ href: true });

    form.get('type')?.setValue('external');
    hrefOf(form).updateValueAndValidity();

    expect(hrefOf(form).errors).toBeNull();
  });

  it('takes the target type from the getter it was built with, not from the control tree', () => {
    // A detached control: nothing to read a sibling off, and the validator does
    // not need one — which is what removes the unwritten "assume internal".
    const href = new FormControl('https://example.com');

    expect(linkHrefValidator(() => 'external')(href)).toBeNull();
    expect(linkHrefValidator(() => 'internal')(href)).toEqual({ href: true });
  });
});
