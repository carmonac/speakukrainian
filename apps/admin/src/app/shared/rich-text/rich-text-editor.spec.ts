import { Component, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { FormsModule } from '@angular/forms';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AssetRef } from '@speakukrainian/shared';
import { MediaPickerService } from '../media/media-picker.service';
import { RichTextEditor } from './rich-text-editor';

const CLIP: AssetRef = {
  path: 'audio/2026/01/hello.mp3',
  url: 'https://cdn.test/audio/2026/01/hello.mp3',
  contentType: 'audio/mpeg',
  sizeBytes: 12_345,
};

const PICTURE: AssetRef = {
  path: 'images/2026/01/map.png',
  url: 'https://cdn.test/images/2026/01/map.png',
  contentType: 'image/png',
  sizeBytes: 2_048,
};

@Component({
  selector: 'app-rte-host',
  imports: [FormsModule, RichTextEditor],
  template: `<app-rich-text-editor [ngModel]="value()" (ngModelChange)="emitted.set($event)" />`,
})
class EditorHost {
  readonly value = signal('');
  readonly emitted = signal<string | null>(null);
}

describe('RichTextEditor', () => {
  let fixture: ComponentFixture<EditorHost>;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideNoopAnimations(),
        {
          provide: MediaPickerService,
          useValue: {
            pickAudio: () => Promise.resolve(CLIP),
            pickImage: () => Promise.resolve(PICTURE),
          } as unknown as MediaPickerService,
        },
      ],
    });
    fixture = TestBed.createComponent(EditorHost);
    fixture.detectChanges();
  });

  function root(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  /**
   * The tooltip is not in the DOM until the button is hovered, so the toolbar
   * buttons are found by the icon ligature they render.
   */
  async function clickToolbar(ligature: string): Promise<void> {
    const button = Array.from(
      root().querySelectorAll<HTMLButtonElement>('.rte__toolbar button'),
    ).find((entry) => entry.textContent?.trim() === ligature);
    if (button === undefined) {
      throw new Error(`Expected a ${ligature} button in the toolbar`);
    }
    button.click();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  async function setContent(value: string): Promise<void> {
    fixture.componentInstance.value.set(value);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  /**
   * Types one character the way the browser delivers it. ProseMirror takes over
   * `keypress` itself whenever the selection is not a text selection inside one
   * textblock — which is exactly what a freshly inserted atom leaves behind —
   * and replaces the selection with the character. With the caret in a text
   * position it defers to the DOM instead, which jsdom does not implement, so
   * the character is not expected to appear here; what matters is what survives.
   */
  function typeCharacter(character: string): void {
    const content = root().querySelector('.ProseMirror');
    if (content === null) {
      throw new Error('Expected the editor to be mounted');
    }
    content.dispatchEvent(
      new KeyboardEvent('keypress', {
        key: character,
        charCode: character.charCodeAt(0),
        bubbles: true,
        cancelable: true,
      }),
    );
    fixture.detectChanges();
  }

  function html(): string {
    return fixture.componentInstance.emitted() ?? '';
  }

  it('keeps an inserted clip through the author’s next keystroke', async () => {
    await clickToolbar('volume_up');
    expect(html()).toContain(`data-asset-path="${CLIP.path}"`);

    typeCharacter('x');

    // Left as the current node selection, the atom is what the next keystroke
    // replaces: the clip vanishes without a word while the upload stays in
    // Cloud Storage with nothing referring to it.
    expect(html()).toContain(`data-asset-path="${CLIP.path}"`);
  });

  it('inserts a second asset after the first, not over it', async () => {
    await clickToolbar('volume_up');
    await clickToolbar('image');

    expect(html()).toContain(`data-asset-path="${CLIP.path}"`);
    expect(html()).toContain(`src="${PICTURE.url}"`);
    // Order, not just survival: a caret parked before the clip would keep both
    // and still put the author's next words in the wrong place.
    expect(html().indexOf(CLIP.path)).toBeLessThan(html().indexOf(PICTURE.url));
  });

  it('makes somewhere for the caret when nothing follows the clip', async () => {
    // Inside the last list item there is no text position after the atom, and
    // the trailing paragraph the document keeps at its own end is out of reach.
    await setContent('<ul><li><p>one</p></li><li><p>two</p></li></ul>');

    await clickToolbar('volume_up');
    await clickToolbar('image');

    expect(html()).toMatch(/<audio[^>]*><\/audio><img[^>]*><p><\/p><\/li>/);
  });
});
