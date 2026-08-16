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
import {
  h5pExercisePageBodySchema,
  pageBodySchema,
  type ContentPage,
  type ListSectionsQuery,
  type LocaleCode,
  type Page,
  type PageBody,
  type Section,
  type SectionTreeNode,
} from '@speakukrainian/shared';
import { LocalesStore } from '../../core/locales/locales.store';
import { NotificationService } from '../../core/notifications/notification.service';
import { unsavedChangesGuard } from '../../core/router/unsaved-changes.guard';
import { MediaPickerService } from '../../shared/media/media-picker.service';
import { RichTextEditor } from '../../shared/rich-text/rich-text-editor';
import { SectionsApi } from '../sections/sections.api';
import { EXERCISE_RESULT_STATE, type ExerciseResult } from './h5p-exercise.model';
import {
  EXERCISE_NEEDS_PAGE,
  EXERCISE_NEEDS_SAVE,
  NO_EXERCISE_YET,
  PAGE_NEEDS_SECTION,
  SECTION_CANNOT_HOLD_PAGES,
} from './page-messages';
import { PageFormPage } from './page-form-page';
import { pageFormResolver } from './page-form.resolver';
import { PagesApi } from './pages.api';

const EN = 0;
const UK = 1;

const audit = {
  createdAt: '2026-01-01T00:00:00Z',
  createdBy: 'admin',
  updatedAt: '2026-01-01T00:00:00Z',
  updatedBy: 'admin',
};

const CLIP = {
  path: 'audio/2026/01/x.mp3',
  url: 'https://cdn.test/audio/2026/01/x.mp3',
  contentType: 'audio/mpeg',
  sizeBytes: 2048,
};

const audioHtml = `<audio src="${CLIP.url}" data-asset-path="${CLIP.path}" controls="true"></audio>`;

const GRAMMAR: Section = {
  id: 'grammar',
  parentId: null,
  ancestorIds: [],
  depth: 0,
  kind: 'content',
  slug: 'grammar-points',
  path: '/grammar-points',
  title: { en: 'Grammar points' },
  showInMenu: false,
  sortOrder: 0,
  status: 'published',
  audit,
};

const LINKS: Section = {
  ...GRAMMAR,
  id: 'links',
  kind: 'link',
  slug: 'links',
  path: '/links',
  title: { en: 'Elsewhere' },
  link: { type: 'external', href: 'https://example.test/course', openInNewTab: true },
};

function page(id: string, overrides: Partial<ContentPage> = {}): ContentPage {
  return {
    id,
    sectionId: GRAMMAR.id,
    slug: id,
    path: `/grammar-points/${id}`,
    title: { en: id },
    body: { type: 'rich_text', content: {}, audioAssets: [], imageAssets: [] },
    sortOrder: 2,
    status: 'draft',
    publishedAt: null,
    audit,
    ...overrides,
  };
}

const STORED = page('page-1', {
  slug: 'present-simple',
  path: '/grammar-points/present-simple',
  title: { en: 'Present simple', uk: 'Теперішній простий' },
});

function exerciseBody(h5pContentId: string | null): PageBody {
  return {
    type: 'h5p_exercise',
    h5pContentId,
    explanationPosition: 'above',
    trackResults: false,
  };
}

const EXERCISE_PAGE = page('page-h5p', {
  slug: 'telling-the-time',
  path: '/grammar-points/telling-the-time',
  body: exerciseBody(null),
});

@Component({ selector: 'app-pages-list-stub', template: 'list' })
class ListStub {}

interface Options {
  pages?: ContentPage[];
  sections?: Section[];
  /** What `GET /sections?parentId=…` answers, for the subsection-list preview. */
  children?: Section[];
  saved?: ContentPage;
  saveFails?: unknown;
  published?: ContentPage;
}

interface Recorded {
  calls: { method: string; args: unknown[] }[];
  dialogs: number;
  successes: string[];
  errors: string[];
}

