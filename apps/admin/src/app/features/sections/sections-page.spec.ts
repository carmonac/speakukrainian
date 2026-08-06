import { Component, signal, type DebugElement, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { By } from '@angular/platform-browser';
import { CdkDropList, type CdkDrag, type CdkDragDrop } from '@angular/cdk/drag-drop';
import { MatDialog } from '@angular/material/dialog';
import { MatTooltip } from '@angular/material/tooltip';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
 * works off rects, pointer events and CSS transforms — decides nothing there
 * unless it is handed a layout. These drive the component's own drop decisions
 * instead, with the two fields of a drop event that they read; the suite below
 * them supplies a layout and drives CDK itself.
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

    page(harness).nest(rowOf(tree, 'listening'), rowOf(tree, 'tenses').section);
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

    page(harness).nest(rowOf(tree, 'tenses'), rowOf(tree, 'listening').section);
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
    page(harness).nest(rowOf(tree, 'listening'), rowOf(tree, 'tenses').section);
    await harness.fixture.whenStable();
    harness.detectChanges();

    expect({ titles: titles(harness), paths: paths(harness) }).toEqual(before);
    // Nothing changed on the server, so there is nothing to re-read.
    expect(calls.map((call) => call.method)).toEqual(['tree', 'move']);
  });

  it('offers a nest target only where the dragged section may legally land', async () => {
    const tree = seeded();
    setup([tree]);
    const harness = await open();

    // "Tenses" is deep enough to hold either subtree, so the only thing that
    // refuses "Grammar" there is that "Tenses" is inside it.
    page(harness).beginDrag(rowOf(tree, 'grammar'));
    expect([...page(harness).nestable()]).toEqual(['listening']);

    page(harness).endDrag();
    page(harness).beginDrag(rowOf(tree, 'listening'));
    expect([...page(harness).nestable()]).toEqual(['grammar', 'tenses', 'present']);

    page(harness).endDrag();
    expect([...page(harness).nestable()]).toEqual([]);
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

const ROW_HEIGHT = 40;
const ROW_WIDTH = 1200;
const NEST_LEFT = 1140;
const NEST_SIZE = 40;

interface Point {
  x: number;
  y: number;
}

/**
 * The rectangles the tree would have on screen — rows stacked `ROW_HEIGHT`
 * apart across a `ROW_WIDTH` row, a drag handle at the left of each and a nest
 * column at the right — plus an `elementFromPoint` that answers from the same
 * ones. jsdom measures nothing: every element reports a zero-sized rect and
 * `document.elementFromPoint` does not exist at all, and both the component and
 * CDK read the layout on every pointer move.
 *
 * The rects are **live**, not fixed: each one is the row's resting rectangle
 * shifted by whatever `translate3d` is on the element or an ancestor at the
 * moment it is read. That is the whole reason a sibling was unreachable — CDK's
 * sort translates the rows a drag passes — so a layout that ignored transforms
 * would model away the very thing under test.
 */
function layOut(harness: RouterTestingHarness): {
  handle(index: number): Point;
  nest(index: number): Point;
  restore(): void;
} {
  const rects = new Map<Element, DOMRect>();
  const slots = new Map<string, DOMRect>();
  const list = requireIn<HTMLElement>(root(harness), 'ul.sections-tree');
  const items = rows(harness);

  rects.set(list, new DOMRect(0, 0, ROW_WIDTH, items.length * ROW_HEIGHT));
  items.forEach((item, index) => {
    const top = index * ROW_HEIGHT;
    const rect = new DOMRect(0, top, ROW_WIDTH, ROW_HEIGHT);
    rects.set(item, rect);
    const id = item.getAttribute('data-section-id');
    if (id !== null) {
      slots.set(id, rect);
    }
    rects.set(requireIn(item, '.sections-tree__handle'), new DOMRect(8, top + 8, 24, 24));
    rects.set(
      requireIn(item, '.sections-tree__nest'),
      new DOMRect(NEST_LEFT, top, NEST_SIZE, NEST_SIZE),
    );
  });

  const resting = (element: Element): DOMRect | null => {
    const own = rects.get(element);
    if (own !== undefined) {
      return own;
    }
    // CDK stands a clone of the dragged row in its slot, so the clone measures
    // as the row it replaced. Without this the sort has no height to work with
    // and lays nothing out.
    if (element.classList.contains('cdk-drag-placeholder')) {
      const id = element.getAttribute('data-section-id');
      return id === null ? null : (slots.get(id) ?? null);
    }
    return null;
  };

  const shiftedBy = (element: Element): number => {
    let total = 0;
    let node: Element | null = element;
    while (node !== null) {
      const transform = node instanceof HTMLElement ? node.style.transform : '';
      const shift = /translate3d\(\s*[^,]+,\s*(-?[\d.]+)px/.exec(transform)?.[1];
      if (shift !== undefined) {
        total += Number(shift);
      }
      node = node.parentElement;
    }
    return total;
  };

  const liveRect = (element: Element): DOMRect => {
    const base = resting(element);
    if (base === null) {
      return new DOMRect(0, 0, 0, 0);
    }
    const shift = shiftedBy(element);
    return shift === 0 ? base : new DOMRect(base.x, base.y + shift, base.width, base.height);
  };

  const measure = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    return liveRect(this);
  };

  // The innermost laid-out element covering the point, which is what a browser
  // returns.
  document.elementFromPoint = (x: number, y: number): Element | null => {
    let hit: Element | null = null;
    let smallest = Number.POSITIVE_INFINITY;
    for (const element of rects.keys()) {
      const rect = liveRect(element);
      const area = rect.width * rect.height;
      if (x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom && area < smallest) {
        hit = element;
        smallest = area;
      }
    }
    return hit;
  };

  return {
    handle: (index) => ({ x: 20, y: index * ROW_HEIGHT + 20 }),
    nest: (index) => ({ x: NEST_LEFT + NEST_SIZE / 2, y: index * ROW_HEIGHT + NEST_SIZE / 2 }),
    restore: () => {
      Element.prototype.getBoundingClientRect = measure;
      Reflect.deleteProperty(document, 'elementFromPoint');
    },
  };
}

/**
 * A whole press-move-release gesture, walked in steps the way a hand moves and
 * pausing at each stop it is given. `atStop` runs with the pointer held there,
 * which is the only moment the mid-drag state exists; the release happens at
 * the last one.
 */
async function dragPointer(
  harness: RouterTestingHarness,
  from: Point,
  through: Point | readonly Point[],
  atStop: (stop: number) => void = () => {},
  steps = 8,
): Promise<void> {
  const at = (type: string, point: Point): MouseEvent =>
    new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: point.x,
      clientY: point.y,
      // CDK reads both to tell a real press from the synthetic one a screen
      // reader raises, and jsdom defaults them to the screen reader's shape.
      buttons: 1,
      detail: 1,
    });

  const handle = document.elementFromPoint(from.x, from.y);
  if (handle === null) {
    throw new Error('Nothing was laid out where the gesture starts');
  }
  handle.dispatchEvent(at('mousedown', from));

  const stops = Array.isArray(through) ? (through as readonly Point[]) : [through as Point];
  let previous = from;
  stops.forEach((stop, index) => {
    for (let step = 1; step <= steps; step += 1) {
      document.dispatchEvent(
        at('mousemove', {
          x: previous.x + ((stop.x - previous.x) * step) / steps,
          y: previous.y + ((stop.y - previous.y) * step) / steps,
        }),
      );
      harness.detectChanges();
    }
    previous = stop;
    atStop(index);
  });

  document.dispatchEvent(at('mouseup', previous));
  await harness.fixture.whenStable();
  harness.detectChanges();
}

