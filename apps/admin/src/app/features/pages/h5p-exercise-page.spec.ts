import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { MatDialog } from '@angular/material/dialog';
import { Router, provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  ContentPage,
  H5pSaveResult,
  LocaleCode,
  PageBody,
  SaveH5pContentInput,
} from '@speakukrainian/shared';
import { LocalesStore } from '../../core/locales/locales.store';
import { NotificationService } from '../../core/notifications/notification.service';
import { unsavedChangesGuard } from '../../core/router/unsaved-changes.guard';
import { H5P_DEFINE_ELEMENTS } from './h5p-elements';
import { H5pExercisePage } from './h5p-exercise-page';
import {
  EXERCISE_RESULT_STATE,
  type ExerciseResult,
  type H5pEditorContent,
  type H5pEditorHost,
} from './h5p-exercise.model';
import { h5pExerciseResolver } from './h5p-exercise.resolver';
import { H5pApi, type H5pContentParameters, type H5pEditorModel } from './h5p.api';
import { EXERCISE_SAVE_FAILED, PAGE_IS_NOT_AN_EXERCISE } from './page-messages';
import { PagesApi } from './pages.api';

const audit = {
  createdAt: '2026-01-01T00:00:00Z',
  createdBy: 'admin',
  updatedAt: '2026-01-01T00:00:00Z',
  updatedBy: 'admin',
};

const MODEL: H5pEditorModel = {
  integration: { editor: { ajaxPath: '/api/h5p/ajax?token=abc&action=' } },
  scripts: ['/api/h5p/core/js/h5p.js'],
  styles: ['/api/h5p/core/styles/h5p.css'],
};

/**
 * `h5p` and `params.metadata` are deliberately **different objects**: they are
 * the same metadata by two routes, and reading the wrong one is a defect the
 * widget would only show in a browser.
 */
const PARAMS: H5pContentParameters = {
  library: 'H5P.MultiChoice 1.16',
  params: {
    metadata: { title: 'Telling the time', license: 'U' },
    params: { question: 'Котра година?' },
  },
};

const PARAMS_RESPONSE = { ...PARAMS, h5p: { title: 'not this one' } };

const SAVED: H5pSaveResult = {
  contentId: 'c-new',
  title: 'Telling the time',
  mainLibrary: 'H5P.MultiChoice 1.16',
};

const BODY: SaveH5pContentInput = {
  library: 'H5P.MultiChoice 1.16',
  params: { params: { question: 'Котра година?' }, metadata: { title: 'Telling the time' } },
};

function page(id: string, body: PageBody): ContentPage {
  return {
    id,
    sectionId: 'grammar',
    slug: id,
    path: `/grammar-points/${id}`,
    title: { en: 'Telling the time' },
    body,
    sortOrder: 2,
    status: 'draft',
    publishedAt: null,
    audit,
  };
}

const EMPTY_EXERCISE = page('p1', {
  type: 'h5p_exercise',
  h5pContentId: null,
  explanationPosition: 'above',
  trackResults: false,
});

const ATTACHED = page('p1', {
  type: 'h5p_exercise',
  h5pContentId: 'c1',
  explanationPosition: 'above',
  trackResults: false,
});

const RICH_TEXT = page('p1', {
  type: 'rich_text',
  content: {},
  audioAssets: [],
  imageAssets: [],
});

@Component({ selector: 'app-pages-list-stub', template: 'list' })
class ListStub {}

@Component({ selector: 'app-page-form-stub', template: 'form' })
class FormStub {}

interface Options {
  pages?: ContentPage[];
  /** Which content ids `GET /h5p/editor/:id` knows about; others 404. */
  content?: string[];
  saveFails?: boolean;
}

interface Recorded {
  calls: { method: string; args: unknown[] }[];
  dialogs: number;
  errors: string[];
}

