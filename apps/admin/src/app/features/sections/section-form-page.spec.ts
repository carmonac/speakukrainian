import { Component, signal, type DebugElement } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { NgModel } from '@angular/forms';
import { By } from '@angular/platform-browser';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { MatDialog } from '@angular/material/dialog';
import { Router, provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AssetRef, LocaleCode, Section } from '@speakukrainian/shared';
import { LocalesStore } from '../../core/locales/locales.store';
import { NotificationService } from '../../core/notifications/notification.service';
import { unsavedChangesGuard } from '../../core/router/unsaved-changes.guard';
import { MediaPickerService } from '../../shared/media/media-picker.service';
import { RichTextEditor } from '../../shared/rich-text/rich-text-editor';
import { SectionFormPage } from './section-form-page';
import { sectionFormResolver } from './section-form.resolver';
import { SectionsApi } from './sections.api';

@Component({ selector: 'app-sections-tree-stub', template: 'tree' })
class TreeStub {}

const EN = 0;
const UK = 1;

const audit = {
  createdAt: '2026-01-01T00:00:00Z',
  createdBy: 'admin',
  updatedAt: '2026-01-01T00:00:00Z',
  updatedBy: 'admin',
};

const HERO: AssetRef = {
  path: 'images/2026/01/hero.webp',
  url: 'https://cdn.test/images/2026/01/hero.webp',
  contentType: 'image/webp',
  sizeBytes: 4096,
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
    status: 'draft',
    audit,
    ...overrides,
  };
}

const GRAMMAR_PATH = '/grammar-points';
const GRAMMAR = section('grammar', {
  title: { en: 'Grammar points' },
  slug: 'grammar-points',
  path: GRAMMAR_PATH,
});

const STORED = section('sec-1', {
  parentId: GRAMMAR.id,
  ancestorIds: [GRAMMAR.id],
  depth: 1,
  slug: 'present-simple',
  path: `${GRAMMAR_PATH}/present-simple`,
  title: { en: 'Present simple', uk: 'Теперішній простий' },
  description: { en: '<p>Body</p>' },
  image: { ...HERO, alt: { en: 'A hero' } },
  status: 'published',
  sortOrder: 3,
});

interface Options {
  sections?: Section[];
  saved?: Section;
  saveFails?: unknown;
  picked?: AssetRef | null;
  defaultCode?: LocaleCode | null;
}

interface Harnessed {
  calls: { method: string; args: unknown[] }[];
  dialogs: number;
  successes: string[];
}

function setup(options: Options = {}): Harnessed {
  const stored = new Map((options.sections ?? []).map((entry) => [entry.id, entry]));
  const recorded: Harnessed = { calls: [], dialogs: 0, successes: [] };
  const saved = options.saved ?? section('new-1', { slug: 'created', path: '/created' });

  const write =
    (method: string) =>
    (...args: unknown[]) => {
      recorded.calls.push({ method, args });
      return options.saveFails === undefined ? of(saved) : throwError(() => options.saveFails);
    };

  const api = {
    get: (id: string) => {
      recorded.calls.push({ method: 'get', args: [id] });
      const found = stored.get(id);
      return found === undefined
        ? throwError(() => new HttpErrorResponse({ status: 404, statusText: 'Not Found' }))
        : of(found);
    },
    create: write('create'),
    update: write('update'),
  } as unknown as SectionsApi;

  TestBed.configureTestingModule({
    providers: [
      provideNoopAnimations(),
      provideRouter(
        [
          { path: 'sections', component: TreeStub },
          {
            path: 'sections/new',
            component: SectionFormPage,
            resolve: { formData: sectionFormResolver },
            canDeactivate: [unsavedChangesGuard],
          },
          {
            path: 'sections/:id',
            component: SectionFormPage,
            resolve: { formData: sectionFormResolver },
            canDeactivate: [unsavedChangesGuard],
          },
        ],
        withComponentInputBinding(),
      ),
      { provide: SectionsApi, useValue: api },
      {
        provide: LocalesStore,
        useValue: {
          // Two locales rather than the seeded three: every tab is a TipTap
          // instance, and two is enough to prove the per-locale behaviour.
          codes: signal<LocaleCode[]>(['en', 'uk']).asReadonly(),
          defaultCode: signal<LocaleCode | null>(
            options.defaultCode === undefined ? 'en' : options.defaultCode,
          ).asReadonly(),
        } as unknown as LocalesStore,
      },
      {
        provide: MediaPickerService,
        useValue: {
          pickImage: () => {
            recorded.calls.push({ method: 'pickImage', args: [] });
            return Promise.resolve(options.picked ?? null);
          },
        } as unknown as MediaPickerService,
      },
      {
        provide: NotificationService,
        useValue: {
          success: (message: string) => recorded.successes.push(message),
          info: () => {},
          error: () => {},
        } as unknown as NotificationService,
      },
      {
        provide: MatDialog,
        useValue: {
          open: () => {
            recorded.dialogs += 1;
            return { afterClosed: () => of(true) };
          },
        } as unknown as MatDialog,
      },
    ],
  });

  return recorded;
}

