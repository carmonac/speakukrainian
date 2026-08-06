import { Component, signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { By } from '@angular/platform-browser';
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
}

function setup(
  trees: SectionTreeNode[][],
  options: { defaultCode?: LocaleCode | null } = {},
): Harnessed {
  const served = signal(trees);
  const calls: { method: string; args: unknown[] }[] = [];
  const removeFails = signal<HttpErrorResponse | null>(null);
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
  } as unknown as SectionsApi;

  TestBed.configureTestingModule({
    providers: [
      provideNoopAnimations(),
      provideRouter([
        { path: 'sections', component: SectionsPage },
        { path: 'sections/new', component: FormStub },
        { path: 'sections/:id', component: FormStub },
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

  return { trees: served, calls, removeFails };
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
      { depth: 1, parentId: 'grammar', title: { en: 'Tenses' }, path: '/grammar/tenses' },
      [
        node('present', {
          depth: 2,
          parentId: 'tenses',
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