function setup(options: Options = {}): Recorded {
  const stored = new Map((options.pages ?? []).map((entry) => [entry.id, entry]));
  const sections = new Map((options.sections ?? [GRAMMAR]).map((entry) => [entry.id, entry]));
  const recorded: Recorded = { calls: [], dialogs: 0, successes: [], errors: [] };
  const saved =
    options.saved ?? page('new-1', { slug: 'created', path: '/grammar-points/created' });

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
    publish: (id: string) => {
      recorded.calls.push({ method: 'publish', args: [id] });
      return of(
        options.published ??
          page(id, { status: 'published', publishedAt: '2026-03-01T09:00:00.000Z' }),
      );
    },
    unpublish: (id: string) => {
      recorded.calls.push({ method: 'unpublish', args: [id] });
      return of(page(id, { status: 'draft', publishedAt: '2026-03-01T09:00:00.000Z' }));
    },
  } as unknown as PagesApi;

  // `tree` and `list` are here for the `subsection_list` body editor, which the
  // shell constructs for `?type=subsection_list` and which loads its own data.
  const sectionsApi = {
    get: (id: string) => {
      const found = sections.get(id);
      return found === undefined
        ? throwError(() => new HttpErrorResponse({ status: 404, statusText: 'Not Found' }))
        : of(found);
    },
    tree: () =>
      of<SectionTreeNode[]>(
        Array.from(sections.values(), (entry) => ({ ...entry, children: [] as SectionTreeNode[] })),
      ),
    list: (query: ListSectionsQuery) => {
      recorded.calls.push({ method: 'sections.list', args: [query] });
      return of<Page<Section>>({ items: options.children ?? [], nextCursor: null });
    },
  } as unknown as SectionsApi;

  TestBed.configureTestingModule({
    providers: [
      provideNoopAnimations(),
      provideRouter(
        [
          { path: 'pages', component: ListStub },
          {
            path: 'pages/new',
            component: PageFormPage,
            resolve: { formData: pageFormResolver },
            canDeactivate: [unsavedChangesGuard],
          },
          {
            path: 'pages/:id',
            component: PageFormPage,
            resolve: { formData: pageFormResolver },
            canDeactivate: [unsavedChangesGuard],
          },
        ],
        withComponentInputBinding(),
      ),
      { provide: PagesApi, useValue: api },
      { provide: SectionsApi, useValue: sectionsApi },
      {
        provide: LocalesStore,
        useValue: {
          // Two locales rather than the seeded three: every tab is a TipTap
          // instance, and two is enough to prove the per-locale behaviour.
          codes: signal<LocaleCode[]>(['en', 'uk']).asReadonly(),
          defaultCode: signal<LocaleCode | null>('en').asReadonly(),
        } as unknown as LocalesStore,
      },
      {
        provide: MediaPickerService,
        useValue: {
          pickImage: () => Promise.resolve(null),
          pickAudio: () => Promise.resolve(null),
        } as unknown as MediaPickerService,
      },
      {
        provide: NotificationService,
        useValue: {
          success: (message: string) => recorded.successes.push(message),
          info: () => {},
          error: (message: string) => recorded.errors.push(message),
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
    throw new Error('Expected the page form to be the activated route');
  }
  return element;
}

function form(harness: RouterTestingHarness): PageFormPage {
  return harness.routeDebugElement?.componentInstance as PageFormPage;
}

/**
 * The body control's value. Read off the component because a type this release
 * has no editor for renders nothing that shows it — which is the case under
 * test, and the reason a wrong value there stays invisible until #10 or #13
 * gives that type an editor.
 */
function bodyValue(harness: RouterTestingHarness): PageBody {
  return form(harness)['form'].controls.body.value;
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

/** The enabled anchor to the widget route, or `null` when it is refused. */
function exerciseLink(harness: RouterTestingHarness): HTMLAnchorElement | null {
  return root(harness).querySelector<HTMLAnchorElement>('a.page-form__exercise-link');
}

/** The sentence shown in place of the link, or `null` when the link is there. */
function exerciseBlocked(harness: RouterTestingHarness): string | null {
  return root(harness).querySelector('.page-form__exercise-blocked')?.textContent?.trim() ?? null;
}

/**
 * What the widget route leaves behind on the way back. Written into
 * `history.state` directly, because the router replays it from there on a
 * refresh — which is the case the pristine assertion below covers.
 */
function withExerciseResult(result: ExerciseResult): void {
  history.replaceState({ [EXERCISE_RESULT_STATE]: result }, '');
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
  selector: string,
  index: number,
): Promise<DebugElement> {
  const host = harness.fixture.debugElement.query(By.css(selector));
  if (!host) {
    throw new Error(`Expected an editor matching "${selector}"`);
  }
  const tabs = (host.nativeElement as HTMLElement).querySelectorAll<HTMLElement>('[role="tab"]');
  const tab = tabs[index];
  if (!tab) {
    throw new Error(`Expected a tab at index ${index} of "${selector}"`);
  }
  tab.click();
  for (let pass = 0; pass < 2; pass += 1) {
    harness.detectChanges();
    await harness.fixture.whenStable();
  }
  harness.detectChanges();

  const editor = host.query(By.directive(RichTextEditor));
  if (!editor) {
    throw new Error(`Expected the active tab of "${selector}" to hold an editor`);
  }
  return editor;
}

async function typeInto(
  harness: RouterTestingHarness,
  selector: string,
  index: number,
  html: string,
): Promise<void> {
  const editor = await localeTab(harness, selector, index);
  editor.injector.get(NgModel).viewToModelUpdate(html);
  harness.detectChanges();
}

async function renderedIn(
  harness: RouterTestingHarness,
  selector: string,
  index: number,
): Promise<HTMLElement> {
  const editor = (await localeTab(harness, selector, index)).nativeElement as HTMLElement;
  const content = editor.querySelector<HTMLElement>('.rte__content');
  if (!content) {
    throw new Error('Expected the editor to render its content area');
  }
  return content;
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

function richTextBodyOf(
  calls: { method: string; args: unknown[] }[],
  method: string,
): { content: Record<string, string>; audioAssets: unknown[]; imageAssets: unknown[] } {
  return bodyOf(calls, method)['body'] as {
    content: Record<string, string>;
    audioAssets: unknown[];
    imageAssets: unknown[];
  };
}

function conflictError(message: string): HttpErrorResponse {
  return new HttpErrorResponse({
    status: 409,
    statusText: 'Conflict',
    error: { statusCode: 409, message, path: '/api/pages', timestamp: '2026-01-01T00:00:00.000Z' },
  });
}

const TITLE = 'app-localized-rich-text-editor[formControlName="title"]';
const META_TITLE = 'app-localized-rich-text-editor[formControlName="metaTitle"]';
const BODY = 'app-rich-text-page-body-editor';
const SUBSECTION_BODY = 'app-subsection-list-page-body-editor';

describe('PageFormPage', () => {
  beforeEach(() => {
    history.replaceState({}, '');
  });

  it('creates a page under a section and lands on its stored path', async () => {
    const created = page('new-1', {
      slug: 'present-simple',
      path: '/grammar-points/present-simple',
      title: { en: 'Present simple' },
    });
    const { calls } = setup({ pages: [created], saved: created });
    const harness = await open('/pages/new?sectionId=grammar&type=rich_text');

    expect(root(harness).querySelector('.page-form__section')?.textContent).toContain(
      'Grammar points',
    );

    await typeInto(harness, TITLE, EN, '<p>Present Simple</p>');

    // The slug is suggested from the default-locale title, and the derived path
    // is shown before anything is saved.
    expect(slugField(harness).value).toBe('present-simple');
    expect(root(harness).querySelector('.page-form__path')?.textContent).toContain(
      '/grammar-points/present-simple',
    );

    await submit(harness);

    const body = bodyOf(calls, 'create');
    expect(body['sectionId']).toBe('grammar');
    expect(body['slug']).toBe('present-simple');
    expect(body['title']).toEqual({ en: 'Present Simple' });
    expect(richTextBodyOf(calls, 'create').content).toEqual({});

    // AC1: the stored path is on the form after saving.
    expect(TestBed.inject(Router).url).toBe('/pages/new-1');
    await harness.fixture.whenStable();
    harness.detectChanges();
    expect(root(harness).querySelector('.page-form__path')?.textContent).toContain(
      '/grammar-points/present-simple',
    );
  });

  it('renders a stored audio node in its own locale tab and in no other', async () => {
    // AC2 as far as jsdom reaches — the node is re-rendered as an `<audio
    // controls>` carrying the storage path — and AC3's model half.
    const stored = page('page-2', {
      body: {
        type: 'rich_text',
        content: { uk: audioHtml },
        audioAssets: [CLIP],
        imageAssets: [],
      },
    });
    setup({ pages: [stored] });
    const harness = await open('/pages/page-2');

    const uk = await renderedIn(harness, BODY, UK);
    const audio = uk.querySelector('audio');
    expect(audio?.getAttribute('data-asset-path')).toBe(CLIP.path);
    expect(audio?.getAttribute('src')).toBe(CLIP.url);
    expect(audio?.hasAttribute('controls')).toBe(true);

    expect((await renderedIn(harness, BODY, EN)).querySelector('audio')).toBeNull();
  });

  it('keeps a stored clip in audioAssets when only the title is edited', async () => {
    const stored = page('page-3', {
      body: {
        type: 'rich_text',
        content: { uk: audioHtml },
        audioAssets: [CLIP],
        imageAssets: [],
      },
    });
    const { calls } = setup({ pages: [stored] });
    const harness = await open('/pages/page-3');

    await typeInto(harness, TITLE, EN, '<p>A new title</p>');
    await submit(harness);

    expect(richTextBodyOf(calls, 'update').audioAssets).toEqual([CLIP]);
  });

  it('drops a clip from audioAssets once it is removed from the content', async () => {
    // AC4's second half.
    const stored = page('page-4', {
      body: {
        type: 'rich_text',
        content: { uk: audioHtml },
        audioAssets: [CLIP],
        imageAssets: [],
      },
    });
    const { calls } = setup({ pages: [stored] });
    const harness = await open('/pages/page-4');

    await typeInto(harness, BODY, UK, '<p>The clip is gone</p>');
    await submit(harness);

    expect(richTextBodyOf(calls, 'update').audioAssets).toEqual([]);
  });

  it('publishes and unpublishes through the endpoints, not through the payload', async () => {
    const { calls } = setup({ pages: [STORED] });
    const harness = await open('/pages/page-1');

    expect(root(harness).querySelector('.page-form__status')?.textContent?.trim()).toBe('draft');

    root(harness).querySelector<HTMLButtonElement>('.page-form__publish')?.click();
    await harness.fixture.whenStable();
    harness.detectChanges();

    expect(calls.some((call) => call.method === 'publish')).toBe(true);
    expect(root(harness).querySelector('.page-form__status')?.textContent?.trim()).toBe(
      'published',
    );
    expect(root(harness).querySelector('.page-form__published-at')?.textContent).toContain(
      'Published',
    );

    root(harness).querySelector<HTMLButtonElement>('.page-form__unpublish')?.click();
    await harness.fixture.whenStable();
    harness.detectChanges();

    expect(calls.some((call) => call.method === 'unpublish')).toBe(true);
    expect(root(harness).querySelector('.page-form__status')?.textContent?.trim()).toBe('draft');
  });

  it('calls the kept date the last one once the page is a draft again', async () => {
    // The API keeps `publishedAt` through an unpublish, so the date outlives the
    // status. Left as "Published …" beside a `draft` chip it reads as a
    // contradiction, and an author cannot tell which of the two to believe.
    const live = page('page-7', { status: 'published', publishedAt: '2026-03-01T09:00:00.000Z' });
    setup({ pages: [live] });
    const harness = await open('/pages/page-7');

    const publishedAt = (): string =>
      root(harness).querySelector('.page-form__published-at')?.textContent?.trim() ?? '';
    expect(publishedAt()).toMatch(/^Published /);

    root(harness).querySelector<HTMLButtonElement>('.page-form__unpublish')?.click();
    await harness.fixture.whenStable();
    harness.detectChanges();

    expect(root(harness).querySelector('.page-form__status')?.textContent?.trim()).toBe('draft');
    expect(publishedAt()).toMatch(/^Last published /);
  });

  it('refuses to publish while the form has unsaved edits', async () => {
    // Publish patches `status` alone, so the unsaved body would not be written.
    const { calls } = setup({ pages: [STORED] });
    const harness = await open('/pages/page-1');

    await typeInto(harness, BODY, UK, '<p>Half an edit</p>');

    const publish = root(harness).querySelector<HTMLButtonElement>('.page-form__publish');
    expect(publish?.disabled).toBe(true);
    expect(root(harness).querySelector('.page-form__publish-blocked')?.textContent?.trim()).toBe(
      'Save your changes before publishing.',
    );

    publish?.click();
    await harness.fixture.whenStable();
    expect(calls.some((call) => call.method === 'publish')).toBe(false);
  });

  it('never sends status on an ordinary save', async () => {
    // `PagesRepository.update` merges the patch and re-runs `nextPublishedAt`,
    // so a `status` here would republish or unpublish a page nobody touched.
    const { calls } = setup({ pages: [STORED] });
    const harness = await open('/pages/page-1');

    fillSlug(harness, 'present-simple-renamed');
    await submit(harness);

    expect(Object.keys(bodyOf(calls, 'update'))).not.toContain('status');
    expect(Object.keys(bodyOf(calls, 'update')).sort()).toEqual([
      'body',
      'seo',
      'slug',
      'sortOrder',
      'title',
    ]);
  });

  it('leaves a tag-shaped title exactly as stored when nothing is edited', async () => {
    // The editor treats its value as HTML, so text that merely looks like
    // markup is truncated on the way in — and that truncation is what the next
    // save would store, rewriting content nobody touched.
    const awkward = page('page-5', {
      title: { en: 'Modal verbs <can>', uk: 'Tom & Jerry' },
      seo: { metaTitle: { en: 'a > b' }, noIndex: false },
    });
    const { calls } = setup({ pages: [awkward] });
    const harness = await open('/pages/page-5');

    expect((await renderedIn(harness, TITLE, EN)).textContent?.trim()).toBe('Modal verbs <can>');
    expect((await renderedIn(harness, TITLE, UK)).textContent?.trim()).toBe('Tom & Jerry');
    expect((await renderedIn(harness, META_TITLE, EN)).textContent?.trim()).toBe('a > b');

    await submit(harness);

    expect(bodyOf(calls, 'update')['title']).toEqual(awkward.title);
    expect(bodyOf(calls, 'update')['seo']).toEqual({ metaTitle: { en: 'a > b' }, noIndex: false });
  });

  it('keeps a stored ogImage the form never shows', async () => {
    // `seo` is replaced whole by the API, not merged, so a payload built from
    // this form's fields alone would delete it on the first save.
    const ogImage = {
      path: 'images/2026/01/og.png',
      url: 'https://cdn.test/images/2026/01/og.png',
      contentType: 'image/png',
      sizeBytes: 1024,
    };
    const stored = page('page-6', { seo: { ogImage, noIndex: false } });
    const { calls } = setup({ pages: [stored] });
    const harness = await open('/pages/page-6');

    await typeInto(harness, META_TITLE, EN, '<p>Present simple — grammar</p>');
    await submit(harness);

    expect(bodyOf(calls, 'update')['seo']).toEqual({
      ogImage,
      metaTitle: { en: 'Present simple — grammar' },
      noIndex: false,
    });
  });

  it('leaves the SEO text out of a save for a page that has never had any', async () => {
    // An omitted key would be noise on every page on every save; `noIndex` is
    // always sent, because the API replaces `seo` whole.
    const { calls } = setup({ pages: [STORED] });
    const harness = await open('/pages/page-1');

    fillSlug(harness, 'present-simple-2');
    await submit(harness);

    expect(bodyOf(calls, 'update')['seo']).toEqual({ noIndex: false });
  });

  it('binds a slug conflict to the field and clears it on the next edit', async () => {
    const message = 'Another page in this section already uses the slug "present-simple"';
    setup({ pages: [STORED], saveFails: conflictError(message) });
    const harness = await open('/pages/page-1');

    fillSlug(harness, 'present-simple');
    // A save has to be attempted for the API to answer, and the slug control is
    // marked dirty by the edit above.
    await submit(harness);

    expect(root(harness).querySelector('.page-form__slug-conflict')?.textContent?.trim()).toBe(
      message,
    );
    expect(form(harness).hasUnsavedChanges()).toBe(true);
    // A failed save stays on the form so the slug can be fixed in place.
    expect(TestBed.inject(Router).url).toBe('/pages/page-1');

    fillSlug(harness, 'present-simple-2');

    expect(root(harness).querySelector('.page-form__slug-conflict')).toBeNull();
  });

  it('asks before leaving a page with unsaved edits, and not after a save', async () => {
    const recorded = setup({ pages: [STORED] });
    const harness = await open('/pages/page-1');

    await typeInto(harness, BODY, UK, '<p>Half an edit</p>');
    expect(form(harness).hasUnsavedChanges()).toBe(true);

    await TestBed.inject(Router).navigate(['/pages']);
    await harness.fixture.whenStable();

    expect(recorded.dialogs).toBe(1);
  });

  it('does not prompt on the navigation a save itself triggers', async () => {
    const recorded = setup({ pages: [STORED] });
    const harness = await open('/pages/page-1');

    await typeInto(harness, TITLE, EN, '<p>Present simple, revised</p>');
    await submit(harness);

    expect(recorded.dialogs).toBe(0);
    expect(TestBed.inject(Router).url).toBe('/pages?sectionId=grammar');
    expect(recorded.successes).toEqual(['Page saved.']);
  });

  it('cancels back to the same filtered list a save returns to', async () => {
    // Both ways out of the form lead to the list; only one of them keeping the
    // section the author arrived with would leave them among every page there is.
    setup({ pages: [STORED] });
    const harness = await open('/pages/page-1');

    const cancel = root(harness).querySelector<HTMLAnchorElement>('.page-form__actions a');
    expect(cancel?.getAttribute('href')).toBe('/pages?sectionId=grammar');

    cancel?.click();
    await harness.fixture.whenStable();

    expect(TestBed.inject(Router).url).toBe('/pages?sectionId=grammar');
  });

  it('does not prompt when the form was never touched', async () => {
    const recorded = setup({ pages: [STORED] });
    const harness = await open('/pages/page-1');

    await TestBed.inject(Router).navigate(['/pages']);
    await harness.fixture.whenStable();

    expect(recorded.dialogs).toBe(0);
    expect(TestBed.inject(Router).url).toBe('/pages');
  });

  it('opens the exercise panel for an H5P page and lets it be saved', async () => {
    const { calls } = setup();
    const harness = await open('/pages/new?sectionId=grammar&type=h5p_exercise');

    expect(root(harness).querySelector('.page-form__exercise-empty')?.textContent?.trim()).toBe(
      NO_EXERCISE_YET,
    );
    expect(root(harness).querySelector(BODY)).toBeNull();

    await typeInto(harness, TITLE, EN, '<p>An exercise</p>');
    expect(saveButton(harness).disabled).toBe(false);

    await submit(harness);

    // The posted body is one the API would store, not a bare discriminant.
    expect(h5pExercisePageBodySchema.safeParse(bodyOf(calls, 'create')['body']).success).toBe(true);
  });

  it('has no exercise link on a page that has not been created yet', async () => {
    // The widget route is keyed on a stored page id, so there is nothing to
    // link to until the page exists.
    setup();
    const harness = await open('/pages/new?sectionId=grammar&type=h5p_exercise');

    expect(exerciseLink(harness)).toBeNull();
    expect(exerciseBlocked(harness)).toBe(EXERCISE_NEEDS_PAGE);
  });

  it('links to the widget on a saved page, and withdraws the link once the form is dirty', async () => {
    // The widget route reads the stored page, so an unsaved edit would be
    // invisible to it and overwritten on the way back.
    setup({ pages: [EXERCISE_PAGE] });
    const harness = await open('/pages/page-h5p');

    expect(exerciseLink(harness)?.getAttribute('href')).toBe('/pages/page-h5p/exercise');
    expect(exerciseBlocked(harness)).toBeNull();

    fillSlug(harness, 'telling-the-time-2');

    expect(exerciseLink(harness)).toBeNull();
    expect(exerciseBlocked(harness)).toBe(EXERCISE_NEEDS_SAVE);
  });

  it('takes the exercise the widget route saved onto the body, for the author to save', async () => {
    const { calls } = setup({ pages: [EXERCISE_PAGE] });
    withExerciseResult({ contentId: 'c-9', mainLibrary: 'H5P.MultiChoice 1.16' });
    const harness = await open('/pages/page-h5p');

    expect(form(harness).hasUnsavedChanges()).toBe(true);
    expect(root(harness).querySelector('.page-form__exercise-id')?.textContent?.trim()).toBe('c-9');

    await submit(harness);

    expect(bodyOf(calls, 'update')['body']).toEqual({
      type: 'h5p_exercise',
      h5pContentId: 'c-9',
      h5pLibrary: 'H5P.MultiChoice 1.16',
      explanationPosition: 'above',
      trackResults: false,
    });
  });

  it('leaves the form pristine when a refresh replays the id the page already holds', async () => {
    // `history.state` outlives the navigation, so a refresh of `/pages/:id`
    // replays it; re-dirtying a form the author had already saved is the defect.
    setup({ pages: [page('page-h5p-2', { body: exerciseBody('c-9') })] });
    withExerciseResult({ contentId: 'c-9', mainLibrary: 'H5P.MultiChoice 1.16' });
    const harness = await open('/pages/page-h5p-2');

    expect(form(harness).hasUnsavedChanges()).toBe(false);
    expect(root(harness).querySelector('.page-form__exercise-id')?.textContent?.trim()).toBe('c-9');
  });

  it('seeds the body control with the type the route asked for', async () => {
    // The shell has no editor for this type yet, so nothing on screen shows what
    // the control holds. A `rich_text` body seeded here would be posted for a
    // `subsection_list` page — silently, by an author who filled in the title
    // and pressed Save — the moment #10 gives the type an editor and Save stops
    // being disabled.
    setup();
    const harness = await open('/pages/new?sectionId=grammar&type=subsection_list');

    const body = bodyValue(harness);
    expect(body.type).toBe('subsection_list');
    // And it is a body the API would accept, not a bare discriminant.
    expect(pageBodySchema.safeParse(body).success).toBe(true);
  });

  it('gives a subsection list page its own editor, and lets it be saved', async () => {
    // The seam: the shell picks the branch from the route's type, and the body
    // component behind it is what makes the form valid.
    setup();
    const harness = await open('/pages/new?sectionId=grammar&type=subsection_list');

    expect(root(harness).querySelector(SUBSECTION_BODY)).not.toBeNull();
    // The branch is chosen, not merely reached: the other two types' panels are
    // absent. (This replaces an assertion on `.page-form__body-unavailable`,
    // which no longer exists and so could not fail.)
    expect(root(harness).querySelector(BODY)).toBeNull();
    expect(root(harness).querySelector('.page-form__exercise-empty')).toBeNull();
    expect(saveButton(harness).disabled).toBe(true);

    await typeInto(harness, TITLE, EN, '<p>Grammar points</p>');

    expect(saveButton(harness).disabled).toBe(false);
  });

  it('posts a subsection list body that stores no source section', async () => {
    // Keeping the default has to be the *absence* of the key: the section id
    // copied in would pin the page to a section it merely lives in today.
    const { calls } = setup();
    const harness = await open('/pages/new?sectionId=grammar&type=subsection_list');

    await typeInto(harness, TITLE, EN, '<p>Grammar points</p>');
    await submit(harness);

    expect(bodyOf(calls, 'create')['body']).toEqual({
      type: 'subsection_list',
      layout: 'grid',
      showImages: true,
      showDescriptions: true,
    });
  });

  it('still seeds a rich text page with a rich text body', async () => {
    setup();
    const harness = await open('/pages/new?sectionId=grammar&type=rich_text');

    expect(bodyValue(harness)).toEqual({
      type: 'rich_text',
      content: {},
      audioAssets: [],
      imageAssets: [],
    });
  });

  it('sends /pages/new for a link section back to the list, saying why', async () => {
    // The list and the section tree both refuse to offer "Add page" here; a
    // hand-typed URL is the third way in, and the API answers 422.
    const recorded = setup({ sections: [LINKS] });

    await open('/pages/new?sectionId=links&type=rich_text');

    expect(TestBed.inject(Router).url).toBe('/pages');
    expect(recorded.errors).toEqual([SECTION_CANNOT_HOLD_PAGES]);
  });

  it('sends /pages/new with no section back to the list, saying why', async () => {
    const recorded = setup();

    await open('/pages/new');

    expect(TestBed.inject(Router).url).toBe('/pages');
    expect(recorded.errors).toEqual([PAGE_NEEDS_SECTION]);
  });

  it('sends a deep link to a missing page back to the list', async () => {
    const recorded = setup({ pages: [] });

    await open('/pages/zzzz0000zzzz0000zzzz');

    expect(TestBed.inject(Router).url).toBe('/pages');
    // The interceptor has already toasted the API's own 404 wording.
    expect(recorded.errors).toEqual([]);
  });

  it('still opens a page whose section could not be read', async () => {
    // The section is only wanted for its title; refusing to open the form would
    // leave the one screen that could repair the page unreachable.
    setup({ pages: [STORED], sections: [] });
    const harness = await open('/pages/page-1');

    expect(TestBed.inject(Router).url).toBe('/pages/page-1');
    // The path still comes out right, read back off the page's own path.
    expect(root(harness).querySelector('.page-form__path')?.textContent).toContain(
      '/grammar-points/present-simple',
    );
  });

  it('treats an emptied sort order on an edit as an error, not a no-op', async () => {
    const { calls } = setup({ pages: [STORED] });
    const harness = await open('/pages/page-1');

    const input = root(harness).querySelector<HTMLInputElement>(
      'input[formControlName="sortOrder"]',
    );
    if (!input) {
      throw new Error('Expected a sort order field');
    }
    input.value = '';
    input.dispatchEvent(new Event('input'));
    harness.detectChanges();

    expect(root(harness).querySelector('.page-form__sort-order-error')?.textContent?.trim()).toBe(
      'Give the page a position.',
    );
    expect(saveButton(harness).disabled).toBe(true);

    await submit(harness);
    expect(calls.some((call) => call.method === 'update')).toBe(false);
  });

  it('leaves the sort order out of a create that was left empty', async () => {
    const { calls } = setup();
    const harness = await open('/pages/new?sectionId=grammar&type=rich_text');

    await typeInto(harness, TITLE, EN, '<p>Listening</p>');
    await submit(harness);

    expect(Object.keys(bodyOf(calls, 'create'))).not.toContain('sortOrder');
  });

  it('says what a brand-new form is missing before the author touches anything', async () => {
    setup();
    const harness = await open('/pages/new?sectionId=grammar&type=rich_text');

    expect(saveButton(harness).disabled).toBe(true);
    expect(root(harness).querySelector('.page-form__error')?.textContent?.trim()).toBe(
      'Give the page a title in the default locale.',
    );
    // Nothing painted red on a pristine form, and the hints are still there.
    expect(root(harness).querySelectorAll('.mat-form-field-invalid')).toHaveLength(0);
  });

  it('never rewrites an existing page slug from its title', async () => {
    const { calls } = setup({ pages: [STORED] });
    const harness = await open('/pages/page-1');

    await typeInto(harness, TITLE, EN, '<p>Something else entirely</p>');

    expect(slugField(harness).value).toBe('present-simple');

    await submit(harness);

    expect(bodyOf(calls, 'update')['slug']).toBe('present-simple');
    expect(bodyOf(calls, 'update')['title']).toEqual({
      en: 'Something else entirely',
      uk: 'Теперішній простий',
    });
  });
});
