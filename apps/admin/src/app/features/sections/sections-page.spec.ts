import { Component, signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { By } from '@angular/platform-browser';
import type { CdkDrag, CdkDragDrop } from '@angular/cdk/drag-drop';
import { MatDialog } from '@angular/material/dialog';
import { MatTooltip } from '@angular/material/tooltip';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_SECTION_DEPTH, type LocaleCode, type SectionTreeNode } from '@speakukrainian/shared';
import { LocalesStore } from '../../core/locales/locales.store';
import { NotificationService } from '../../core/notifications/notification.service';
import { DELETE_WITH_CHILDREN_MESSAGE, MAX_DEPTH_MESSAGE } from './section-messages';
import { flattenTree, type SectionRow } from './sections.model';
import { SectionsApi } from './sections.api';
import { SectionsPage } from './sections-page';

@Component({ selector: 'app-section-form-stub', template: 'form' })
class FormStub {}

const audit = {
  createdAt: '2026-01-01T00:00:00Z',
  createdBy: 'admin',
  updatedAt: '2026-01-01T00:00:00Z',
  updatedBy: 'admin',
};

function node(
  id: string,
  overrides: Partial<SectionTreeNode> = {},
  children: SectionTreeNode[] = [],
): SectionTreeNode {
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
    children,
  };
}

interface Harnessed {
  /** Every tree the stub will serve, in order; the last one repeats. */
  trees: WritableSignal<SectionTreeNode[][]>;
  calls: { method: string; args: unknown[] }[];
  removeFails: WritableSignal<HttpErrorResponse | null>;
  moveFails: WritableSignal<HttpErrorResponse | null>;
}

