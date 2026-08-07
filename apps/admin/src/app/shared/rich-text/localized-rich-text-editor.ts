import { Component, forwardRef, input, output, signal } from '@angular/core';
import { FormsModule, NG_VALUE_ACCESSOR, type ControlValueAccessor } from '@angular/forms';
import { MatTabsModule } from '@angular/material/tabs';
import type { AssetRef, LocaleCode, RichText } from '@speakukrainian/shared';
import { RichTextEditor } from './rich-text-editor';

/**
 * Edits one {@link RichText} value across every enabled locale, one tab per
 * locale. Content models are localized end to end, so this — not the bare
 * {@link RichTextEditor} — is what feature forms bind to.
 */
@Component({
  selector: 'app-localized-rich-text-editor',
  imports: [FormsModule, MatTabsModule, RichTextEditor],
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => LocalizedRichTextEditor),
      multi: true,
    },
  ],
  template: `
    <mat-tab-group
      [selectedIndex]="selectedIndex()"
      (selectedIndexChange)="selectedIndex.set($event)"
    >
      @for (locale of locales(); track locale) {
        <mat-tab [label]="locale.toUpperCase()">
          <app-rich-text-editor
            [placeholder]="placeholder()"
            [inlineOnly]="inlineOnly()"
            [disabled]="disabled()"
            [ngModel]="valueFor(locale)"
            (ngModelChange)="updateLocale(locale, $event)"
            (assetInserted)="assetInserted.emit($event)"
          />
        </mat-tab>
      }
    </mat-tab-group>
  `,
})
export class LocalizedRichTextEditor implements ControlValueAccessor {
  /** Enabled locale codes, in display order. Supplied by the locales store. */
  readonly locales = input.required<LocaleCode[]>();
  readonly placeholder = input('');
  readonly inlineOnly = input(false);

  /**
   * Forwarded from whichever tab's editor inserted it. The locale is
   * deliberately not carried: an asset is identified by its storage path or its
   * URL, and a form deriving what the content references reads every locale
   * anyway.
   */
  readonly assetInserted = output<AssetRef>();

  protected readonly selectedIndex = signal(0);
  protected readonly value = signal<RichText>({});
  protected readonly disabled = signal(false);

  private onChange: (value: RichText) => void = () => {};
  private onTouched: () => void = () => {};

  /**
   * An untranslated tab is empty, never the default locale's text: ADR-009's
   * fallback governs rendering, and applying it here would have the author
   * "translate" a copy of text already stored under another locale.
   */
  protected valueFor(locale: LocaleCode): string {
    return this.value()[locale] ?? '';
  }

  writeValue(value: RichText | null): void {
    this.value.set(value ?? {});
  }

  registerOnChange(fn: (value: RichText) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  /**
   * Forwarded to every tab's editor. Without this a disabled control would
   * still be typeable — the wrapper is the only value accessor the form sees,
   * so a `setDisabledState` it swallows never reaches ProseMirror.
   */
  setDisabledState(isDisabled: boolean): void {
    this.disabled.set(isDisabled);
  }

  protected updateLocale(locale: LocaleCode, content: string): void {
    const next = { ...this.value(), [locale]: content };
    this.value.set(next);
    this.onChange(next);
    this.onTouched();
  }
}
