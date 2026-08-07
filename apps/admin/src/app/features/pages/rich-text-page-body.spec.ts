import { Component, signal, type DebugElement } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { FormControl, NgModel, ReactiveFormsModule } from '@angular/forms';
import { By } from '@angular/platform-browser';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AssetRef, LocaleCode, PageBody } from '@speakukrainian/shared';
import { LocalesStore } from '../../core/locales/locales.store';
import { MediaPickerService } from '../../shared/media/media-picker.service';
import { RichTextEditor } from '../../shared/rich-text/rich-text-editor';
import { RichTextPageBody, emptyRichTextBody } from './rich-text-page-body';

const EN = 0;
const UK = 1;

const CLIP: AssetRef = {
  path: 'audio/2026/01/hello.mp3',
  url: 'https://cdn.test/audio/2026/01/hello.mp3',
  contentType: 'audio/mpeg',
  sizeBytes: 12_345,
};

const audioHtml = `<audio src="${CLIP.url}" data-asset-path="${CLIP.path}" controls="true"></audio>`;

/**
 * The shell's seam, exactly: one `FormControl<PageBody>` the body component
 * drives through `NG_VALUE_ACCESSOR` and judges through `NG_VALIDATORS`.
 */
@Component({
  selector: 'app-body-host',
  imports: [ReactiveFormsModule, RichTextPageBody],
  template: `<app-rich-text-page-body [formControl]="body" />`,
})
class BodyHost {
  readonly body = new FormControl<PageBody>(emptyRichTextBody(), { nonNullable: true });
}