function setup(options: Options = {}): Recorded {
  const stored = new Map((options.pages ?? [EMPTY_EXERCISE]).map((entry) => [entry.id, entry]));
  const known = new Set(options.content ?? ['c1']);
  const recorded: Recorded = { calls: [], dialogs: 0, errors: [] };

  const notFound = (): HttpErrorResponse =>
    new HttpErrorResponse({ status: 404, statusText: 'Not Found' });

  const pagesApi = {
    get: (id: string) => {
      recorded.calls.push({ method: 'pages.get', args: [id] });
      const found = stored.get(id);
      return found === undefined ? throwError(notFound) : of(found);
    },
  } as unknown as PagesApi;

  const h5pApi = {
    editorModel: (contentId?: string) => {
      recorded.calls.push({ method: 'editorModel', args: [contentId] });
      return contentId !== undefined && !known.has(contentId)
        ? throwError(notFound)
        : of<H5pEditorModel>(MODEL);
    },
    contentParameters: (contentId: string) => {
      recorded.calls.push({ method: 'contentParameters', args: [contentId] });
      return known.has(contentId)
        ? of<H5pContentParameters>(PARAMS_RESPONSE)
        : throwError(notFound);
    },
    save: (contentId: string | undefined, input: SaveH5pContentInput) => {
      recorded.calls.push({ method: 'save', args: [contentId, input] });
      return options.saveFails === true
        ? throwError(() => new HttpErrorResponse({ status: 500, statusText: 'Server Error' }))
        : of<H5pSaveResult>({ ...SAVED, contentId: contentId ?? SAVED.contentId });
    },
  } as unknown as H5pApi;

  TestBed.configureTestingModule({
    providers: [
      provideNoopAnimations(),
      provideRouter(
        [
          { path: 'pages', component: ListStub },
          { path: 'pages/:id', component: FormStub },
          {
            path: 'pages/:id/exercise',
            component: H5pExercisePage,
            resolve: { exerciseData: h5pExerciseResolver },
            canDeactivate: [unsavedChangesGuard],
          },
        ],
        withComponentInputBinding(),
      ),
      { provide: PagesApi, useValue: pagesApi },
      { provide: H5pApi, useValue: h5pApi },
      // A no-op, so `<h5p-editor>` is never upgraded: jsdom has no
      // `ResizeObserver` and fetches no script tags, so an upgraded element
      // would hang this suite rather than fail it.
      { provide: H5P_DEFINE_ELEMENTS, useValue: () => {} },
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
    throw new Error('Expected the exercise screen to be the activated route');
  }
  return element;
}

function editor(harness: RouterTestingHarness): H5pEditorHost {
  const element = root(harness).querySelector<H5pEditorHost>('h5p-editor');
  if (element === null) {
    throw new Error('Expected the screen to mount an h5p-editor');
  }
  return element;
}

/**
 * Drives the widget the way `H5PEditorComponent.save()` does: call
 * `saveContentCallback`, write the id back onto the attribute, dispatch `saved`.
 *
 * This is a test of **this screen's half** of that contract. It is not evidence
 * that `save()` performs those three steps — nothing in jsdom can be, since the
 * real component is never upgraded here.
 */
async function saveThroughWidget(
  harness: RouterTestingHarness,
  body: SaveH5pContentInput = BODY,
): Promise<void> {
  const element = editor(harness);
  const attribute = element.getAttribute('content-id');
  const result = await element.saveContentCallback?.(
    attribute === 'new' || attribute === null ? undefined : attribute,
    body,
  );
  if (result !== undefined) {
    element.setAttribute('content-id', result.contentId);
    element.dispatchEvent(new CustomEvent('saved', { detail: { contentId: result.contentId } }));
  }
  await harness.fixture.whenStable();
  harness.detectChanges();
}

function called(recorded: Recorded, method: string): { method: string; args: unknown[] }[] {
  return recorded.calls.filter((call) => call.method === method);
}

/**
 * What the page form would read on the way in. Taken off the router's own last
 * navigation rather than off `history`, because `provideRouter` in a TestBed
 * drives a mock platform location and never writes the global one — the same
 * reason `page-form-page.spec.ts` puts the state there by hand.
 */
function stateResult(): ExerciseResult | undefined {
  const state = TestBed.inject(Router).lastSuccessfulNavigation()?.extras.state;
  return state?.[EXERCISE_RESULT_STATE] as ExerciseResult | undefined;
}

describe('H5pExercisePage', () => {
  beforeEach(() => {
    history.replaceState({}, '');
  });

  it('boots empty for a page with no exercise, asking for no parameters at all', async () => {
    const recorded = setup();
    const harness = await open('/pages/p1/exercise');

    expect(called(recorded, 'editorModel')).toEqual([{ method: 'editorModel', args: [undefined] }]);
    // The component's own documentation: `library`, `metadata` and `params`
    // "must only be defined if contentId is defined".
    expect(called(recorded, 'contentParameters')).toEqual([]);
    expect(editor(harness).getAttribute('content-id')).toBe('new');
  });

  it('boots an attached exercise from the editor model and its stored parameters', async () => {
    const recorded = setup({ pages: [ATTACHED] });
    const harness = await open('/pages/p1/exercise');

    expect(called(recorded, 'editorModel')).toEqual([{ method: 'editorModel', args: ['c1'] }]);
    expect(called(recorded, 'contentParameters')).toEqual([
      { method: 'contentParameters', args: ['c1'] },
    ]);
    expect(editor(harness).getAttribute('content-id')).toBe('c1');

    const content: H5pEditorContent | undefined = await editor(harness).loadContentCallback?.('c1');
    expect(content).toMatchObject({
      scripts: MODEL.scripts,
      library: 'H5P.MultiChoice 1.16',
      // From `params.params.*`, and not from the response's `h5p`.
      metadata: PARAMS.params.metadata,
      params: PARAMS.params.params,
    });
    expect(content?.metadata).not.toEqual(PARAMS_RESPONSE.h5p);
  });

  it('sends a page that is not an exercise back to its own form, saying why', async () => {
    const recorded = setup({ pages: [RICH_TEXT] });

    await open('/pages/p1/exercise');

    expect(TestBed.inject(Router).url).toBe('/pages/p1');
    expect(recorded.errors).toEqual([PAGE_IS_NOT_AN_EXERCISE]);
  });

  it('sends a deep link to a missing page back to the list, saying nothing itself', async () => {
    const recorded = setup({ pages: [] });

    await open('/pages/p1/exercise');

    expect(TestBed.inject(Router).url).toBe('/pages');
    // The interceptor has already toasted the API's own 404 wording.
    expect(recorded.errors).toEqual([]);
  });

  it('sends a page naming deleted content back to the page form', async () => {
    const recorded = setup({ pages: [ATTACHED], content: [] });

    await open('/pages/p1/exercise');

    expect(TestBed.inject(Router).url).toBe('/pages/p1');
    expect(recorded.errors).toEqual([]);
  });

  it('creates an exercise with no id and hands the result to the page form', async () => {
    const recorded = setup();
    const harness = await open('/pages/p1/exercise');

    await saveThroughWidget(harness);

    expect(called(recorded, 'save')).toEqual([{ method: 'save', args: [undefined, BODY] }]);
    expect(TestBed.inject(Router).url).toBe('/pages/p1');
    expect(stateResult()).toEqual({
      contentId: 'c-new',
      mainLibrary: 'H5P.MultiChoice 1.16',
    });
  });

  it('saves an existing exercise under its own id', async () => {
    const recorded = setup({ pages: [ATTACHED] });
    const harness = await open('/pages/p1/exercise');

    await saveThroughWidget(harness);

    expect(called(recorded, 'save')).toEqual([{ method: 'save', args: ['c1', BODY] }]);
    expect(TestBed.inject(Router).url).toBe('/pages/p1');
    expect(stateResult()?.contentId).toBe('c1');
  });

  it('keeps the author and their work on the screen when the save fails', async () => {
    setup({ saveFails: true });
    const harness = await open('/pages/p1/exercise');

    const element = editor(harness);
    // What the component does with the rejection: dispatch `save-error` with
    // the thrown message, then rethrow.
    await expect(element.saveContentCallback?.(undefined, BODY)).rejects.toThrow(
      EXERCISE_SAVE_FAILED,
    );
    element.dispatchEvent(
      new CustomEvent('save-error', { detail: { message: EXERCISE_SAVE_FAILED } }),
    );
    await harness.fixture.whenStable();
    harness.detectChanges();

    expect(TestBed.inject(Router).url).toBe('/pages/p1/exercise');
    expect(editor(harness).isConnected).toBe(true);
    expect(root(harness).querySelector('.h5p-exercise__error')?.textContent?.trim()).toBe(
      EXERCISE_SAVE_FAILED,
    );
  });

  it('shows a validation error in the widget’s own words, not in the house sentence', async () => {
    setup();
    const harness = await open('/pages/p1/exercise');

    editor(harness).dispatchEvent(
      new CustomEvent('validation-error', {
        detail: { message: "The main title of the content hasn't been set." },
      }),
    );
    harness.detectChanges();

    expect(root(harness).querySelector('.h5p-exercise__error')?.textContent?.trim()).toBe(
      "The main title of the content hasn't been set.",
    );
  });

  it('enables Save as soon as the widget is mounted, and not on the editor’s own event', async () => {
    // The mount is the only readiness signal there is: `editorloaded` never
    // reaches the host page with the client assets this API pins, so a Save
    // gated on it would never enable. ADR-019 has the evidence.
    setup();
    const harness = await open('/pages/p1/exercise');

    const save = root(harness).querySelector<HTMLButtonElement>('.h5p-exercise__save');
    expect(save?.disabled).toBe(false);
  });

  it('tears the widget down on the way out, leaving nothing that can navigate', async () => {
    setup();
    const harness = await open('/pages/p1/exercise');

    const element = editor(harness);
    const container = element.parentElement;
    await TestBed.inject(Router).navigate(['/pages', 'p1']);
    await harness.fixture.whenStable();

    expect(element.isConnected).toBe(false);
    // Removed from its own container, not merely carried out of the document by
    // a view Angular destroyed.
    expect(container?.children ?? []).toHaveLength(0);
    expect(element.loadContentCallback).toBeUndefined();
    expect(element.saveContentCallback).toBeUndefined();

    element.dispatchEvent(new CustomEvent('saved', { detail: { contentId: 'c-9' } }));
    await harness.fixture.whenStable();

    expect(TestBed.inject(Router).url).toBe('/pages/p1');
    expect(stateResult()).toBeUndefined();
  });

  it('asks before leaving a mounted widget, since nothing can ask it whether it is dirty', async () => {
    const recorded = setup();
    const harness = await open('/pages/p1/exercise');

    await TestBed.inject(Router).navigate(['/pages', 'p1']);
    await harness.fixture.whenStable();

    expect(recorded.dialogs).toBe(1);
  });

  it('does not prompt on the navigation a successful save itself triggers', async () => {
    const recorded = setup();
    const harness = await open('/pages/p1/exercise');

    await saveThroughWidget(harness);

    expect(recorded.dialogs).toBe(0);
    expect(TestBed.inject(Router).url).toBe('/pages/p1');
  });

  it('does not prompt once the widget has been torn down', async () => {
    // The teardown clears the mount, so a second navigation — a redirect after
    // the first, say — does not ask about work that is no longer on screen.
    const recorded = setup();
    const harness = await open('/pages/p1/exercise');

    await TestBed.inject(Router).navigate(['/pages', 'p1']);
    await harness.fixture.whenStable();
    expect(recorded.dialogs).toBe(1);

    await TestBed.inject(Router).navigate(['/pages']);
    await harness.fixture.whenStable();

    expect(recorded.dialogs).toBe(1);
  });
});
