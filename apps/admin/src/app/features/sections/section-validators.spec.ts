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
   * The validator reads its sibling `type`, so it has to run inside a group —
   * and re-run once the group exists: a control validates at construction, when
   * it has no parent to read yet.
   */
  function group(type: 'internal' | 'external', href: string): FormGroup {
    const form = new FormGroup({
      type: new FormControl(type),
      href: new FormControl(href, linkHrefValidator),
    });
    form.get('href')?.updateValueAndValidity();
    return form;
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
    expect(linkHrefValidator(new FormControl(''))).toBeNull();
    expect(linkHrefValidator(new FormControl(null))).toBeNull();
  });

  it('re-decides when the sibling type changes', () => {
    const form = group('internal', 'https://example.com');
    expect(hrefOf(form).errors).toEqual({ href: true });

    form.get('type')?.setValue('external');
    hrefOf(form).updateValueAndValidity();

    expect(hrefOf(form).errors).toBeNull();
  });

  it('treats a target with no sibling type as internal', () => {
    // A control outside a group has no type to read, and the safer default is
    // the one that cannot send a reader off the site.
    expect(linkHrefValidator(new FormControl('/grammar'))).toBeNull();
    expect(linkHrefValidator(new FormControl('https://example.com'))).toEqual({ href: true });
  });
});
