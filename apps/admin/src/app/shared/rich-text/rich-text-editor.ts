import {
  Component,
  type ElementRef,
  type OnDestroy,
  effect,
  forwardRef,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { NG_VALUE_ACCESSOR, type ControlValueAccessor } from '@angular/forms';
import type { AssetRef } from '@speakukrainian/shared';
import { Editor, isNodeSelection, type CommandProps } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Audio } from './audio.extension';
import { MediaPickerService } from '../media/media-picker.service';

/**
 * Puts the caret in a text position after a just-inserted atom.
 *
 * ProseMirror leaves the fresh node as the current `NodeSelection`, so the
 * author's very next keystroke replaces it: the clip or picture they just
 * uploaded disappears without a word, while the object stays in Cloud Storage
 * with nothing left referring to it. Inserting and then carrying on writing is
 * the ordinary gesture, so the caret has to land after the node.
 *
 * An atom dropped at the end of a list item or a blockquote has no text
 * position after it — the trailing paragraph the document keeps at its own end
 * is out of reach there — so one is made. Chained onto the insert rather than
 * dispatched afterwards, so a single undo takes the whole insertion back.
 */
function caretAfterAtom({ state, commands }: CommandProps): boolean {
  const { selection } = state;
  if (!isNodeSelection(selection)) {
    return true;
  }

  const after = selection.to;
  const next = state.doc.resolve(after).nodeAfter;
  return next?.isTextblock === true
    ? commands.setTextSelection(after + 1)
    : commands.insertContentAt(after, { type: 'paragraph' });
}

/**
 * The rich text control used by every long-form field in the admin panel —
 * there are no plain `<textarea>`s in this product.
 *
 * Implements `ControlValueAccessor`, so it drops into reactive forms as
 * `<app-rich-text-editor formControlName="description" />`. The value is
 * sanitized HTML; the API sanitizes again on write, since a compromised
 * browser could post anything.
 */
@Component({
  selector: 'app-rich-text-editor',
  imports: [MatButtonModule, MatIconModule, MatTooltipModule],
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => RichTextEditor),
      multi: true,
    },
  ],
  templateUrl: './rich-text-editor.html',
  styleUrl: './rich-text-editor.scss',
})
export class RichTextEditor implements ControlValueAccessor, OnDestroy {
  private readonly mediaPicker = inject(MediaPickerService);
  private readonly host = viewChild.required<ElementRef<HTMLElement>>('editorHost');

  readonly placeholder = input('');
  /** Hides the image and audio buttons for short fields like a menu label. */
  readonly inlineOnly = input(false);

  /**
   * The asset the picker just returned, for a form that has to record it
   * somewhere other than in the HTML.
   *
   * The serialized content keeps only a `src` and, for audio, a
   * `data-asset-path` — the API sanitizer's `ALLOW_DATA_ATTR: false` stops
   * anything else riding along — so `contentType` and `sizeBytes` exist nowhere
   * else once the insert has run. A form that ignores this output loses
   * nothing but those two fields.
   */
  readonly assetInserted = output<AssetRef>();

  protected readonly disabled = signal(false);
  protected readonly active = signal<Record<string, boolean>>({});

  private editor: Editor | null = null;
  private onChange: (value: string) => void = () => {};
  private onTouched: () => void = () => {};
  private pendingValue = '';

  constructor() {
    effect((onCleanup) => {
      const element = this.host().nativeElement;

      const editor = new Editor({
        element,
        extensions: [
          StarterKit.configure({ heading: { levels: [2, 3, 4] } }),
          Link.configure({ openOnClick: false, autolink: true }),
          Image.configure({ inline: false }),
          Audio,
        ],
        content: this.pendingValue,
        editable: !this.disabled(),
        onUpdate: ({ editor: instance }) => {
          this.onChange(instance.isEmpty ? '' : instance.getHTML());
          this.refreshActiveMarks();
        },
        onBlur: () => this.onTouched(),
        onSelectionUpdate: () => this.refreshActiveMarks(),
      });

      this.editor = editor;
      onCleanup(() => {
        editor.destroy();
        this.editor = null;
      });
    });
  }

  ngOnDestroy(): void {
    this.editor?.destroy();
  }

  writeValue(value: string | null): void {
    this.pendingValue = value ?? '';
    // `emitUpdate: false` stops the programmatic write from echoing back as a
    // user edit, which would mark a pristine form dirty on load.
    this.editor?.commands.setContent(this.pendingValue, { emitUpdate: false });
  }

  registerOnChange(fn: (value: string) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  setDisabledState(isDisabled: boolean): void {
    this.disabled.set(isDisabled);
    this.editor?.setEditable(!isDisabled);
  }

  protected toggle(command: 'bold' | 'italic' | 'strike' | 'bulletList' | 'orderedList'): void {
    const chain = this.editor?.chain().focus();
    if (!chain) return;
    switch (command) {
      case 'bold':
        chain.toggleBold().run();
        break;
      case 'italic':
        chain.toggleItalic().run();
        break;
      case 'strike':
        chain.toggleStrike().run();
        break;
      case 'bulletList':
        chain.toggleBulletList().run();
        break;
      case 'orderedList':
        chain.toggleOrderedList().run();
        break;
    }
  }

  protected toggleHeading(level: 2 | 3 | 4): void {
    this.editor?.chain().focus().toggleHeading({ level }).run();
  }

  protected async insertImage(): Promise<void> {
    const asset = await this.mediaPicker.pickImage();
    const editor = this.editor;
    if (asset === null || editor === null) {
      // Cancelled, a failed upload the picker has already reported, or a view
      // torn down while the file dialog was open.
      return;
    }

    // Announced *before* the insert. ProseMirror dispatches the transaction
    // synchronously, so `onUpdate` — and any HTML the listener derives from —
    // arrives during `.run()`. Emitting afterwards would hand a listener content
    // that already refers to an asset it has not been told about yet.
    this.assetInserted.emit(asset);
    editor
      .chain()
      .focus()
      .setImage({ src: asset.url, alt: asset.alt?.['en'] ?? '' })
      .command(caretAfterAtom)
      .run();
  }

  protected async insertAudio(): Promise<void> {
    const asset = await this.mediaPicker.pickAudio();
    const editor = this.editor;
    if (asset === null || editor === null) {
      return;
    }

    this.assetInserted.emit(asset);
    editor
      .chain()
      .focus()
      .setAudio({ src: asset.url, title: asset.path, assetPath: asset.path })
      .command(caretAfterAtom)
      .run();
  }

  protected async setLink(): Promise<void> {
    const href = await this.mediaPicker.promptForUrl(this.editor?.getAttributes('link')['href']);
    if (href === null) return;
    const chain = this.editor?.chain().focus().extendMarkRange('link');
    if (href === '') {
      chain?.unsetLink().run();
    } else {
      chain?.setLink({ href }).run();
    }
  }

  private refreshActiveMarks(): void {
    const editor = this.editor;
    if (!editor) return;
    this.active.set({
      bold: editor.isActive('bold'),
      italic: editor.isActive('italic'),
      strike: editor.isActive('strike'),
      bulletList: editor.isActive('bulletList'),
      orderedList: editor.isActive('orderedList'),
      link: editor.isActive('link'),
      h2: editor.isActive('heading', { level: 2 }),
      h3: editor.isActive('heading', { level: 3 }),
      h4: editor.isActive('heading', { level: 4 }),
    });
  }
}