async function open(url: string): Promise<RouterTestingHarness> {
  const harness = await RouterTestingHarness.create(url);
  await harness.fixture.whenStable();
  harness.detectChanges();
  return harness;
}

function root(harness: RouterTestingHarness): HTMLElement {
  const element = harness.routeNativeElement;
  if (!(element instanceof HTMLElement)) {
    throw new Error('Expected the section form to be the activated route');
  }
  return element;
}

function page(harness: RouterTestingHarness): SectionFormPage {
  return harness.routeDebugElement?.componentInstance as SectionFormPage;
}

function slugField(harness: RouterTestingHarness): HTMLInputElement {
  const input = root(harness).querySelector<HTMLInputElement>('input[formControlName="slug"]');
  if (!input) {
    throw new Error('Expected the form to render a slug field');
  }
  return input;
}

function fillSlug(harness: RouterTestingHarness, value: string): void {
  const input = slugField(harness);
  input.value = value;
  input.dispatchEvent(new Event('input'));
  harness.detectChanges();
}

function fillSortOrder(harness: RouterTestingHarness, value: string): void {
  const input = root(harness).querySelector<HTMLInputElement>('input[formControlName="sortOrder"]');
  if (!input) {
    throw new Error('Expected the form to render a sort order field');
  }
  input.value = value;
  input.dispatchEvent(new Event('input'));
  harness.detectChanges();
}

function sortOrderError(harness: RouterTestingHarness): string | null {
  return (
    root(harness).querySelector('.section-form__sort-order-error')?.textContent?.trim() ?? null
  );
}

function saveButton(harness: RouterTestingHarness): HTMLButtonElement {
  const button = root(harness).querySelector<HTMLButtonElement>('button[type="submit"]');
  if (!button) {
    throw new Error('Expected the form to render a Save button');
  }
  return button;
}

/**
 * Selects a locale tab inside one localized editor and answers with the single
 * `RichTextEditor` behind it — `MatTabGroup` keeps only the selected tab's body
 * inserted, so selecting first is what keeps this pointing at the right locale.
 */
async function localeTab(
  harness: RouterTestingHarness,
  name: string,
  index: number,
): Promise<DebugElement> {
  const host = harness.fixture.debugElement.query(By.css(`[formControlName="${name}"]`));
  if (!host) {
    throw new Error(`Expected a localized editor for "${name}"`);
  }
  const tabs = (host.nativeElement as HTMLElement).querySelectorAll<HTMLElement>('[role="tab"]');
  const tab = tabs[index];
  if (!tab) {
    throw new Error(`Expected a tab at index ${index} of the "${name}" editor`);
  }
  tab.click();
  // Two passes: the click moves the selected index, the tab body is inserted on
  // the pass after that, and `ngModel` writes into the editor on a microtask
  // rather than during change detection.
  for (let pass = 0; pass < 2; pass += 1) {
    harness.detectChanges();
    await harness.fixture.whenStable();
  }
  harness.detectChanges();

  const editor = host.query(By.directive(RichTextEditor));
  if (!editor) {
    throw new Error(`Expected the active tab of "${name}" to hold an editor`);
  }
  return editor;
}

/** The technique `localized-rich-text-editor.spec.ts` uses to drive the editor. */
async function typeInto(
  harness: RouterTestingHarness,
  name: string,
  index: number,
  html: string,
): Promise<void> {
  const editor = await localeTab(harness, name, index);
  editor.injector.get(NgModel).viewToModelUpdate(html);
  harness.detectChanges();
}

/**
 * The text the tab's editor is showing, read out of the ProseMirror document.
 * Only answers for content that reached the editor through the value accessor —
 * a stored section being patched into the form.
 */
async function renderedIn(
  harness: RouterTestingHarness,
  name: string,
  index: number,
): Promise<string> {
  const editor = (await localeTab(harness, name, index)).nativeElement as HTMLElement;
  return editor.querySelector('.rte__content')?.textContent?.trim() ?? '';
}

