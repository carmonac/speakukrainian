import { Component, signal, type DebugElement } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { FormControl, NgModel, ReactiveFormsModule } from '@angular/forms';
import { By } from '@angular/platform-browser';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { of, throwError } from 'rxjs';
import { describe, expect, it } from 'vitest';
import type {
  ListSectionsQuery,
  LocaleCode,
  Page,
  PageBody,
  Section,
  SectionTreeNode,
} from '@speakukrainian/shared';
import { LocalesStore } from '../../core/locales/locales.store';
import { MediaPickerService } from '../../shared/media/media-picker.service';
import { RichTextEditor } from '../../shared/rich-text/rich-text-editor';
import { SectionsApi } from '../sections/sections.api';
import {
  MISSING_SECTION_OPTION,
  OWN_SECTION_OPTION,
  SOURCE_MUST_BE_CONTENT,
  SOURCE_SECTION_MISSING,
  SUBSECTION_PREVIEW_EMPTY,
  SUBSECTION_PREVIEW_FAILED,
  SUBSECTION_PREVIEW_TRUNCATED,
} from './page-messages';
import { emptyBodyFor } from './page-body';
import { SubsectionListPageBodyEditor } from './subsection-list-page-body-editor';

const EN = 0;
const UK = 1;

const audit = {
  createdAt: '2026-01-01T00:00:00Z',
  createdBy: 'admin',
  updatedAt: '2026-01-01T00:00:00Z',
  updatedBy: 'admin',
};

function section(id: string, overrides: Partial<Section> = {}): Section {
  return {
    id,
    parentId: null,
    ancestorIds: [],
    depth: 0,
    kind: 'content',
    slug: id,
    path: `/${id}`,
    title: { en: id },
    showInMenu: false,
    sortOrder: 0,
    status: 'published',
    audit,
    ...overrides,
  };
}

function node(id: string, overrides: Partial<SectionTreeNode> = {}): SectionTreeNode {
  return { ...section(id), children: [], ...overrides };
}

const TREE: SectionTreeNode[] = [
  node('grammar', { title: { en: 'Grammar points' } }),
  node('listening', { title: { en: 'Listening' } }),
  node('elsewhere', {
    kind: 'link',
    title: { en: 'Elsewhere' },
    link: { type: 'external', href: 'https://example.test', openInNewTab: false },
  }),
];

const TENSES = section('tenses', {
  parentId: 'grammar',
  title: { en: 'Tenses', uk: 'Часи' },
  description: { en: '<p>How English marks time</p>', uk: '<p>Як англійська позначає час</p>' },
  image: {
    path: 'images/tenses.png',
    url: 'https://cdn.test/images/tenses.png',
    contentType: 'image/png',
    sizeBytes: 100,
    alt: { en: 'A timeline' },
  },
});

const ARTICLES = section('articles', { parentId: 'grammar', title: { en: 'Articles' } });
const MODALS = section('modals', { parentId: 'grammar', title: { en: 'Modal verbs' } });
const CLIPS = section('clips', { parentId: 'listening', title: { en: 'Clips' } });

/**
 * The value the control is *built* with, so a stored body reaches the component
 * through the one `writeValue` a cold deep link makes — and nothing after it.
 * Setting it later would re-run the validators as a side effect and hide
 * whether the tree read refreshes them on its own.
 */
let initialBody: PageBody = emptyBodyFor('subsection_list');

/**
 * The shell's seam, exactly: one `FormControl<PageBody>` the body component
 * drives through `NG_VALUE_ACCESSOR` and judges through `NG_VALIDATORS`, plus
 * the one fact the shell passes down.
 */
@Component({
  selector: 'app-body-host',
  imports: [ReactiveFormsModule, SubsectionListPageBodyEditor],
  template: `<app-subsection-list-page-body-editor
    [formControl]="body"
    [ownSectionId]="ownSectionId()"
  />`,
})
class BodyHost {
  readonly body = new FormControl<PageBody>(initialBody, { nonNullable: true });
  readonly ownSectionId = signal<string | null>('grammar');
}

