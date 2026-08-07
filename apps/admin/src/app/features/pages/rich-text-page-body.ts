import { Component, forwardRef, inject, signal } from '@angular/core';
import {
  FormsModule,
  NG_VALIDATORS,
  NG_VALUE_ACCESSOR,
  type AbstractControl,
  type ControlValueAccessor,
  type ValidationErrors,
  type Validator,
} from '@angular/forms';
import {
  richTextPageBodySchema,
  type AssetRef,
  type PageBody,
  type RichText,
} from '@speakukrainian/shared';
import { LocalesStore } from '../../core/locales/locales.store';
import { LocalizedRichTextEditor } from '../../shared/rich-text/localized-rich-text-editor';
import { PageAssetTracker } from './page-assets';

/**
 * The `rich_text` half of the page form: one editor per locale, with the audio
 * and image buttons that are the point of this product.
 *
 * It is a `ControlValueAccessor` **and** a `Validator` over the shell's single
 * `FormControl<PageBody>`, so everything type-specific — the value's shape, the
 * derived asset arrays, and what makes this body invalid — stays behind that one
 * control. The shell decides *whether* Save is enabled; this decides *why* its
 * own value is not valid.
 */
@Component({
  selector: 'app-rich-text-page-body',
  imports: [FormsModule, LocalizedRichTextEditor],
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => RichTextPageBody),
      multi: true,
    },
    {
      provide: NG_VALIDATORS,
      useExisting: forwardRef(() => RichTextPageBody),
      multi: true,
    },
  ],
  template: `
    <app-localized-rich-text-editor
      class="rich-text-body__editor"
      [locales]="locales()"
      [disabled]="disabled()"
      [ngModel]="content()"
      (ngModelChange)="onContent($event)"
      (assetInserted)="remember($event)"
    />
  `,
})
export class RichTextPageBody implements ControlValueAccessor, Validator {
  /**
   * Injected rather than taken as an input: one less prop for the other body
   * editors (#10, #13) to keep in sync with the shell.
   */
  protected readonly locales = inject(LocalesStore).codes;

  private readonly tracker = new PageAssetTracker();

  protected readonly content = signal<RichText>({});
  protected readonly disabled = signal(false);

  private onChange: (value: PageBody) => void = () => {};
  private onTouched: () => void = () => {};

  writeValue(value: PageBody | null): void {
    if (value?.type === 'rich_text') {
      this.content.set(value.content);
      // Seeding here is what stops a save that touched only the title from
      // wiping a stored `audioAssets`: the metadata for a clip inserted in an
      // earlier session exists in the stored body and nowhere else.
      this.tracker.seed(value);
    } else {
      this.content.set({});
    }
  }

  registerOnChange(fn: (value: PageBody) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  setDisabledState(isDisabled: boolean): void {
    this.disabled.set(isDisabled);
  }

  /**
   * Reads the control rather than internal state, so the shell's `form.invalid`
   * and this cannot disagree. Empty content is valid: an author may create the
   * page and write it later.
   */
  validate(control: AbstractControl): ValidationErrors | null {
    return richTextPageBodySchema.safeParse(control.value).success ? null : { body: true };
  }

  protected onContent(next: RichText): void {
    this.content.set(next);
    this.onChange({ type: 'rich_text', content: next, ...this.tracker.derive(next) });
    this.onTouched();
  }

  protected remember(asset: AssetRef): void {
    this.tracker.remember(asset);
  }
}

/** The value a brand-new `rich_text` page starts from. */
export function emptyRichTextBody(): PageBody {
  return { type: 'rich_text', content: {}, audioAssets: [], imageAssets: [] };
}
