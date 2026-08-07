import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { MatTooltip } from '@angular/material/tooltip';
import { Router, provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  ContentPage,
  LocaleCode,
  ListPagesQuery,
  Page,
  Section,
  SectionTreeNode,
} from '@speakukrainian/shared';
import { LocalesStore } from '../../core/locales/locales.store';
import { NotificationService } from '../../core/notifications/notification.service';
import { SectionsApi } from '../sections/sections.api';
import { PICK_SECTION_FIRST, SECTION_CANNOT_HOLD_PAGES } from './page-messages';
import { PagesPage } from './pages-page';
import { pagesListResolver } from './pages-list.resolver';
import { PagesApi } from './pages.api';

const audit = {
  createdAt: '2026-01-01T00:00:00Z',
  createdBy: 'admin',
  updatedAt: '2026-02-03T10:00:00Z',
  updatedBy: 'admin',
};

function node(id: string, overrides: Partial<SectionTreeNode> = {}): SectionTreeNode {
  const base: Section = {
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
  };
  return { ...base, children: [], ...overrides };
}

const GRAMMAR = node('grammar', {
  title: { en: 'Grammar points' },
  slug: 'grammar-points',
  path: '/grammar-points',
});

const LISTENING = node('listening', { title: { en: 'Listening' }, path: '/listening' });

const DOCS = node('docs', {
  kind: 'link',
  title: { en: 'Docs' },
  path: '/docs',
  link: { type: 'external', href: 'https://example.com', openInNewTab: false },
});

function page(id: string, overrides: Partial<ContentPage> = {}): ContentPage {
  return {
    id,
    sectionId: GRAMMAR.id,
    slug: id,
    path: `/grammar-points/${id}`,
    title: { en: id },
    body: { type: 'rich_text', content: {}, audioAssets: [], imageAssets: [] },
    sortOrder: 0,
    status: 'draft',
    publishedAt: null,
    audit,
    ...overrides,
  };
}

const PRESENT_SIMPLE = page('present-simple', {
  title: { en: 'Present simple' },
  path: '/grammar-points/present-simple',
});

const CLIPS = page('clips', {
  sectionId: LISTENING.id,
  title: { en: 'Clips' },
  path: '/listening/clips',
});

@Component({ selector: 'app-page-form-stub', template: 'form' })
class FormStub {}

interface Options {
  pages?: ContentPage[];
  tree?: SectionTreeNode[];
  nextCursor?: string | null;
  more?: ContentPage[];
  listFails?: boolean;
}

interface Recorded {
  queries: ListPagesQuery[];
}