/**
 * The text the wrapper hands this tab's editor.
 *
 * `typeInto` drives the model side of the editor, exactly as
 * `localized-rich-text-editor.spec.ts` does, so ProseMirror's own document
 * never sees that text and {@link renderedIn} cannot answer for it. This is the
 * value the tab would render from, which is what "the other tabs kept their
 * edits" means here.
 */
async function boundIn(
  harness: RouterTestingHarness,
  name: string,
  index: number,
): Promise<unknown> {
  return (await localeTab(harness, name, index)).injector.get(NgModel).model;
}

async function submit(harness: RouterTestingHarness): Promise<void> {
  root(harness).querySelector('form')?.dispatchEvent(new Event('submit'));
  await harness.fixture.whenStable();
  harness.detectChanges();
}

function bodyOf(
  calls: { method: string; args: unknown[] }[],
  method: string,
): Record<string, unknown> {
  const call = calls.find((entry) => entry.method === method);
  if (!call) {
    throw new Error(`Expected the form to call ${method}`);
  }
  return (method === 'update' ? call.args[1] : call.args[0]) as Record<string, unknown>;
}

function conflictError(message: string): HttpErrorResponse {
  return new HttpErrorResponse({
    status: 409,
    statusText: 'Conflict',
    error: {
      statusCode: 409,
      message,
      path: '/api/sections',
      timestamp: '2026-01-01T00:00:00.000Z',
    },
  });
}