function setup(
  trees: SectionTreeNode[][],
  options: { defaultCode?: LocaleCode | null } = {},
): Harnessed {
  const served = signal(trees);
  const calls: { method: string; args: unknown[] }[] = [];
  const removeFails = signal<HttpErrorResponse | null>(null);
  const moveFails = signal<HttpErrorResponse | null>(null);
  let treeReads = 0;

  const api = {
    tree: () => {
      const all = served();
      const answer = all[Math.min(treeReads, all.length - 1)] ?? [];
      treeReads += 1;
      calls.push({ method: 'tree', args: [] });
      return of(answer);
    },
    remove: (id: string) => {
      calls.push({ method: 'remove', args: [id] });
      const failure = removeFails();
      return failure === null ? of(undefined) : throwError(() => failure);
    },
    move: (id: string, input: unknown) => {
      calls.push({ method: 'move', args: [id, input] });
      const failure = moveFails();
      return failure === null ? of(node(id)) : throwError(() => failure);
    },
  } as unknown as SectionsApi;

  TestBed.configureTestingModule({
    providers: [
      provideNoopAnimations(),
      provideRouter([
        { path: 'sections', component: SectionsPage },
        { path: 'sections/new', component: FormStub },
        { path: 'sections/:id', component: FormStub },
        { path: 'sections/:id/move', component: FormStub },
      ]),
      { provide: SectionsApi, useValue: api },
      {
        provide: LocalesStore,
        useValue: {
          defaultCode: signal<LocaleCode | null>(options.defaultCode ?? 'en').asReadonly(),
        } as unknown as LocalesStore,
      },
      {
        provide: MatDialog,
        useValue: { open: () => ({ afterClosed: () => of(true) }) } as unknown as MatDialog,
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

  return { trees: served, calls, removeFails, moveFails };
}

async function open(): Promise<RouterTestingHarness> {
  const harness = await RouterTestingHarness.create('/sections');
  await harness.fixture.whenStable();
  harness.detectChanges();
  return harness;
}

function root(harness: RouterTestingHarness): HTMLElement {
  const element = harness.routeNativeElement;
  if (!(element instanceof HTMLElement)) {
    throw new Error('Expected the sections page to be the activated route');
  }
  return element;
}

function rows(harness: RouterTestingHarness): HTMLElement[] {
  return Array.from(root(harness).querySelectorAll<HTMLElement>('.sections-tree__row'));
}

function titles(harness: RouterTestingHarness): string[] {
  return rows(harness).map(
    (row) => row.querySelector('.sections-tree__title')?.textContent?.trim() ?? '',
  );
}

function requireIn<T extends Element>(element: ParentNode, selector: string): T {
  const found = element.querySelector<T>(selector);
  if (!found) {
    throw new Error(`Expected the row to render "${selector}"`);
  }
  return found;
}

/** The tooltip is a directive input, so it is read off the directive, not the DOM. */
function tooltipAt(harness: RouterTestingHarness, index: number, selector: string): string {
  const hints = harness.fixture.debugElement.queryAll(By.css(selector));
  const hint = hints[index];
  if (!hint) {
    throw new Error(`Expected a "${selector}" on row ${index}`);
  }
  return hint.injector.get(MatTooltip).message;
}

const seeded = (): SectionTreeNode[] => [
  node('grammar', { title: { en: 'Grammar' } }, [
    node(
      'tenses',
      {
        depth: 1,
        parentId: 'grammar',
        ancestorIds: ['grammar'],
        title: { en: 'Tenses' },
        path: '/grammar/tenses',
      },
      [
        node('present', {
          depth: 2,
          parentId: 'tenses',
          ancestorIds: ['grammar', 'tenses'],
          slug: 'present-simple',
          title: { en: 'Present simple' },
          path: '/grammar/tenses/present-simple',
        }),
      ],
    ),
  ]),
  node('listening', { title: { en: 'Listening' }, status: 'published' }),
];

describe('SectionsPage', () => {
  beforeEach(() => {
    history.replaceState({}, '');
  });

  it('nests every subsection under its parent', async () => {
    setup([seeded()]);
    const harness = await open();

    expect(titles(harness)).toEqual(['Grammar', 'Tenses', 'Present simple', 'Listening']);
    expect(rows(harness).map((row) => row.style.paddingInlineStart)).toEqual([
      '0px',
      '24px',
      '48px',
      '0px',
    ]);
    expect(
      rows(harness).map((row) => row.querySelector('.sections-tree__path')?.textContent?.trim()),
    ).toEqual(['/grammar', '/grammar/tenses', '/grammar/tenses/present-simple', '/listening']);
  });

  it('folds a subtree away and back', async () => {
    setup([seeded()]);
    const harness = await open();

    requireIn<HTMLButtonElement>(rows(harness)[0]!, '.sections-tree__toggle').click();
    harness.detectChanges();
    expect(titles(harness)).toEqual(['Grammar', 'Listening']);

    requireIn<HTMLButtonElement>(rows(harness)[0]!, '.sections-tree__toggle').click();
    harness.detectChanges();
    expect(titles(harness)).toEqual(['Grammar', 'Tenses', 'Present simple', 'Listening']);
  });

  it('links Add subsection at /sections/new?parentId=<id>', async () => {
    setup([seeded()]);
    const harness = await open();

    expect(requireIn<HTMLAnchorElement>(rows(harness)[0]!, 'a.sections-tree__add').pathname).toBe(
      '/sections/new',
    );
    expect(requireIn<HTMLAnchorElement>(rows(harness)[0]!, 'a.sections-tree__add').search).toBe(
      '?parentId=grammar',
    );
  });

  it('does not offer Add subsection at the nesting limit, and says why', async () => {
    setup([[node('deepest', { depth: MAX_SECTION_DEPTH, title: { en: 'Deepest' } })]]);
    const harness = await open();

    expect(rows(harness)[0]?.querySelector('a.sections-tree__add')).toBeNull();
    expect(
      requireIn<HTMLButtonElement>(rows(harness)[0]!, 'button.sections-tree__add').disabled,
    ).toBe(true);
    expect(tooltipAt(harness, 0, '.sections-tree__add-hint')).toBe(MAX_DEPTH_MESSAGE);
  });

  it('refuses to delete a section that still has subsections, and says what to do instead', async () => {
    const { calls } = setup([seeded()]);
    const harness = await open();

    const parent = requireIn<HTMLButtonElement>(rows(harness)[0]!, '.sections-tree__delete');
    expect(parent.disabled).toBe(true);
    expect(tooltipAt(harness, 0, '.sections-tree__delete-hint')).toBe(DELETE_WITH_CHILDREN_MESSAGE);

    parent.click();
    await harness.fixture.whenStable();

    expect(calls.filter((call) => call.method === 'remove')).toEqual([]);
    // A leaf is deletable and carries no explanation it does not need.
    expect(requireIn<HTMLButtonElement>(rows(harness)[3]!, '.sections-tree__delete').disabled).toBe(
      false,
    );
    expect(tooltipAt(harness, 3, '.sections-tree__delete-hint')).toBe('');
  });

  it('deletes a leaf once the confirmation is accepted and re-reads the tree', async () => {
    const { calls } = setup([seeded(), [seeded()[0]!]]);
    const harness = await open();

    requireIn<HTMLButtonElement>(rows(harness)[3]!, '.sections-tree__delete').click();
    await harness.fixture.whenStable();
    harness.detectChanges();

    expect(calls).toEqual([
      { method: 'tree', args: [] },
      { method: 'remove', args: ['listening'] },
      { method: 'tree', args: [] },
    ]);
    // Re-read, not patched locally: the row is gone because the server said so.
    expect(titles(harness)).toEqual(['Grammar', 'Tenses', 'Present simple']);
  });

  it('explains a 409 from a concurrent subsection by reloading the row that now has one', async () => {
    // The disabled button prevents the common case, but a subsection added
    // while this tree was on screen still 409s. The reloaded row is what tells
    // the admin to delete or move the subsections first.
    const stale = [node('grammar', { title: { en: 'Grammar' } })];
    const { calls, removeFails } = setup([stale, seeded()]);
    removeFails.set(new HttpErrorResponse({ status: 409, statusText: 'Conflict' }));
    const harness = await open();

    expect(requireIn<HTMLButtonElement>(rows(harness)[0]!, '.sections-tree__delete').disabled).toBe(
      false,
    );

    requireIn<HTMLButtonElement>(rows(harness)[0]!, '.sections-tree__delete').click();
    await harness.fixture.whenStable();
    harness.detectChanges();

    expect(calls.map((call) => call.method)).toEqual(['tree', 'remove', 'tree']);
    expect(requireIn<HTMLButtonElement>(rows(harness)[0]!, '.sections-tree__delete').disabled).toBe(
      true,
    );
    expect(tooltipAt(harness, 0, '.sections-tree__delete-hint')).toBe(DELETE_WITH_CHILDREN_MESSAGE);
  });

  it('renders the default-locale title and falls back for an untitled section', async () => {
    setup([[node('grammar', { title: { uk: 'Граматика' } }), node('listening', { title: {} })]], {
      defaultCode: 'uk',
    });
    const harness = await open();

    expect(titles(harness)).toEqual(['Граматика', '(untitled)']);
  });

  it('stays readable when the default locale is not the one the content was authored in', async () => {
    setup([seeded()], { defaultCode: 'uk' });
    const harness = await open();

    expect(titles(harness)).toEqual(['Grammar', 'Tenses', 'Present simple', 'Listening']);
  });

  it('counts a single subsection in the singular', async () => {
    setup([[node('grammar', { title: { en: 'Grammar' } }, [node('tenses', { depth: 1 })])]]);
    const harness = await open();

    expect(rows(harness)[0]?.querySelector('.sections-tree__count')?.textContent?.trim()).toBe(
      '1 subsection',
    );
  });

  it('counts several subsections in the plural', async () => {
    setup([
      [
        node('grammar', { title: { en: 'Grammar' } }, [
          node('tenses', { depth: 1 }),
          node('articles', { depth: 1 }),
        ]),
      ],
    ]);
    const harness = await open();

    expect(rows(harness)[0]?.querySelector('.sections-tree__count')?.textContent?.trim()).toBe(
      '2 subsections',
    );
  });

  it('marks the row carried in the navigation state after a save', async () => {
    setup([seeded()]);
    const harness = await RouterTestingHarness.create();

    await TestBed.inject(Router).navigate(['/sections'], { state: { savedId: 'listening' } });
    await harness.fixture.whenStable();
    harness.detectChanges();

    expect(rows(harness).map((row) => row.classList.contains('is-saved'))).toEqual([
      false,
      false,
      false,
      true,
    ]);
  });

  it('keeps the marked row across a refresh, where only history.state survives', async () => {
    setup([seeded()]);
    history.replaceState({ savedId: 'tenses' }, '');

    const harness = await open();

    expect(rows(harness).map((row) => row.classList.contains('is-saved'))).toEqual([
      false,
      true,
      false,
      false,
    ]);
  });

  it('says so when there is nothing to show yet', async () => {
    setup([[]]);
    const harness = await open();

    expect(root(harness).querySelector('.sections__empty')?.textContent?.trim()).toBe(
      'No sections yet.',
    );
  });
});

/**
 * jsdom gives every element a zero-sized rect, so CDK's sorting maths — which
 * works off rects, pointer events and CSS transforms — decides nothing there,
 * and a synthesised pointer sequence would assert nothing real. These drive the
 * component's own drop decisions instead, with the two fields of a drop event
 * that they read. What the CDK wiring itself does with a real pointer is on the
 * manual check list in the plan.
 */
function paths(harness: RouterTestingHarness): string[] {
  return rows(harness).map(
    (row) => row.querySelector('.sections-tree__path')?.textContent?.trim() ?? '',
  );
}

function page(harness: RouterTestingHarness): SectionsPage {
  return harness.routeDebugElement?.componentInstance as SectionsPage;
}

/** The row the component would render for `id`, from the same tree it was given. */
function rowOf(tree: SectionTreeNode[], id: string): SectionRow {
  const found = flattenTree(tree, new Set()).find((row) => row.section.id === id);
  if (found === undefined) {
    throw new Error(`The fixture has no section "${id}"`);
  }
  return found;
}

/**
 * The two fields the drop handlers read. The generic follows the list the drop
 * happened in: the tree carries the rows, a nest column carries its own row.
 */
function dropped<T>(row: SectionRow, currentIndex: number): CdkDragDrop<T> {
  return { item: { data: row }, currentIndex } as unknown as CdkDragDrop<T>;
}

function dragging(row: SectionRow): CdkDrag<SectionRow> {
  return { data: row } as unknown as CdkDrag<SectionRow>;
}

describe('SectionsPage drag and drop', () => {
  beforeEach(() => {
    history.replaceState({}, '');
  });

  it('offers every row a keyboard-reachable Move link naming the section', async () => {
    setup([seeded()]);
    const harness = await open();

    const move = requireIn<HTMLAnchorElement>(rows(harness)[1]!, 'a.sections-tree__move');
    expect(move.pathname).toBe('/sections/tenses/move');
    expect(move.getAttribute('aria-label')).toBe('Move Tenses');
    // An anchor, so Tab reaches it and Enter activates it with no extra work.
    expect(move.tabIndex).toBeGreaterThanOrEqual(0);
  });

  it('reorders siblings from a drop and repaints without re-reading the tree', async () => {
    const tree = seeded();
    const { calls } = setup([tree]);
    const harness = await open();

    page(harness).reorder(dropped(rowOf(tree, 'listening'), 0));
    await harness.fixture.whenStable();
    harness.detectChanges();

    expect(calls).toEqual([
      { method: 'tree', args: [] },
      { method: 'move', args: ['listening', { parentId: null, sortOrder: 0 }] },
    ]);
    expect(titles(harness)).toEqual(['Listening', 'Grammar', 'Tenses', 'Present simple']);
  });

  it('counts siblings and not rows when an expanded subtree sits between them', async () => {
    // Dropping at the very bottom of the band is position 1 among the two
    // roots, even though three rows sit above it.
    const tree = seeded();
    const { calls } = setup([tree]);
    const harness = await open();

    page(harness).reorder(dropped(rowOf(tree, 'grammar'), 3));
    await harness.fixture.whenStable();

    expect(calls.filter((call) => call.method === 'move')).toEqual([
      { method: 'move', args: ['grammar', { parentId: null, sortOrder: 1 }] },
    ]);
  });

  it('sends no request when the drop lands where the section already is', async () => {
    const tree = seeded();
    const { calls } = setup([tree]);
    const harness = await open();

    page(harness).reorder(dropped(rowOf(tree, 'grammar'), 0));
    await harness.fixture.whenStable();

    expect(calls.map((call) => call.method)).toEqual(['tree']);
  });

  it('re-parents a whole subtree from a nest drop and shows its new paths', async () => {
    const tree = seeded();
    const { calls } = setup([tree]);
    const harness = await open();

    page(harness).nest(rowOf(tree, 'listening'), dropped(rowOf(tree, 'tenses'), 0));
    await harness.fixture.whenStable();
    harness.detectChanges();

    // Appended as the target's last child, which is what `create` does too.
    expect(calls.filter((call) => call.method === 'move')).toEqual([
      { method: 'move', args: ['tenses', { parentId: 'listening', sortOrder: 0 }] },
    ]);
    expect(titles(harness)).toEqual(['Grammar', 'Listening', 'Tenses', 'Present simple']);
    expect(paths(harness)).toEqual([
      '/grammar',
      '/listening',
      '/listening/tenses',
      '/listening/tenses/present-simple',
    ]);
  });

  it('unfolds a collapsed target so the moved row is visible where it landed', async () => {
    const tree = seeded();
    setup([tree]);
    const harness = await open();

    requireIn<HTMLButtonElement>(rows(harness)[1]!, '.sections-tree__toggle').click();
    harness.detectChanges();
    expect(titles(harness)).toEqual(['Grammar', 'Tenses', 'Listening']);

    page(harness).nest(rowOf(tree, 'tenses'), dropped(rowOf(tree, 'listening'), 0));
    await harness.fixture.whenStable();
    harness.detectChanges();

    expect(titles(harness)).toEqual(['Grammar', 'Tenses', 'Present simple', 'Listening']);
  });

  it('rolls the tree back to exactly what it was when the move is refused', async () => {
    const tree = seeded();
    const { calls, moveFails } = setup([tree]);
    const harness = await open();
    const before = { titles: titles(harness), paths: paths(harness) };

    moveFails.set(new HttpErrorResponse({ status: 422, statusText: 'Unprocessable Entity' }));
    page(harness).nest(rowOf(tree, 'listening'), dropped(rowOf(tree, 'tenses'), 0));
    await harness.fixture.whenStable();
    harness.detectChanges();

    expect({ titles: titles(harness), paths: paths(harness) }).toEqual(before);
    // Nothing changed on the server, so there is nothing to re-read.
    expect(calls.map((call) => call.method)).toEqual(['tree', 'move']);
  });

  it('refuses a nest target inside the dragged section own subtree', async () => {
    const tree = seeded();
    setup([tree]);
    const harness = await open();

    // "Tenses" is deep enough to hold either subtree, so the only thing that
    // refuses "Grammar" here is that "Tenses" is inside it.
    const predicate = page(harness).nestPredicate(rowOf(tree, 'tenses'));
    expect(predicate(dragging(rowOf(tree, 'grammar')))).toBe(false);
    expect(predicate(dragging(rowOf(tree, 'listening')))).toBe(true);
  });

  it('keeps the drag placeholder inside the dragged row sibling band', async () => {
    const tree = seeded();
    setup([tree]);
    const harness = await open();
    const sortPredicate = page(harness).sortPredicate;

    // Rows: Grammar(0) Tenses(1) Present(2) Listening(0). "Present simple" is
    // an only child, so its band is the single row it occupies.
    expect(sortPredicate(2, dragging(rowOf(tree, 'present')))).toBe(true);
    expect(sortPredicate(1, dragging(rowOf(tree, 'present')))).toBe(false);
    expect(sortPredicate(3, dragging(rowOf(tree, 'present')))).toBe(false);
    // A root may go anywhere among the roots and their subtrees.
    expect(sortPredicate(3, dragging(rowOf(tree, 'grammar')))).toBe(true);
  });
});