function setup(options: Options = {}): Recorded {
  const recorded: Recorded = { queries: [] };
  const all = options.pages ?? [PRESENT_SIMPLE, CLIPS];

  const api = {
    list: (query: ListPagesQuery) => {
      recorded.queries.push(query);
      if (options.listFails === true) {
        return throwError(() => new Error('offline'));
      }
      if (query.cursor !== undefined) {
        return of<Page<ContentPage>>({ items: options.more ?? [], nextCursor: null });
      }
      const items =
        query.sectionId === undefined
          ? all
          : all.filter((entry) => entry.sectionId === query.sectionId);
      return of<Page<ContentPage>>({ items, nextCursor: options.nextCursor ?? null });
    },
  } as unknown as PagesApi;

  const sections = {
    tree: () => of(options.tree ?? [GRAMMAR, LISTENING, DOCS]),
  } as unknown as SectionsApi;

  TestBed.configureTestingModule({
    providers: [
      provideNoopAnimations(),
      provideRouter(
        [
          {
            path: 'pages',
            component: PagesPage,
            resolve: { listData: pagesListResolver },
            runGuardsAndResolvers: 'paramsOrQueryParamsChange',
          },
          { path: 'pages/new', component: FormStub },
          { path: 'pages/:id', component: FormStub },
        ],
        withComponentInputBinding(),
      ),
      { provide: PagesApi, useValue: api },
      { provide: SectionsApi, useValue: sections },
      {
        provide: LocalesStore,
        useValue: {
          codes: signal<LocaleCode[]>(['en', 'uk']).asReadonly(),
          defaultCode: signal<LocaleCode | null>('en').asReadonly(),
        } as unknown as LocalesStore,
      },
      {
        provide: NotificationService,
        useValue: {
          success: () => {},
          info: () => {},
          error: () => {},
        } as unknown as NotificationService,
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
    throw new Error('Expected the pages list to be the activated route');
  }
  return element;
}

function titles(harness: RouterTestingHarness): string[] {
  return Array.from(
    root(harness).querySelectorAll('.pages__title'),
    (link) => link.textContent?.trim() ?? '',
  );
}

/** The reason a disabled "New page" gives, read off the tooltip directive itself. */
function tooltip(harness: RouterTestingHarness): string {
  const hint = harness.fixture.debugElement.query(By.css('.pages__new-hint'));
  if (!hint) {
    throw new Error('Expected the disabled New page action to carry a reason');
  }
  return hint.injector.get(MatTooltip).message;
}

/** Drives the filter the way a pointer would, so `selectionChange` really runs. */
async function chooseSection(harness: RouterTestingHarness, label: string): Promise<void> {
  const trigger = root(harness).querySelector<HTMLElement>(
    '.pages__section-filter .mat-mdc-select-trigger',
  );
  if (!trigger) {
    throw new Error('Expected a section filter');
  }
  trigger.click();
  harness.detectChanges();
  await harness.fixture.whenStable();

  const options = Array.from(document.querySelectorAll<HTMLElement>('mat-option'));
  const option = options.find((entry) => entry.textContent?.trim() === label);
  if (!option) {
    throw new Error(
      `Expected an option "${label}", found ${options.map((o) => o.textContent?.trim()).join(', ')}`,
    );
  }
  option.click();
  harness.detectChanges();
  await harness.fixture.whenStable();
  harness.detectChanges();
}

async function openNewPageMenu(harness: RouterTestingHarness): Promise<void> {
  const trigger = root(harness).querySelector<HTMLButtonElement>('button.pages__new');
  if (!trigger) {
    throw new Error('Expected a New page trigger');
  }
  trigger.click();
  harness.detectChanges();
  await harness.fixture.whenStable();
  harness.detectChanges();
}

/** The menu renders into an overlay, outside the component's own element. */
function newPageItems(): { label: string; href: string }[] {
  return Array.from(document.querySelectorAll<HTMLAnchorElement>('a.pages__new-type'), (item) => ({
    label: item.textContent?.trim() ?? '',
    href: item.getAttribute('href') ?? '',
  }));
}

describe('PagesPage', () => {
  beforeEach(() => {
    history.replaceState({}, '');
  });

  it('deep links to one section’s pages on a cold load', async () => {
    const { queries } = setup();
    const harness = await open('/pages?sectionId=grammar');

    expect(queries[0]?.sectionId).toBe('grammar');
    expect(titles(harness)).toEqual(['Present simple']);
  });

  it('lists every page when no section is chosen', async () => {
    const { queries } = setup();
    const harness = await open('/pages');

    expect(queries[0]?.sectionId).toBeUndefined();
    expect(titles(harness)).toEqual(['Present simple', 'Clips']);
  });

  it('re-resolves with the new section when the filter changes', async () => {
    const { queries } = setup();
    const harness = await open('/pages');

    await chooseSection(harness, 'Listening');

    expect(TestBed.inject(Router).url).toBe('/pages?sectionId=listening');
    expect(queries.at(-1)?.sectionId).toBe('listening');
    expect(titles(harness)).toEqual(['Clips']);
  });

  it('drops the query param when "All sections" is chosen', async () => {
    const { queries } = setup();
    const harness = await open('/pages?sectionId=grammar');

    await chooseSection(harness, 'All sections');

    expect(TestBed.inject(Router).url).toBe('/pages');
    expect(queries.at(-1)?.sectionId).toBeUndefined();
    expect(titles(harness)).toEqual(['Present simple', 'Clips']);
  });

  it('sends no sectionId at all for a value that is not a document id', async () => {
    // Passing it through would be a 400 for a query the author never typed.
    const { queries } = setup();
    await open('/pages?sectionId=..%2Fevil');

    expect(queries[0]?.sectionId).toBeUndefined();
  });

  it('shows the title, type, status, path and updated date, and links the title', async () => {
    setup({ pages: [{ ...PRESENT_SIMPLE, status: 'published' }] });
    const harness = await open('/pages');

    expect(root(harness).querySelector('.pages__title')?.getAttribute('href')).toBe(
      '/pages/present-simple',
    );
    expect(root(harness).querySelector('.pages__type')?.textContent?.trim()).toBe('Rich text');
    expect(root(harness).querySelector('.pages__status')?.textContent?.trim()).toBe('published');
    expect(root(harness).querySelector('.pages__path')?.textContent?.trim()).toBe(
      '/grammar-points/present-simple',
    );
    expect(root(harness).querySelector('.pages__updated')?.textContent?.trim()).not.toBe('');
  });

  it('shows the status the API answered with, with no store between the screens', async () => {
    // AC5's list half. The form publishes and navigates here; the list resolves
    // on every activation, so the new status is on screen without a reload.
    // Introducing a `providedIn: 'root'` page cache breaks this.
    let status: 'draft' | 'published' = 'draft';
    const recorded: ListPagesQuery[] = [];
    const api = {
      list: (query: ListPagesQuery) => {
        recorded.push(query);
        return of<Page<ContentPage>>({
          items: [{ ...PRESENT_SIMPLE, status }],
          nextCursor: null,
        });
      },
    } as unknown as PagesApi;

    setup();
    TestBed.overrideProvider(PagesApi, { useValue: api });

    const harness = await open('/pages?sectionId=grammar');
    expect(root(harness).querySelector('.pages__status')?.textContent?.trim()).toBe('draft');

    status = 'published';
    await TestBed.inject(Router).navigate(['/pages', 'present-simple']);
    await TestBed.inject(Router).navigate(['/pages'], { queryParams: { sectionId: 'grammar' } });
    await harness.fixture.whenStable();
    harness.detectChanges();

    expect(root(harness).querySelector('.pages__status')?.textContent?.trim()).toBe('published');
    expect(recorded).toHaveLength(2);
  });

  it('offers New page only for a section that can hold one, one item per authorable type', async () => {
    setup();
    const harness = await open('/pages');

    // No filter: nothing to create the page inside.
    expect(root(harness).querySelector<HTMLButtonElement>('button.pages__new')?.disabled).toBe(
      true,
    );
    expect(tooltip(harness)).toBe(PICK_SECTION_FIRST);

    await chooseSection(harness, 'Grammar points');
    await openNewPageMenu(harness);

    expect(newPageItems()).toEqual([
      { label: 'Rich text', href: '/pages/new?sectionId=grammar&type=rich_text' },
      { label: 'Subsection list', href: '/pages/new?sectionId=grammar&type=subsection_list' },
    ]);
    // #13 adds this one; offering it now would open a form with no body editor.
    expect(newPageItems().some((item) => item.href.includes('h5p_exercise'))).toBe(false);
  });

  it('refuses New page for a link section, which the API would reject', async () => {
    setup();
    const harness = await open('/pages?sectionId=docs');

    const trigger = root(harness).querySelector<HTMLButtonElement>('button.pages__new');
    expect(trigger?.disabled).toBe(true);

    // Pressing it anyway opens nothing, so there is no type to choose either.
    trigger?.click();
    harness.detectChanges();
    await harness.fixture.whenStable();

    expect(newPageItems()).toEqual([]);
    expect(tooltip(harness)).toBe(SECTION_CANNOT_HOLD_PAGES);
  });

  it('appends the next cursor’s pages and then hides Load more', async () => {
    const second = page('past-simple', {
      title: { en: 'Past simple' },
      path: '/grammar-points/past-simple',
    });
    const { queries } = setup({
      pages: [PRESENT_SIMPLE],
      nextCursor: 'cursor-1',
      more: [second],
    });
    const harness = await open('/pages?sectionId=grammar');

    root(harness).querySelector<HTMLButtonElement>('.pages__load-more')?.click();
    await harness.fixture.whenStable();
    harness.detectChanges();

    expect(titles(harness)).toEqual(['Present simple', 'Past simple']);
    expect(queries.at(-1)?.cursor).toBe('cursor-1');
    expect(root(harness).querySelector('.pages__load-more')).toBeNull();
  });

  it('has no Load more when there is no next cursor', async () => {
    setup();
    const harness = await open('/pages');

    expect(root(harness).querySelector('.pages__load-more')).toBeNull();
  });

  it('says the list failed rather than that the section is empty', async () => {
    setup({ listFails: true });
    const harness = await open('/pages');

    expect(root(harness).querySelector('.pages__failed')?.textContent?.trim()).toBe(
      'Could not load pages.',
    );
    expect(root(harness).querySelector('.pages__empty')).toBeNull();
  });

  it('says "No pages yet" for a section that really has none', async () => {
    setup({ pages: [] });
    const harness = await open('/pages');

    expect(root(harness).querySelector('.pages__empty')?.textContent?.trim()).toBe('No pages yet.');
    expect(root(harness).querySelector('.pages__failed')).toBeNull();
  });
});