describe('SectionFormPage', () => {
  beforeEach(() => {
    history.replaceState({}, '');
  });

  it('populates the form on a cold deep link to /sections/:id', async () => {
    setup({ sections: [STORED] });
    const harness = await open('/sections/sec-1');

    expect(slugField(harness).value).toBe('present-simple');
    expect(await renderedIn(harness, 'title', EN)).toBe('Present simple');
    expect(await renderedIn(harness, 'description', EN)).toBe('Body');
    expect(await renderedIn(harness, 'title', UK)).toBe('Теперішній простий');
    // The stored image is on screen with no upload, which is the other half of
    // "still there after a hard refresh".
    expect(root(harness).querySelector<HTMLImageElement>('.section-form__image-preview')?.src).toBe(
      HERO.url,
    );
    expect(root(harness).querySelector('mat-select')?.textContent?.trim()).toBe('Published');
    expect(root(harness).querySelector('.section-form__path')?.textContent).toContain(
      '/grammar-points/present-simple',
    );
  });

  it('shows the parent and the derived path for /sections/new?parentId=', async () => {
    setup({ sections: [GRAMMAR] });
    const harness = await open('/sections/new?parentId=grammar');

    expect(root(harness).querySelector('.section-form__parent')?.textContent).toContain(
      'Grammar points',
    );

    fillSlug(harness, 'present-simple');

    expect(root(harness).querySelector('.section-form__path')?.textContent).toContain(
      '/grammar-points/present-simple',
    );
  });

  it('suggests a kebab-cased slug from the default-locale title', async () => {
    setup();
    const harness = await open('/sections/new');

    await typeInto(harness, 'title', EN, '<p>Present Simple</p>');

    expect(slugField(harness).value).toBe('present-simple');
  });

  it('stops suggesting once the author has typed a slug', async () => {
    setup();
    const harness = await open('/sections/new');

    fillSlug(harness, 'my-own-slug');
    await typeInto(harness, 'title', EN, '<p>Present Simple</p>');

    expect(slugField(harness).value).toBe('my-own-slug');
  });

  it('never rewrites an existing section slug from its title', async () => {
    const { calls } = setup({ sections: [STORED] });
    const harness = await open('/sections/sec-1');

    await typeInto(harness, 'title', EN, '<p>Something else entirely</p>');

    // The field itself first: a save navigates back to the tree, so the field
    // has to be checked while the form is still on screen.
    expect(slugField(harness).value).toBe('present-simple');

    await submit(harness);

    expect(bodyOf(calls, 'update')['slug']).toBe('present-simple');
    // The edit route converts the editor's HTML to plain text too, not only
    // the create route.
    expect(bodyOf(calls, 'update')['title']).toEqual({
      en: 'Something else entirely',
      uk: 'Теперішній простий',
    });
  });

  it('keeps edits in the other locale tabs when the author switches tab and back', async () => {
    const { calls } = setup();
    const harness = await open('/sections/new');

    await typeInto(harness, 'title', EN, '<p>Present simple</p>');
    await typeInto(harness, 'title', UK, '<p>Теперішній простий</p>');

    expect(await boundIn(harness, 'title', EN)).toBe('<p>Present simple</p>');
    expect(await boundIn(harness, 'title', UK)).toBe('<p>Теперішній простий</p>');

    await submit(harness);

    expect(bodyOf(calls, 'create')['title']).toEqual({
      en: 'Present simple',
      uk: 'Теперішній простий',
    });
  });

  it('saves the picked image with its localized alt', async () => {
    const { calls } = setup({ picked: HERO });
    const harness = await open('/sections/new');

    await typeInto(harness, 'title', EN, '<p>Listening</p>');
    root(harness).querySelector<HTMLButtonElement>('.section-form__choose-image')?.click();
    await harness.fixture.whenStable();
    harness.detectChanges();

    // The preview appears straight away, with nothing saved yet.
    expect(root(harness).querySelector<HTMLImageElement>('.section-form__image-preview')?.src).toBe(
      HERO.url,
    );
    expect(calls.some((call) => call.method === 'create')).toBe(false);

    await typeInto(harness, 'imageAlt', EN, '<p>A wide hero shot</p>');
    await submit(harness);

    expect(bodyOf(calls, 'create')['image']).toEqual({
      ...HERO,
      alt: { en: 'A wide hero shot' },
    });
  });

  it('clears a stored image by sending image: null', async () => {
    const { calls } = setup({ sections: [STORED] });
    const harness = await open('/sections/sec-1');

    root(harness).querySelector<HTMLButtonElement>('.section-form__remove-image')?.click();
    harness.detectChanges();

    expect(root(harness).querySelector('.section-form__image-preview')).toBeNull();

    await submit(harness);

    // Omitting the key would mean "leave it alone", so the removal has to be
    // an explicit null or it never reaches Firestore.
    expect(bodyOf(calls, 'update')['image']).toBeNull();
  });

  it('strips editor formatting from the title before saving', async () => {
    const { calls } = setup();
    const harness = await open('/sections/new');

    await typeInto(harness, 'title', EN, '<p><strong>Present</strong> Simple</p>');
    await submit(harness);

    expect(bodyOf(calls, 'create')['title']).toEqual({ en: 'Present Simple' });
  });

  it('leaves a tag-shaped title and alt exactly as stored when nothing is edited', async () => {
    // The editor treats its value as HTML, so text that merely looks like
    // markup is truncated on the way in — and that truncation is what the next
    // save would store, rewriting content nobody touched.
    const awkward = section('sec-2', {
      title: { en: 'Modal verbs <can>', uk: 'Tom & Jerry' },
      image: { ...HERO, alt: { en: 'a > b' } },
    });
    const { calls } = setup({ sections: [awkward] });
    const harness = await open('/sections/sec-2');

    expect(await renderedIn(harness, 'title', EN)).toBe('Modal verbs <can>');
    expect(await renderedIn(harness, 'title', UK)).toBe('Tom & Jerry');
    expect(await renderedIn(harness, 'imageAlt', EN)).toBe('a > b');

    await submit(harness);

    expect(bodyOf(calls, 'update')['title']).toEqual(awkward.title);
    expect(bodyOf(calls, 'update')['image']).toEqual(awkward.image);
  });

  it('refuses a fractional sort order at the field instead of at the API', async () => {
    const { calls } = setup({ sections: [STORED] });
    const harness = await open('/sections/sec-1');

    fillSortOrder(harness, '1.5');

    expect(sortOrderError(harness)).toBe('Whole numbers only.');
    expect(saveButton(harness).disabled).toBe(true);

    await submit(harness);

    expect(calls.some((call) => call.method === 'update')).toBe(false);
  });

  it('treats an emptied sort order on an edit as an error, not as a no-op', async () => {
    // Omitting the key would leave the stored number in place, so the author
    // would come back to a number they thought they had cleared.
    const { calls } = setup({ sections: [STORED] });
    const harness = await open('/sections/sec-1');

    fillSortOrder(harness, '');

    expect(sortOrderError(harness)).toBe('Give the section a position.');
    expect(saveButton(harness).disabled).toBe(true);

    await submit(harness);

    expect(calls.some((call) => call.method === 'update')).toBe(false);
  });

  it('still lets the create route leave the sort order empty', async () => {
    const { calls } = setup();
    const harness = await open('/sections/new');

    await typeInto(harness, 'title', EN, '<p>Listening</p>');

    expect(sortOrderError(harness)).toBeNull();
    expect(saveButton(harness).disabled).toBe(false);

    await submit(harness);

    // No key at all: an omitted sortOrder is what the API reads as "append
    // after the last sibling".
    expect(Object.keys(bodyOf(calls, 'create'))).not.toContain('sortOrder');
  });

  it('says what a brand-new form is missing before the author touches anything', async () => {
    setup();
    const harness = await open('/sections/new');

    expect(saveButton(harness).disabled).toBe(true);
    expect(root(harness).querySelector('.section-form__error')?.textContent?.trim()).toBe(
      'Give the section a title in the default locale.',
    );
  });

  it('patches only the fields this form owns', async () => {
    const { calls } = setup({ sections: [STORED] });
    const harness = await open('/sections/sec-1');

    fillSlug(harness, 'present-simple-renamed');
    await submit(harness);

    // `showInMenu`, `kind`, `menuLabel` and `link` belong to another screen; a
    // patch that carried them would silently undo it.
    expect(Object.keys(bodyOf(calls, 'update')).sort()).toEqual([
      'description',
      'image',
      'slug',
      'sortOrder',
      'status',
      'title',
    ]);
    expect(calls.find((call) => call.method === 'update')?.args[0]).toBe('sec-1');
  });

  it('binds a slug conflict to the field instead of leaving it to the toast', async () => {
    const message = 'Another section under the same parent already uses the slug "listening"';
    setup({ saveFails: conflictError(message) });
    const harness = await open('/sections/new');

    await typeInto(harness, 'title', EN, '<p>Listening</p>');
    await submit(harness);

    expect(root(harness).querySelector('.section-form__slug-conflict')?.textContent?.trim()).toBe(
      message,
    );
    // A failed save stays on the form so the slug can be fixed in place.
    expect(TestBed.inject(Router).url).toBe('/sections/new');
  });

  it('clears the conflict as soon as the slug is edited', async () => {
    setup({ saveFails: conflictError('Taken') });
    const harness = await open('/sections/new');

    await typeInto(harness, 'title', EN, '<p>Listening</p>');
    await submit(harness);
    expect(root(harness).querySelector('.section-form__slug-conflict')).not.toBeNull();

    fillSlug(harness, 'listening-practice');

    expect(root(harness).querySelector('.section-form__slug-conflict')).toBeNull();
  });

  it('sends a deep link to a missing section back to the tree', async () => {
    setup({ sections: [] });

    await open('/sections/zzzz0000zzzz0000zzzz');

    expect(TestBed.inject(Router).url).toBe('/sections');
  });

  it('stays on the new section own route after a create', async () => {
    const created = section('new-1', {
      parentId: GRAMMAR.id,
      ancestorIds: [GRAMMAR.id],
      depth: 1,
      slug: 'present-simple',
      path: `${GRAMMAR_PATH}/present-simple`,
      title: { en: 'Present simple' },
    });
    setup({ sections: [GRAMMAR, created], saved: created });
    const harness = await open('/sections/new?parentId=grammar');

    await typeInto(harness, 'title', EN, '<p>Present simple</p>');
    await submit(harness);

    expect(TestBed.inject(Router).url).toBe('/sections/new-1');
    await harness.fixture.whenStable();
    harness.detectChanges();
    expect(root(harness).querySelector('.section-form__path')?.textContent).toContain(
      '/grammar-points/present-simple',
    );
  });

  it('leaves the form pristine after a save, so leaving does not prompt', async () => {
    const recorded = setup({ sections: [STORED] });
    const harness = await open('/sections/sec-1');

    await typeInto(harness, 'title', EN, '<p>Present simple, revised</p>');
    expect(page(harness).hasUnsavedChanges()).toBe(true);

    await submit(harness);

    // The classic bug: the guard firing on the navigation the save triggers.
    expect(recorded.dialogs).toBe(0);
    expect(TestBed.inject(Router).url).toBe('/sections');
    expect(recorded.successes).toEqual(['Section saved.']);
  });

  it('asks before leaving a form the author edited and did not save', async () => {
    const recorded = setup({ sections: [STORED] });
    const harness = await open('/sections/sec-1');

    await typeInto(harness, 'title', EN, '<p>Half an edit</p>');
    await TestBed.inject(Router).navigate(['/sections']);
    await harness.fixture.whenStable();

    expect(recorded.dialogs).toBe(1);
  });

  it('does not ask when the form was never touched', async () => {
    const recorded = setup({ sections: [STORED] });
    const harness = await open('/sections/sec-1');

    await TestBed.inject(Router).navigate(['/sections']);
    await harness.fixture.whenStable();

    expect(recorded.dialogs).toBe(0);
    expect(TestBed.inject(Router).url).toBe('/sections');
  });
});
