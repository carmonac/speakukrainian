import { Component, inject, signal, type WritableSignal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { FormsModule, NgModel } from '@angular/forms';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { beforeEach, describe, expect, it } from 'vitest';
import type { LocaleCode, RichText } from '@speakukrainian/shared';
import { LocalesStore } from '../../core/locales/locales.store';
import { LocalizedRichTextEditor } from './localized-rich-text-editor';
import { RichTextEditor } from './rich-text-editor';

/**
 * Feature forms bind the editor's tab strip to `LocalesStore.codes()`, so this
 * is where "a locale added on the locales screen shows up as a tab" is proven.
 */
@Component({
  selector: 'app-locales-editor-host',
  imports: [FormsModule, LocalizedRichTextEditor],
  template: `
    <app-localized-rich-text-editor
      [locales]="store.codes()"
      [ngModel]="value()"
      (ngModelChange)="emitted.set($event)"
    />
  `,
})
class EditorHost {
  protected readonly store = inject(LocalesStore);
  readonly value = signal<RichText>({});
  readonly emitted = signal<RichText | null>(null);
}

function tabLabels(fixture: ComponentFixture<EditorHost>): string[] {
  const root = fixture.nativeElement as HTMLElement;
  return Array.from(
    root.querySelectorAll<HTMLElement>('[role="tab"]'),
    (tab) => tab.textContent?.trim() ?? '',
  );
}

describe('LocalizedRichTextEditor', () => {
  let codes: WritableSignal<LocaleCode[]>;
  let fixture: ComponentFixture<EditorHost>;

  beforeEach(() => {
    codes = signal<LocaleCode[]>(['en', 'es', 'uk']);
    TestBed.configureTestingModule({
      providers: [
        provideNoopAnimations(),
        { provide: LocalesStore, useValue: { codes } as unknown as LocalesStore },
      ],
    });
    fixture = TestBed.createComponent(EditorHost);
    fixture.detectChanges();
  });

  it('renders one tab per enabled locale, in store order', () => {
    expect(tabLabels(fixture)).toEqual(['EN', 'ES', 'UK']);
  });

  it('adds a tab when a locale is added to the store', () => {
    codes.set(['en', 'es', 'uk', 'pl']);
    fixture.detectChanges();

    expect(tabLabels(fixture)).toEqual(['EN', 'ES', 'UK', 'PL']);
  });

  it('drops the tab of a disabled locale without dropping its text', async () => {
    fixture.componentInstance.value.set({ en: 'Hello', es: 'Hola' });
    fixture.detectChanges();
    // `ngModel` writes through on a microtask, not during change detection.
    await fixture.whenStable();

    codes.set(['en']);
    fixture.detectChanges();
    expect(tabLabels(fixture)).toEqual(['EN']);

    // Editing what is left must not quietly rewrite the value without the
    // locale that just lost its tab — the content is still in Firestore.
    const inner = fixture.debugElement.query(By.directive(RichTextEditor));
    inner.injector.get(NgModel).viewToModelUpdate('<p>Hi</p>');
    fixture.detectChanges();

    expect(fixture.componentInstance.emitted()).toEqual({ en: '<p>Hi</p>', es: 'Hola' });
  });
});