/**
 * Every nest column the tree renders, in row order. Found through the hint
 * directive on it rather than by selector: mid-drag the DOM also holds CDK's
 * clone of the dragged row, which matches every class the row does, is never
 * updated again, and carries no directive at all.
 */
function nestColumns(harness: RouterTestingHarness): DebugElement[] {
  return harness.fixture.debugElement
    .queryAll(By.directive(MatTooltip))
    .filter((found) =>
      (found.nativeElement as HTMLElement).classList.contains('sections-tree__nest'),
    );
}

/** The sections whose nest column carries `marker` right now. */
function nestsMarked(harness: RouterTestingHarness, marker: string): string[] {
  return nestColumns(harness)
    .map((found) => found.nativeElement as HTMLElement)
    .filter((element) => element.classList.contains(marker))
    .map(
      (element) =>
        element
          .closest('.sections-tree__row')
          ?.querySelector('.sections-tree__title')
          ?.textContent?.trim() ?? '',
    );
}

/** A parent with three children, which is where re-parenting used to fall over. */
const siblings = (): SectionTreeNode[] => {
  const child = (id: string, title: string, sortOrder: number): SectionTreeNode =>
    node(id, {
      depth: 1,
      parentId: 'beta',
      ancestorIds: ['beta'],
      title: { en: title },
      path: `/beta/${id}`,
      sortOrder,
    });

  return [
    node('alpha', { title: { en: 'Alpha' } }),
    node('beta', { title: { en: 'Beta' } }, [
      child('beta-one', 'Beta One', 0),
      child('beta-two', 'Beta Two', 1),
      child('beta-three', 'Beta Three', 2),
    ]),
    node('gamma', { title: { en: 'Gamma' } }),
  ];
};

