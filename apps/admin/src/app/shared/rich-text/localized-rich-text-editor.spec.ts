import { Component, inject, signal, type WritableSignal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { FormsModule, NgModel } from '@angular/forms';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AssetRef, LocaleCode, RichText } from '@speakukrainian/shared';
import { LocalesStore } from '../../core/locales/locales.store';
import { MediaPickerService } from '../media/media-picker.service';
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
      [disabled]="locked()"
      [ngModel]="value()"
      (ngModelChange)="emitted.set($event)"
      (assetInserted)="inserted.set($event)"
    />
  `,
})
class EditorHost {
  protected readonly store = inject(LocalesStore);
  readonly value = signal<RichText>({});
  readonly emitted = signal<RichText | null>(null);
  readonly inserted = signal<AssetRef | null>(null);
  readonly locked = signal(false);
}

const CLIP: AssetRef = {
  path: 'audio/2026/01/hello.mp3',
  url: 'https://cdn.test/audio/2026/01/hello.mp3',
  contentType: 'audio/mpeg',
  sizeBytes: 12_345,
};

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
        {
          provide: MediaPickerService,
          useValue: {
            pickAudio: () => Promise.resolve(CLIP),
            pickImage: () => Promise.resolve(null),
          } as unknown as MediaPickerService,
        },
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

  it('forwards the inserted asset out of the tab that inserted it', async () => {
    // `contentType` and `sizeBytes` exist nowhere in the serialized HTML, so a
    // form that has to record them has only this output to learn them from.
    // Without the forwarding every newly inserted clip is dropped on save.
    const root = fixture.nativeElement as HTMLElement;
    // The tooltip is not in the DOM until the button is hovered, so the Insert
    // audio button is found by the icon ligature it renders.
    const audio = Array.from(root.querySelectorAll<HTMLButtonElement>('.rte__toolbar button')).find(
      (entry) => entry.textContent?.trim() === 'volume_up',
    );
    if (audio === undefined) {
      throw new Error('Expected an Insert audio button in the toolbar');
    }

    audio.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.componentInstance.inserted()).toEqual(CLIP);
  });

  it('passes a disabled control down to the tab’s editor', async () => {
    // The wrapper is the only value accessor the form sees, so a
    // `setDisabledState` it swallows would leave a disabled control typeable.
    const contentEditable = (): string | null =>
      (fixture.nativeElement as HTMLElement)
        .querySelector('.rte__content .ProseMirror')
        ?.getAttribute('contenteditable') ?? null;

    expect(contentEditable()).toBe('true');

    fixture.componentInstance.locked.set(true);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(contentEditable()).toBe('false');
  });
});
