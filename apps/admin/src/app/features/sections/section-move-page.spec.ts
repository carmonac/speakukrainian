import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { Router, provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';
import type { LocaleCode, SectionTreeNode } from '@speakukrainian/shared';
import { LocalesStore } from '../../core/locales/locales.store';
import { NotificationService } from '../../core/notifications/notification.service';
import { MAX_DEPTH_MESSAGE, SECTION_GONE, TOP_LEVEL_OPTION } from './section-messages';
import { SectionMovePage } from './section-move-page';
import { sectionMoveResolver } from './section-move.resolver';
import { SectionsApi } from './sections.api';

@Component({ selector: 'app-sections-tree-stub', template: 'tree' })
class TreeStub {}

const audit = {
  createdAt: '2026-01-01T00:00:00Z',
  createdBy: 'admin',
  updatedAt: '2026-01-01T00:00:00Z',
  updatedBy: 'admin',
};

interface Shape {
  id: string;
  title?: string;
  children?: Shape[];
}

/** A tree with every derived field computed the way the API computes it. */
function build(shapes: Shape[], parent: SectionTreeNode | null = null): SectionTreeNode[] {
  return shapes.map((shape, index) => {
    const ancestorIds = parent === null ? [] : [...parent.ancestorIds, parent.id];
    const self: SectionTreeNode = {
      id: shape.id,
      parentId: parent === null ? null : parent.id,
      ancestorIds,
      depth: ancestorIds.length,
      kind: 'content',
      slug: shape.id,
      path: parent === null ? `/${shape.id}` : `${parent.path}/${shape.id}`,
      title: { en: shape.title ?? shape.id },
      showInMenu: false,
      sortOrder: index,
      status: 'draft',
      audit,
      children: [],
    };
    return { ...self, children: build(shape.children ?? [], self) };
  });
}

/**
 * grammar → (tenses → present-simple, articles), listening, and a four-deep
 * chain so a parent that would overflow the nesting limit really exists.
 */
const seeded = (): SectionTreeNode[] =>
  build([
    {
      id: 'grammar',
      title: 'Grammar',
      children: [
        { id: 'tenses', title: 'Tenses', children: [{ id: 'present', title: 'Present simple' }] },
        { id: 'articles', title: 'Articles' },
      ],
    },
    { id: 'listening', title: 'Listening' },
    {
      id: 'deep-0',
      title: 'Deep 0',
      children: [
        {
          id: 'deep-1',
          title: 'Deep 1',
          children: [
            { id: 'deep-2', title: 'Deep 2', children: [{ id: 'deep-3', title: 'Deep 3' }] },
          ],
        },
      ],
    },
  ]);

interface Options {
  tree?: SectionTreeNode[];
  treeFails?: unknown;
  moveFails?: unknown;
  defaultCode?: LocaleCode | null;
}

interface Harnessed {
  calls: { method: string; args: unknown[] }[];
  successes: string[];
  errors: string[];
}

function setup(options: Options = {}): Harnessed {
  const recorded: Harnessed = { calls: [], successes: [], errors: [] };
  const tree = options.tree ?? seeded();

  const api = {
    tree: () => {
      recorded.calls.push({ method: 'tree', args: [] });
      return options.treeFails === undefined ? of(tree) : throwError(() => options.treeFails);
    },
    move: (id: string, input: unknown) => {
      recorded.calls.push({ method: 'move', args: [id, input] });
      return options.moveFails === undefined
        ? of({ ...tree[0]!, id })
        : throwError(() => options.moveFails);
    },
  } as unknown as SectionsApi;

  TestBed.configureTestingModule({
    providers: [
      provideNoopAnimations(),
      provideRouter(
        [
          { path: 'sections', component: TreeStub },
          {
            path: 'sections/:id/move',
            component: SectionMovePage,
            resolve: { formData: sectionMoveResolver },
          },
        ],
        withComponentInputBinding(),
      ),
      { provide: SectionsApi, useValue: api },
      {
        provide: LocalesStore,
        useValue: {
          codes: signal<LocaleCode[]>(['en', 'uk']).asReadonly(),
          defaultCode: signal<LocaleCode | null>(
            options.defaultCode === undefined ? 'en' : options.defaultCode,
          ).asReadonly(),
        } as unknown as LocalesStore,
      },
      {
        provide: NotificationService,
        useValue: {
          success: (message: string) => recorded.successes.push(message),
          info: () => {},
          error: (message: string) => recorded.errors.push(message),
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
    throw new Error('Expected the move page to be the activated route');
  }
  return element;
}

function text(harness: RouterTestingHarness, selector: string): string {
  return root(harness).querySelector(selector)?.textContent?.trim() ?? '';
}

/** The overlay options of one open `mat-select`, in the order they render. */
async function openSelect(
  harness: RouterTestingHarness,
  selectClass: string,
): Promise<HTMLElement[]> {
  const trigger = root(harness).querySelector<HTMLElement>(
    `.${selectClass} .mat-mdc-select-trigger`,
  );
  if (!trigger) {
    throw new Error(`Expected a mat-select with class ${selectClass}`);
  }
  trigger.click();
  harness.detectChanges();
  await harness.fixture.whenStable();
  return Array.from(document.querySelectorAll<HTMLElement>('mat-option'));
}

async function choose(
  harness: RouterTestingHarness,
  selectClass: string,
  label: string,
): Promise<void> {
  const options = await openSelect(harness, selectClass);
  const option = options.find((entry) => entry.textContent?.trim().startsWith(label));
  if (!option) {
    throw new Error(
      `Expected an option "${label}", found ${options.map((o) => o.textContent?.trim()).join(' | ')}`,
    );
  }
  option.click();
  harness.detectChanges();
  await harness.fixture.whenStable();
  harness.detectChanges();
}

function save(harness: RouterTestingHarness): HTMLButtonElement {
  const button = root(harness).querySelector<HTMLButtonElement>('.section-move__save');
  if (!button) {
    throw new Error('Expected the move page to render a Move button');
  }
  return button;
}

describe('SectionMovePage', () => {
  beforeEach(() => {
    // A cold load: no navigation state at all, which is what a hard refresh or
    // a pasted deep link leaves behind.
    history.replaceState({}, '');
  });

  it('opens on a deep link with no navigation state and shows the section', async () => {
    const { calls } = setup();

    const harness = await open('/sections/tenses/move');

    expect(calls).toEqual([{ method: 'tree', args: [] }]);
    expect(text(harness, 'mat-card-title')).toContain('Tenses');
    expect(text(harness, '.section-move__current-path')).toBe('/grammar/tenses');
  });

  it('starts on the section current parent and its current place among its siblings', async () => {
    setup();
    const harness = await open('/sections/articles/move');

    expect(text(harness, '.section-move__parent')).toBe('Grammar');
    // Articles is the second child, so "After Tenses" is where it already is.
    expect(text(harness, '.section-move__position')).toBe('After Tenses');
  });

  it('offers the top level and omits the section itself and its descendants', async () => {
    setup();
    const harness = await open('/sections/tenses/move');

    const labels = (await openSelect(harness, 'section-move__parent')).map((option) =>
      option.textContent?.trim(),
    );

    expect(labels[0]).toBe(TOP_LEVEL_OPTION);
    expect(labels).not.toContain('Tenses');
    expect(labels).not.toContain('Present simple');
    expect(labels).toContain('Listening');
  });

  it('offers a parent that would overflow the nesting limit disabled, and says why', async () => {
    setup();
    const harness = await open('/sections/tenses/move');

    const options = await openSelect(harness, 'section-move__parent');
    const tooDeep = options.find((option) => option.textContent?.trim().startsWith('Deep 3'));
    const shallow = options.find((option) => option.textContent?.trim().startsWith('Deep 1'));

    expect(tooDeep?.getAttribute('aria-disabled')).toBe('true');
    expect(tooDeep?.textContent).toContain(MAX_DEPTH_MESSAGE);
    // The reason is text inside the option, not a tooltip: a disabled option
    // never takes focus, so a tooltip on it is unreachable by the keyboard.
    expect(shallow?.getAttribute('aria-disabled')).toBe('false');
  });

  it('rebuilds the positions from the chosen parent children', async () => {
    setup();
    const harness = await open('/sections/listening/move');

    await choose(harness, 'section-move__parent', 'Grammar');

    const positions = (await openSelect(harness, 'section-move__position')).map((option) =>
      option.textContent?.trim(),
    );
    expect(positions).toEqual(['First', 'After Tenses', 'After Articles']);
    // The old parent's position meant nothing under the new one.
    expect(text(harness, '.section-move__position')).toBe('First');
  });

  it('previews the path the section will answer on', async () => {
    setup();
    const harness = await open('/sections/listening/move');

    expect(text(harness, '.section-move__derived-path')).toBe('/listening');

    await choose(harness, 'section-move__parent', 'Tenses');

    expect(text(harness, '.section-move__derived-path')).toBe('/grammar/tenses/listening');
  });

  it('moves the section and hands the tree the row to highlight', async () => {
    const { calls, successes } = setup();
    const harness = await open('/sections/listening/move');

    await choose(harness, 'section-move__parent', 'Grammar');
    await choose(harness, 'section-move__position', 'After Tenses');
    save(harness).click();
    await harness.fixture.whenStable();
    harness.detectChanges();

    expect(calls).toEqual([
      { method: 'tree', args: [] },
      // The very shape the drag gesture posts: both funnel into one call.
      { method: 'move', args: ['listening', { parentId: 'grammar', sortOrder: 1 }] },
    ]);
    const router = TestBed.inject(Router);
    expect(router.url).toBe('/sections');
    // The hand-off ADR-005 describes, and the one `SectionsPage` reads to
    // highlight the row that just moved.
    expect(router.lastSuccessfulNavigation()?.extras.state).toEqual({ savedId: 'listening' });
    expect(successes).toEqual(['"Listening" was moved.']);
  });

  it('moves a section to the top level', async () => {
    const { calls } = setup();
    const harness = await open('/sections/tenses/move');

    await choose(harness, 'section-move__parent', TOP_LEVEL_OPTION);
    save(harness).click();
    await harness.fixture.whenStable();

    expect(calls[1]).toEqual({
      method: 'move',
      args: ['tenses', { parentId: null, sortOrder: 0 }],
    });
  });

  it('sends nothing when Move is pressed on the placement the section already has', async () => {
    const { calls, successes } = setup();
    const harness = await open('/sections/articles/move');

    save(harness).click();
    await harness.fixture.whenStable();
    harness.detectChanges();

    expect(calls.map((call) => call.method)).toEqual(['tree']);
    // No "was moved" for a move that did not happen — the tree comes back with
    // the row highlighted, which is where the section is.
    expect(successes).toEqual([]);
    const router = TestBed.inject(Router);
    expect(router.url).toBe('/sections');
    expect(router.lastSuccessfulNavigation()?.extras.state).toEqual({ savedId: 'articles' });
  });

  it('still sends when only the position changed under the same parent', async () => {
    const { calls } = setup();
    const harness = await open('/sections/articles/move');

    await choose(harness, 'section-move__position', 'First');
    save(harness).click();
    await harness.fixture.whenStable();

    expect(calls[1]).toEqual({
      method: 'move',
      args: ['articles', { parentId: 'grammar', sortOrder: 0 }],
    });
  });

  it('binds a 409 under the parent field instead of only toasting it', async () => {
    const { calls } = setup({
      moveFails: new HttpErrorResponse({
        status: 409,
        statusText: 'Conflict',
        error: { message: 'Another section under the same parent already uses the slug "tenses"' },
      }),
    });
    const harness = await open('/sections/tenses/move');

    await choose(harness, 'section-move__parent', 'Listening');
    save(harness).click();
    await harness.fixture.whenStable();
    harness.detectChanges();

    expect(text(harness, '.section-move__parent-conflict')).toContain('already uses the slug');
    expect(TestBed.inject(Router).url).toBe('/sections/tenses/move');
    expect(calls.filter((call) => call.method === 'move')).toHaveLength(1);

    // Choosing another parent clears it: the choice that was refused is gone.
    await choose(harness, 'section-move__parent', 'Articles');
    expect(root(harness).querySelector('.section-move__parent-conflict')).toBeNull();
  });

  it('sends the tree back with a message for an id the tree does not hold', async () => {
    const { errors } = setup();

    const harness = await open('/sections/gone/move');

    expect(TestBed.inject(Router).url).toBe('/sections');
    // Nothing failed over HTTP, so the interceptor toasted nothing.
    expect(errors).toEqual([SECTION_GONE]);
    expect(harness.routeNativeElement?.textContent).toContain('tree');
  });

  it('sends the tree back silently when the tree itself cannot be read', async () => {
    const { errors } = setup({
      treeFails: new HttpErrorResponse({ status: 500, statusText: 'Server Error' }),
    });

    await open('/sections/tenses/move');

    expect(TestBed.inject(Router).url).toBe('/sections');
    // The interceptor already toasted the API's own wording.
    expect(errors).toEqual([]);
  });
});