/**
 * These drive CDK itself over the layout above, which is the half of the
 * gesture the handler specs cannot reach. Both ways the re-parent gesture has
 * failed live here: an axis lock froze the x the drop target is looked for at,
 * and CDK's own sort slid a sibling out from under the pointer that was aiming
 * at it. The layout models the second one, because it re-measures every row
 * through the transforms the sort writes.
 */
describe('SectionsPage drag and drop through CDK', () => {
  let laidOut: { restore(): void } | null = null;

  beforeEach(() => {
    history.replaceState({}, '');
  });

  afterEach(() => {
    laidOut?.restore();
    laidOut = null;
  });

  it('re-parents when the pointer is dragged onto another row nest column', async () => {
    const { calls } = setup([seeded()]);
    const harness = await open();
    const layout = layOut(harness);
    laidOut = layout;

    // Rows: Grammar(0) Tenses(1) Present simple(2) Listening(3). Dragging
    // "Listening" sideways onto "Tenses" crosses the whole width of the row,
    // which is exactly the movement an axis lock throws away.
    await dragPointer(harness, layout.handle(3), layout.nest(1));

    expect(calls.filter((call) => call.method === 'move')).toEqual([
      { method: 'move', args: ['listening', { parentId: 'tenses', sortOrder: 1 }] },
    ]);
    expect(paths(harness)).toEqual([
      '/grammar',
      '/grammar/tenses',
      '/grammar/tenses/present-simple',
      '/grammar/tenses/listening',
    ]);
  });

  it('re-parents onto the sibling below the dragged row', async () => {
    const { calls } = setup([siblings()]);
    const harness = await open();
    const layout = layOut(harness);
    laidOut = layout;

    // Rows: Alpha(0) Beta(1) Beta One(2) Beta Two(3) Beta Three(4) Gamma(5).
    // The pointer crosses "Beta Three"'s own row on its way to the column, so
    // the sort has already slid "Beta Three" up a row by the time it arrives —
    // the drop used to land on the tree instead and quietly reorder.
    await dragPointer(harness, layout.handle(3), layout.nest(4));

    expect(calls.filter((call) => call.method === 'move')).toEqual([
      { method: 'move', args: ['beta-two', { parentId: 'beta-three', sortOrder: 0 }] },
    ]);
    expect(titles(harness)).toEqual([
      'Alpha',
      'Beta',
      'Beta One',
      'Beta Three',
      'Beta Two',
      'Gamma',
    ]);
    expect(paths(harness)).toContain('/beta/beta-three/beta-two');
  });

  it('re-parents onto the sibling above the dragged row', async () => {
    const { calls } = setup([siblings()]);
    const harness = await open();
    const layout = layOut(harness);
    laidOut = layout;

    await dragPointer(harness, layout.handle(3), layout.nest(2));

    expect(calls.filter((call) => call.method === 'move')).toEqual([
      { method: 'move', args: ['beta-two', { parentId: 'beta-one', sortOrder: 0 }] },
    ]);
    expect(paths(harness)).toContain('/beta/beta-one/beta-two');
  });

  it('holds the tree still while the pointer hunts along the nest strip', async () => {
    const { calls } = setup([siblings()]);
    const harness = await open();
    const layout = layOut(harness);
    laidOut = layout;

    // Into the strip well below the dragged row, then back up it two rows at a
    // time. Nothing may move underneath: the highlighted row has to be the row
    // the pointer is level with in the tree's resting layout, every time.
    const aimedAt: string[][] = [];
    await dragPointer(
      harness,
      layout.handle(3),
      [layout.nest(5), layout.nest(4), layout.nest(2)],
      () => aimedAt.push(nestsMarked(harness, 'is-target')),
    );

    expect(aimedAt).toEqual([['Gamma'], ['Beta Three'], ['Beta One']]);
    expect(calls.filter((call) => call.method === 'move')).toEqual([
      { method: 'move', args: ['beta-two', { parentId: 'beta-one', sortOrder: 0 }] },
    ]);
  });

  it('refuses a nest column inside the dragged row own subtree', async () => {
    const { calls } = setup([seeded()]);
    const harness = await open();
    const layout = layOut(harness);
    laidOut = layout;

    // "Tenses" and "Present simple" are inside "Grammar", so their columns must
    // not offer themselves however precisely the pointer lands on one, and
    // "Grammar" must not offer itself either. "Listening" is the only target
    // outside the dragged subtree, and it does light up — which is what says
    // the empty list below is the tree refusing and not the drag failing.
    let offered: string[] = [];
    let aimedAt: string[] = [];
    await dragPointer(harness, layout.handle(0), layout.nest(2), () => {
      offered = nestsMarked(harness, 'is-available');
      aimedAt = nestsMarked(harness, 'is-target');
    });

    expect(offered).toEqual(['Listening']);
    expect(aimedAt).toEqual([]);
    // Not a reorder either: a release in the strip only ever re-parents.
    expect(calls.map((call) => call.method)).toEqual(['tree']);
    expect(paths(harness)).toEqual([
      '/grammar',
      '/grammar/tenses',
      '/grammar/tenses/present-simple',
      '/listening',
    ]);
  });

  it('reorders and never re-parents when the pointer only moves vertically', async () => {
    const { calls } = setup([seeded()]);
    const harness = await open();
    const layout = layOut(harness);
    laidOut = layout;

    await dragPointer(harness, layout.handle(3), layout.handle(0));

    expect(calls.filter((call) => call.method === 'move')).toEqual([
      { method: 'move', args: ['listening', { parentId: null, sortOrder: 0 }] },
    ]);
    expect(titles(harness)).toEqual(['Listening', 'Grammar', 'Tenses', 'Present simple']);
  });

  it('says nothing over a nest column until there is something to drop', async () => {
    setup([seeded()]);
    const harness = await open();
    const layout = layOut(harness);
    laidOut = layout;

    const hints = (): boolean[] =>
      nestColumns(harness).map((found) => found.injector.get(MatTooltip).disabled);

    // The column is invisible at rest, and an invisible box that answers a
    // hover with "Drop here to nest inside" explains nothing about the blank
    // space the pointer is over.
    expect(hints()).toEqual([true, true, true, true]);

    let whileDragging: boolean[] = [];
    await dragPointer(harness, layout.handle(3), layout.handle(1), () => {
      whileDragging = hints();
    });

    expect(whileDragging).toEqual([false, false, false, false]);
    expect(hints()).toEqual([true, true, true, true]);
  });

  it('keeps the tree as the only drop list, and leaves its axis unlocked', async () => {
    setup([seeded()]);
    const harness = await open();

    const lists = harness.fixture.debugElement.queryAll(By.directive(CdkDropList));

    // A `cdkDropList` per nest column is the arrangement this screen keeps
    // being written with, and it cannot work: CDK measures a receiving list
    // once, when the drag starts, so a row its own sort has since translated
    // matches neither the rectangle it has left nor the one it now occupies.
    // Every sibling of the dragged row is translated, so no sibling could ever
    // take a drop. The columns are hit-tested against the live layout instead.
    expect(lists.map((found) => (found.nativeElement as HTMLElement).tagName)).toEqual(['UL']);
    // An axis lock would freeze x at the drag handle, and the strip the columns
    // live in is at the far end of the row.
    expect(lists[0]?.injector.get(CdkDropList).lockAxis).toBeNull();
  });
});