describe('RichTextPageBody', () => {
  let fixture: ComponentFixture<BodyHost>;
  let picked: AssetRef | null;

  beforeEach(() => {
    picked = null;
    TestBed.configureTestingModule({
      providers: [
        provideNoopAnimations(),
        {
          provide: LocalesStore,
          useValue: {
            codes: signal<LocaleCode[]>(['en', 'uk']).asReadonly(),
            defaultCode: signal<LocaleCode | null>('en').asReadonly(),
          } as unknown as LocalesStore,
        },
        {
          provide: MediaPickerService,
          useValue: {
            pickAudio: () => Promise.resolve(picked),
            pickImage: () => Promise.resolve(picked),
          } as unknown as MediaPickerService,
        },
      ],
    });
    fixture = TestBed.createComponent(BodyHost);
    fixture.detectChanges();
  });

  function root(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  /** Selects a locale tab and answers with the single editor behind it. */
  async function localeTab(index: number): Promise<DebugElement> {
    const tabs = root().querySelectorAll<HTMLElement>('[role="tab"]');
    const tab = tabs[index];
    if (!tab) {
      throw new Error(`Expected a tab at index ${index}`);
    }
    tab.click();
    for (let pass = 0; pass < 2; pass += 1) {
      fixture.detectChanges();
      await fixture.whenStable();
    }
    fixture.detectChanges();

    const editor = fixture.debugElement.query(By.directive(RichTextEditor));
    if (!editor) {
      throw new Error('Expected the active tab to hold an editor');
    }
    return editor;
  }

  async function typeInto(index: number, html: string): Promise<void> {
    const editor = await localeTab(index);
    editor.injector.get(NgModel).viewToModelUpdate(html);
    fixture.detectChanges();
  }

  async function renderedHtml(index: number): Promise<string> {
    const editor = (await localeTab(index)).nativeElement as HTMLElement;
    return editor.querySelector('.rte__content')?.innerHTML ?? '';
  }

  function value(): PageBody {
    return fixture.componentInstance.body.value;
  }

  function richText(): Extract<PageBody, { type: 'rich_text' }> {
    const body = value();
    if (body.type !== 'rich_text') {
      throw new Error(`Expected a rich_text body, got ${body.type}`);
    }
    return body;
  }

  it('renders a stored body’s content in the locale that holds it', async () => {
    fixture.componentInstance.body.setValue({
      type: 'rich_text',
      content: { uk: '<p>Привіт</p>' },
      audioAssets: [],
      imageAssets: [],
    });
    fixture.detectChanges();

    expect(await renderedHtml(UK)).toContain('Привіт');
    expect(await renderedHtml(EN)).not.toContain('Привіт');
  });

  it('renders nothing for a body of another type', async () => {
    // #10 and #13 own those; this editor showing their content would be a lie
    // about what a save would write.
    fixture.componentInstance.body.setValue({
      type: 'subsection_list',
      layout: 'grid',
      showImages: true,
      showDescriptions: true,
      intro: { en: '<p>Lead-in</p>' },
    });
    fixture.detectChanges();

    expect(await renderedHtml(EN)).not.toContain('Lead-in');
  });

  it('changes only the locale being edited', async () => {
    fixture.componentInstance.body.setValue({
      type: 'rich_text',
      content: { en: '<p>English</p>' },
      audioAssets: [],
      imageAssets: [],
    });
    fixture.detectChanges();

    await typeInto(UK, '<p>Українська</p>');

    expect(richText().content).toEqual({ en: '<p>English</p>', uk: '<p>Українська</p>' });
  });

  it('records an inserted clip once the content refers to it', async () => {
    picked = CLIP;
    const editor = (await localeTab(UK)).nativeElement as HTMLElement;
    const audio = Array.from(
      editor.querySelectorAll<HTMLButtonElement>('.rte__toolbar button'),
    ).find((entry) => entry.textContent?.trim() === 'volume_up');
    if (audio === undefined) {
      throw new Error('Expected an Insert audio button');
    }

    audio.click();
    await fixture.whenStable();
    fixture.detectChanges();

    // The insert writes the node through ProseMirror, which emits the HTML back
    // through the same `ngModelChange` a keystroke would.
    expect(richText().audioAssets).toEqual([CLIP]);
    expect(richText().content['uk']).toContain(CLIP.path);
  });

  it('drops a clip the author removed from the content', async () => {
    fixture.componentInstance.body.setValue({
      type: 'rich_text',
      content: { uk: audioHtml },
      audioAssets: [CLIP],
      imageAssets: [],
    });
    fixture.detectChanges();

    await typeInto(UK, '<p>Gone</p>');

    expect(richText().audioAssets).toEqual([]);
  });

  it('keeps a stored clip when another locale is edited', async () => {
    // Seeding on `writeValue` is what stops an edit elsewhere on the page from
    // wiping the index for a clip inserted in an earlier session.
    fixture.componentInstance.body.setValue({
      type: 'rich_text',
      content: { uk: audioHtml },
      audioAssets: [CLIP],
      imageAssets: [],
    });
    fixture.detectChanges();

    await typeInto(EN, '<p>An English version</p>');

    expect(richText().audioAssets).toEqual([CLIP]);
  });

  it('accepts empty content: a page may be created now and written later', () => {
    expect(fixture.componentInstance.body.valid).toBe(true);
  });

  it('rejects a body the schema would refuse', () => {
    // `url` is a `z.url()`, so this is what a hand-edited or corrupt asset entry
    // looks like. The shell only asks `form.invalid`; deciding this here is what
    // keeps the rule with the body it belongs to.
    fixture.componentInstance.body.setValue({
      type: 'rich_text',
      content: {},
      audioAssets: [{ ...CLIP, url: 'not-a-url' }],
      imageAssets: [],
    });
    fixture.detectChanges();

    expect(fixture.componentInstance.body.valid).toBe(false);
    expect(fixture.componentInstance.body.errors).toEqual({ body: true });
  });

  it('stops accepting edits when the control is disabled', async () => {
    fixture.componentInstance.body.disable();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(
      root().querySelector('.rte__content .ProseMirror')?.getAttribute('contenteditable'),
    ).toBe('false');
  });
});