interface Options {
  /** What the form opens holding, as a stored page's body would be. */
  body?: PageBody;
  children?: Record<string, Section[]>;
  nextCursor?: string | null;
  listFails?: boolean;
  treeFails?: boolean;
}

describe('SubsectionListPageBodyEditor', () => {
  let fixture: ComponentFixture<BodyHost>;
  let queries: ListSectionsQuery[];

  async function setup(options: Options = {}): Promise<void> {
    queries = [];
    initialBody = options.body ?? emptyBodyFor('subsection_list');
    const sections = {
      tree: () => (options.treeFails === true ? throwError(() => new Error('offline')) : of(TREE)),
      list: (query: ListSectionsQuery) => {
        queries.push(query);
        if (options.listFails === true) {
          return throwError(() => new Error('offline'));
        }
        const items = options.children?.[String(query.parentId)] ?? [];
        return of<Page<Section>>({ items, nextCursor: options.nextCursor ?? null });
      },
    } as unknown as SectionsApi;

    TestBed.configureTestingModule({
      providers: [
        provideNoopAnimations(),
        { provide: SectionsApi, useValue: sections },
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
            pickAudio: () => Promise.resolve(null),
            pickImage: () => Promise.resolve(null),
          } as unknown as MediaPickerService,
        },
      ],
    });

    fixture = TestBed.createComponent(BodyHost);
    fixture.detectChanges();
    await settle();
  }

  async function settle(): Promise<void> {
    await fixture.whenStable();
    fixture.detectChanges();
  }

  function root(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function control(): FormControl<PageBody> {
    return fixture.componentInstance.body;
  }

  function value(): Extract<PageBody, { type: 'subsection_list' }> {
    const body = control().value;
    if (body.type !== 'subsection_list') {
      throw new Error(`Expected a subsection_list body, got ${body.type}`);
    }
    return body;
  }

  function text(selector: string): string {
    return root().querySelector(selector)?.textContent?.trim() ?? '';
  }

  function titles(): string[] {
    return Array.from(
      root().querySelectorAll('.subsection-preview__title'),
      (item) => item.textContent?.trim() ?? '',
    );
  }

  function excerpts(): string[] {
    return Array.from(
      root().querySelectorAll('.subsection-preview__excerpt'),
      (item) => item.textContent?.trim() ?? '',
    );
  }

  /** Drives a `mat-select` the way a pointer would, so `selectionChange` really runs. */
  async function choose(selector: string, label: string): Promise<void> {
    const trigger = root().querySelector<HTMLElement>(`${selector} .mat-mdc-select-trigger`);
    if (!trigger) {
      throw new Error(`Expected a select matching "${selector}"`);
    }
    trigger.click();
    fixture.detectChanges();
    await fixture.whenStable();

    const options = Array.from(document.querySelectorAll<HTMLElement>('mat-option'));
    const option = options.find((entry) => entry.textContent?.trim() === label);
    if (!option) {
      throw new Error(
        `Expected an option "${label}", found ${options.map((o) => o.textContent?.trim()).join(' | ')}`,
      );
    }
    option.click();
    await settle();
    await settle();
  }

  function optionLabels(selector: string): string[] {
    const trigger = root().querySelector<HTMLElement>(`${selector} .mat-mdc-select-trigger`);
    trigger?.click();
    fixture.detectChanges();
    return Array.from(
      document.querySelectorAll<HTMLElement>('mat-option'),
      (entry) => entry.textContent?.trim() ?? '',
    );
  }

  async function toggle(selector: string): Promise<void> {
    const input = root().querySelector<HTMLInputElement>(`${selector} input[type="checkbox"]`);
    if (!input) {
      throw new Error(`Expected a checkbox matching "${selector}"`);
    }
    input.click();
    await settle();
  }

  /** Selects a locale tab of the intro editor and answers with the editor behind it. */
  async function introTab(index: number): Promise<DebugElement> {
    const tabs = root().querySelectorAll<HTMLElement>('.subsection-body__intro [role="tab"]');
    const tab = tabs[index];
    if (!tab) {
      throw new Error(`Expected an intro tab at index ${index}`);
    }
    tab.click();
    for (let pass = 0; pass < 2; pass += 1) {
      fixture.detectChanges();
      await fixture.whenStable();
    }
    fixture.detectChanges();

    const editor = fixture.debugElement.query(By.directive(RichTextEditor));
    if (!editor) {
      throw new Error('Expected the active intro tab to hold an editor');
    }
    return editor;
  }

  async function typeIntro(index: number, html: string): Promise<void> {
    const editor = await introTab(index);
    editor.injector.get(NgModel).viewToModelUpdate(html);
    await settle();
  }

  it('previews the page’s own section’s published children, in the order they arrive', async () => {
    // AC1 and AC6: the request names `published`, and the rows keep the order
    // `SectionsRepository.list` answered in.
    await setup({ children: { grammar: [MODALS, TENSES, ARTICLES] } });

    expect(queries).toEqual([{ parentId: 'grammar', status: 'published', limit: 100 }]);
    expect(titles()).toEqual(['Modal verbs', 'Tenses', 'Articles']);
  });

  it('shows the default on the picker rather than leaving it blank', async () => {
    // The default's value is `null`, and Material reads a null-valued option as
    // "nothing selected" unless it is told otherwise — so without
    // `canSelectNullableOptions` the picker sits empty on every page that keeps
    // the default, which is most of them.
    await setup({ children: { grammar: [TENSES] } });

    expect(text('.subsection-body__source')).toBe(`${OWN_SECTION_OPTION} (Grammar points)`);
  });

  it('changes the layout without a save and without a second request', async () => {
    // AC2's first half. The persistence half is the shell's, through the
    // control's value.
    await setup({ children: { grammar: [TENSES] } });

    expect(root().querySelector('.subsection-preview__items--grid')).not.toBeNull();

    await choose('.subsection-body__layout', 'List');

    expect(root().querySelector('.subsection-preview__items--list')).not.toBeNull();
    expect(root().querySelector('.subsection-preview__items--grid')).toBeNull();
    expect(value().layout).toBe('list');
    expect(queries).toHaveLength(1);
  });

  it('takes the images out of the preview and out of the body together', async () => {
    // AC3. A toggle that changed only CSS would leave the stored body claiming
    // images the page will not show.
    await setup({ children: { grammar: [TENSES] } });

    expect(root().querySelector('.subsection-preview__image')?.getAttribute('src')).toBe(
      TENSES.image?.url,
    );

    await toggle('.subsection-body__show-images');

    expect(root().querySelectorAll('.subsection-preview__image')).toHaveLength(0);
    expect(value().showImages).toBe(false);
    expect(queries).toHaveLength(1);
  });

  it('takes the descriptions out of the preview and out of the body together', async () => {
    await setup({ children: { grammar: [TENSES] } });

    expect(excerpts()).toEqual(['How English marks time']);

    await toggle('.subsection-body__show-descriptions');

    expect(excerpts()).toEqual([]);
    expect(value().showDescriptions).toBe(false);
  });

  it('previews another section’s children once the source is re-pointed', async () => {
    // AC4.
    await setup({ children: { grammar: [TENSES], listening: [CLIPS] } });

    await choose('.subsection-body__source', 'Listening');

    expect(queries).toEqual([
      { parentId: 'grammar', status: 'published', limit: 100 },
      { parentId: 'listening', status: 'published', limit: 100 },
    ]);
    expect(titles()).toEqual(['Clips']);
    expect(value().sourceSectionId).toBe('listening');
  });

  it('stores no source section id when the default is kept', async () => {
    // The technical note: the id copied in would pin the page to a section it
    // merely lives in today, instead of following it.
    await setup({ children: { grammar: [TENSES] } });

    await choose('.subsection-body__source', 'Listening');
    expect('sourceSectionId' in value()).toBe(true);

    await choose('.subsection-body__source', `${OWN_SECTION_OPTION} (Grammar points)`);

    expect('sourceSectionId' in value()).toBe(false);
    expect(titles()).toEqual(['Tenses']);
  });

  it('refuses a link section on the picker, and asks the API nothing about it', async () => {
    // AC5. The option is offered, and says what it is, so the refusal is a thing
    // the author can provoke and read.
    await setup({ children: { grammar: [TENSES] } });

    expect(optionLabels('.subsection-body__source')).toContain('Elsewhere (link section)');

    await choose('.subsection-body__source', 'Elsewhere (link section)');

    expect(text('.subsection-body__source-error')).toBe(SOURCE_MUST_BE_CONTENT);
    expect(control().valid).toBe(false);
    expect(control().errors).toEqual({ source: 'not-content' });
    expect(queries).toHaveLength(1);
  });

  it('says a stored source is gone rather than silently clearing it', async () => {
    // Clearing it would look like a save that worked, and the next save would
    // write the page's own section in as if the author had chosen it. Nothing
    // edits the control here: the rule has to apply the moment the tree lands.
    await setup({
      body: {
        type: 'subsection_list',
        sourceSectionId: 'deleted',
        layout: 'grid',
        showImages: true,
        showDescriptions: true,
      },
      children: { grammar: [TENSES] },
    });

    expect(text('.subsection-body__source-error')).toBe(SOURCE_SECTION_MISSING);
    expect(control().errors).toEqual({ source: 'missing' });
    expect(value().sourceSectionId).toBe('deleted');
    expect(optionLabels('.subsection-body__source')).toContain(MISSING_SECTION_OPTION);
  });

  it('refuses a stored link source once the tree arrives, with no edit in between', async () => {
    // The stale case AC5's gesture cannot reach: a section switched to
    // `kind: 'link'` after this page was saved.
    await setup({
      body: {
        type: 'subsection_list',
        sourceSectionId: 'elsewhere',
        layout: 'grid',
        showImages: true,
        showDescriptions: true,
      },
    });

    expect(control().errors).toEqual({ source: 'not-content' });
    expect(text('.subsection-body__source-error')).toBe(SOURCE_MUST_BE_CONTENT);
  });

  it('does not block saving when the section tree could not be read', async () => {
    // A failed tree read must not hold up a body that is otherwise fine, and
    // the stored source has to survive it.
    await setup({
      treeFails: true,
      body: {
        type: 'subsection_list',
        sourceSectionId: 'elsewhere',
        layout: 'grid',
        showImages: true,
        showDescriptions: true,
      },
    });

    expect(control().valid).toBe(true);
    expect(value().sourceSectionId).toBe('elsewhere');
  });

  it('writes the intro per locale without asking the API for anything', async () => {
    // AC7's editing half: the preview is keyed on the source id alone, so no
    // keystroke can issue a request.
    await setup({ children: { grammar: [TENSES] } });

    await typeIntro(EN, '<p>Pick a topic below.</p>');

    expect(value().intro).toEqual({ en: '<p>Pick a topic below.</p>' });
    expect(queries).toHaveLength(1);
  });

  it('follows the previewed locale for the intro, the titles and the excerpts', async () => {
    // AC7's preview half.
    await setup({ children: { grammar: [TENSES] } });
    await typeIntro(EN, '<p>Pick a topic below.</p>');
    await typeIntro(UK, '<p>Оберіть тему.</p>');

    expect(text('.subsection-preview__intro')).toBe('Pick a topic below.');
    expect(titles()).toEqual(['Tenses']);

    await choose('.subsection-preview__locale', 'UK');

    expect(text('.subsection-preview__intro')).toBe('Оберіть тему.');
    expect(titles()).toEqual(['Часи']);
    expect(excerpts()).toEqual(['Як англійська позначає час']);
    expect(queries).toHaveLength(1);
  });

  it('says a section has no published subsections rather than showing a blank panel', async () => {
    // AC8.
    await setup({ children: { grammar: [] } });

    expect(text('.subsection-preview__empty')).toBe(SUBSECTION_PREVIEW_EMPTY);
    expect(root().querySelector('.subsection-preview__items')).toBeNull();
  });

  it('says the preview failed rather than that the section is empty', async () => {
    await setup({ listFails: true });

    expect(text('.subsection-preview__failed')).toBe(SUBSECTION_PREVIEW_FAILED);
    expect(root().querySelector('.subsection-preview__empty')).toBeNull();
  });

  it('says so when the section holds more subsections than it previews', async () => {
    await setup({ children: { grammar: [TENSES] }, nextCursor: 'cursor-1' });

    expect(text('.subsection-preview__truncated')).toBe(SUBSECTION_PREVIEW_TRUNCATED);
  });

  it('asks for nothing at all when the page has no section to fall back to', async () => {
    await setup({ children: { grammar: [TENSES] } });
    fixture.componentInstance.ownSectionId.set(null);
    await settle();

    expect(root().querySelector('.subsection-preview__no-source')).not.toBeNull();
    expect(queries.some((query) => query.parentId === undefined)).toBe(false);
  });

  it('populates every control from a stored body, and leaves the form pristine', async () => {
    // AC2's persistence half: a refresh has to repaint the configuration, and a
    // form that opens dirty makes the unsaved-changes guard nag about nothing —
    // which is what a `writeValue` that called `onChange` would do.
    await setup({
      body: {
        type: 'subsection_list',
        sourceSectionId: 'listening',
        layout: 'list',
        showImages: false,
        showDescriptions: false,
        intro: { en: '<p>Stored intro</p>' },
      },
      children: { grammar: [TENSES], listening: [CLIPS] },
    });

    expect(text('.subsection-body__source')).toBe('Listening');
    expect(text('.subsection-body__layout')).toBe('List');
    expect(
      root().querySelector<HTMLInputElement>('.subsection-body__show-images input')?.checked,
    ).toBe(false);
    expect(
      root().querySelector<HTMLInputElement>('.subsection-body__show-descriptions input')?.checked,
    ).toBe(false);
    expect(text('.subsection-preview__intro')).toBe('Stored intro');
    expect(root().querySelector('.subsection-preview__items--list')).not.toBeNull();
    expect(titles()).toEqual(['Clips']);
    expect(control().pristine).toBe(true);
  });

  it('treats a programmatic write as a load and not as an author edit', async () => {
    // A `writeValue` that called `onChange` would mark the control dirty, and
    // the unsaved-changes guard would then prompt on the way out of a form
    // nobody had touched.
    await setup({ children: { grammar: [TENSES], listening: [CLIPS] } });

    control().setValue({
      type: 'subsection_list',
      sourceSectionId: 'listening',
      layout: 'list',
      showImages: false,
      showDescriptions: true,
    });
    await settle();

    expect(control().pristine).toBe(true);
    expect(titles()).toEqual(['Clips']);
  });

  it('stops accepting edits when the control is disabled', async () => {
    await setup({ children: { grammar: [TENSES] } });
    control().disable();
    await settle();

    expect(root().querySelector('.subsection-body__source')?.getAttribute('aria-disabled')).toBe(
      'true',
    );
    expect(
      root().querySelector<HTMLInputElement>('.subsection-body__show-images input')?.disabled,
    ).toBe(true);
    expect(
      root().querySelector('.rte__content .ProseMirror')?.getAttribute('contenteditable'),
    ).toBe('false');
  });
});
