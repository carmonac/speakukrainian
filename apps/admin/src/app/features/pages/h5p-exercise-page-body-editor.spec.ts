import { Component, signal, type DebugElement } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { FormControl, NgModel, ReactiveFormsModule } from '@angular/forms';
import { By } from '@angular/platform-browser';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { describe, expect, it } from 'vitest';
import {
  MAX_H5P_UPLOAD_BYTES,
  h5pExercisePageBodySchema,
  h5pUploadTooLargeMessage,
  notAnH5pPackageMessage,
  type H5pContent,
  type H5pSaveResult,
  type LocaleCode,
  type PageBody,
} from '@speakukrainian/shared';
import { LocalesStore } from '../../core/locales/locales.store';
import { NotificationService } from '../../core/notifications/notification.service';
import { MediaPickerService } from '../../shared/media/media-picker.service';
import { RichTextEditor } from '../../shared/rich-text/rich-text-editor';
import { H5pExercisePageBodyEditor } from './h5p-exercise-page-body-editor';
import { H5pApi } from './h5p.api';
import { emptyBodyFor } from './page-body';
import {
  EXERCISE_CONTENT_MISSING,
  EXERCISE_NEEDS_PAGE,
  EXERCISE_NEEDS_SAVE,
  EXERCISE_PREVIOUS_DETACHED,
  EXERCISE_SUMMARY_FAILED,
  NO_EXERCISE_YET,
} from './page-messages';

const EN = 0;
const UK = 1;

const audit = {
  createdAt: '2026-01-01T00:00:00Z',
  createdBy: 'admin',
  updatedAt: '2026-01-01T00:00:00Z',
  updatedBy: 'admin',
};

function row(id: string, overrides: Partial<H5pContent> = {}): H5pContent {
  return {
    id,
    title: 'Telling the time',
    mainLibrary: 'H5P.MultiChoice 1.16',
    pageId: 'p1',
    storagePath: `h5p/content/${id}`,
    sizeBytes: 4096,
    audit,
    ...overrides,
  };
}

function exerciseBody(
  overrides: Partial<Extract<PageBody, { type: 'h5p_exercise' }>> = {},
): PageBody {
  return { ...emptyBodyFor('h5p_exercise'), ...overrides };
}

/** A `.h5p` the browser's own pre-checks accept. */
function packageFile(name = 'telling-the-time.h5p', size = 4096): File {
  const file = new File(['PK'], name);
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

const UPLOADED: H5pSaveResult = {
  contentId: 'c-new',
  title: 'Telling the time',
  mainLibrary: 'H5P.MultiChoice 1.16',
};

/**
 * The value the control is *built* with, so a stored body reaches the component
 * through the one `writeValue` a cold deep link makes — and nothing after it.
 */
let initialBody: PageBody = emptyBodyFor('h5p_exercise');

/** The shell's seam, exactly: one `FormControl<PageBody>` and the two facts it passes down. */
@Component({
  selector: 'app-body-host',
  imports: [ReactiveFormsModule, H5pExercisePageBodyEditor],
  template: `<app-h5p-exercise-page-body-editor
    [formControl]="body"
    [pageId]="pageId()"
    [exerciseBlockedReason]="exerciseBlockedReason()"
  />`,
})
class BodyHost {
  readonly body = new FormControl<PageBody>(initialBody, { nonNullable: true });
  readonly pageId = signal<string | null>('p1');
  readonly exerciseBlockedReason = signal('');
}

interface Options {
  body?: PageBody;
  pageId?: string | null;
  exerciseBlockedReason?: string;
  /** What `GET /h5p/content/:id` answers; anything else 404s. */
  rows?: H5pContent[];
  contentFails?: boolean;
  uploadFails?: unknown;
  uploaded?: H5pSaveResult;
  attachFails?: boolean;
}

interface Recorded {
  /** Every H5P call in order, which is what the attach-before-detach rule needs. */
  sequence: string[];
  errors: string[];
  infos: string[];
}

describe('H5pExercisePageBodyEditor', () => {
  let fixture: ComponentFixture<BodyHost>;
  let recorded: Recorded;

  async function setup(options: Options = {}): Promise<void> {
    recorded = { sequence: [], errors: [], infos: [] };
    initialBody = options.body ?? exerciseBody();
    const rows = new Map((options.rows ?? [row('c1')]).map((entry) => [entry.id, entry]));

    const notFound = (): HttpErrorResponse =>
      new HttpErrorResponse({ status: 404, statusText: 'Not Found' });

    const api = {
      uploadPackage: (file: File) => {
        recorded.sequence.push(`upload(${file.name})`);
        return options.uploadFails === undefined
          ? of<H5pSaveResult>(options.uploaded ?? UPLOADED)
          : throwError(() => options.uploadFails);
      },
      content: (contentId: string) => {
        recorded.sequence.push(`content(${contentId})`);
        if (options.contentFails === true) {
          return throwError(() => new HttpErrorResponse({ status: 500, statusText: 'Boom' }));
        }
        const found = rows.get(contentId);
        return found === undefined ? throwError(notFound) : of(found);
      },
      attach: (contentId: string, pageId: string) => {
        recorded.sequence.push(`attach(${contentId}, ${pageId})`);
        return options.attachFails === true
          ? throwError(() => new HttpErrorResponse({ status: 409, statusText: 'Conflict' }))
          : of(row(contentId, { pageId }));
      },
      detach: (contentId: string) => {
        recorded.sequence.push(`detach(${contentId})`);
        return of(row(contentId, { pageId: null }));
      },
    } as unknown as H5pApi;

    TestBed.configureTestingModule({
      providers: [
        provideNoopAnimations(),
        provideRouter([]),
        { provide: H5pApi, useValue: api },
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
        {
          provide: NotificationService,
          useValue: {
            success: () => {},
            info: (message: string) => recorded.infos.push(message),
            error: (message: string) => recorded.errors.push(message),
          } as unknown as NotificationService,
        },
      ],
    });

    fixture = TestBed.createComponent(BodyHost);
    fixture.componentInstance.pageId.set(options.pageId === undefined ? 'p1' : options.pageId);
    fixture.componentInstance.exerciseBlockedReason.set(options.exerciseBlockedReason ?? '');
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

  function value(): Extract<PageBody, { type: 'h5p_exercise' }> {
    const body = control().value;
    if (body.type !== 'h5p_exercise') {
      throw new Error(`Expected an h5p_exercise body, got ${body.type}`);
    }
    return body;
  }

  function text(selector: string): string {
    return root().querySelector(selector)?.textContent?.trim() ?? '';
  }

  /** Hands the component a file the way the OS picker would. */
  async function choose(file: File): Promise<void> {
    const input = root().querySelector<HTMLInputElement>('.h5p-body__picker');
    if (!input) {
      throw new Error('Expected a file input');
    }
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change'));
    await settle();
    await settle();
  }

  async function toggleTrackResults(): Promise<void> {
    const input = root().querySelector<HTMLInputElement>('.h5p-body__track-results input');
    if (!input) {
      throw new Error('Expected a track-results checkbox');
    }
    input.click();
    await settle();
  }

  async function choosePosition(label: string): Promise<void> {
    const trigger = root().querySelector<HTMLElement>(
      '.h5p-body__position .mat-mdc-select-trigger',
    );
    if (!trigger) {
      throw new Error('Expected the position select');
    }
    trigger.click();
    fixture.detectChanges();
    await fixture.whenStable();

    const options = Array.from(document.querySelectorAll<HTMLElement>('mat-option'));
    const option = options.find((entry) => entry.textContent?.trim() === label);
    if (!option) {
      throw new Error(`Expected an option "${label}"`);
    }
    option.click();
    await settle();
    await settle();
  }

  async function explanationTab(index: number): Promise<DebugElement> {
    const tabs = root().querySelectorAll<HTMLElement>('.h5p-body__explanation [role="tab"]');
    const tab = tabs[index];
    if (!tab) {
      throw new Error(`Expected an explanation tab at index ${index}`);
    }
    tab.click();
    for (let pass = 0; pass < 2; pass += 1) {
      fixture.detectChanges();
      await fixture.whenStable();
    }
    fixture.detectChanges();

    const editor = fixture.debugElement.query(By.directive(RichTextEditor));
    if (!editor) {
      throw new Error('Expected the active explanation tab to hold an editor');
    }
    return editor;
  }

  async function typeExplanation(index: number, html: string): Promise<void> {
    const editor = await explanationTab(index);
    editor.injector.get(NgModel).viewToModelUpdate(html);
    await settle();
  }

  it('populates every control from a stored body, and leaves the form pristine', async () => {
    // A `writeValue` that called `onChange` would dirty the form on load, and
    // the unsaved-changes guard would then prompt about nothing.
    await setup({
      body: exerciseBody({
        h5pContentId: 'c1',
        h5pLibrary: 'H5P.MultiChoice 1.16',
        explanation: { en: '<p>Listen, then answer.</p>' },
        explanationPosition: 'below',
        trackResults: true,
      }),
    });

    expect(text('.h5p-body__title')).toBe('Telling the time');
    expect(text('.h5p-body__library')).toBe('H5P.MultiChoice 1.16');
    expect(text('.h5p-body__position')).toBe('Below the exercise');
    expect(root().querySelector<HTMLInputElement>('.h5p-body__track-results input')?.checked).toBe(
      true,
    );
    expect((await explanationTab(EN)).nativeElement.textContent).toContain('Listen, then answer.');
    expect(control().pristine).toBe(true);
  });

  it('says a page with no exercise has none, rather than showing a blank panel', async () => {
    await setup();

    expect(text('.h5p-body__empty')).toBe(NO_EXERCISE_YET);
    // Nothing to ask the API about, so nothing is asked.
    expect(recorded.sequence).toEqual([]);
  });

  it('shows the attached exercise’s title and library from its index row', async () => {
    // AC1's "shows its title and library": the body stores no title, so this is
    // a read — and it is what makes the summary survive a refresh.
    await setup({ body: exerciseBody({ h5pContentId: 'c1' }) });

    expect(recorded.sequence).toEqual(['content(c1)']);
    expect(text('.h5p-body__title')).toBe('Telling the time');
    expect(text('.h5p-body__library')).toBe('H5P.MultiChoice 1.16');
    expect(text('.h5p-body__id')).toBe('c1');
  });

  it('says the exercise is gone rather than showing a dangling id', async () => {
    await setup({ body: exerciseBody({ h5pContentId: 'c-deleted' }) });

    expect(text('.h5p-body__summary-missing')).toBe(EXERCISE_CONTENT_MISSING);
    expect(root().querySelector('.h5p-body__empty')).toBeNull();
  });

  it('falls back to the body’s own library when the row cannot be read', async () => {
    // The read failed; the attachment did not. Reading this as "no exercise"
    // would be the worse of the two lies.
    await setup({
      body: exerciseBody({ h5pContentId: 'c1', h5pLibrary: 'H5P.DragText 1.10' }),
      contentFails: true,
    });

    expect(text('.h5p-body__summary-failed')).toBe(EXERCISE_SUMMARY_FAILED);
    expect(text('.h5p-body__library')).toBe('H5P.DragText 1.10');
    expect(text('.h5p-body__id')).toBe('c1');
  });

  it('writes the explanation per locale, and omits it entirely when it has no keys', async () => {
    await setup();

    await toggleTrackResults();
    expect('explanation' in value()).toBe(false);

    await typeExplanation(EN, '<p>Listen, then answer.</p>');
    await typeExplanation(UK, '<p>Послухайте, потім дайте відповідь.</p>');

    expect(value().explanation).toEqual({
      en: '<p>Listen, then answer.</p>',
      uk: '<p>Послухайте, потім дайте відповідь.</p>',
    });
  });

  it('round-trips the position and the tracking flag through the control', async () => {
    await setup();

    await choosePosition('Below the exercise');
    expect(value().explanationPosition).toBe('below');

    await toggleTrackResults();
    expect(value().trackResults).toBe(true);

    // And every emit is a body the API would store, not a bare discriminant.
    expect(h5pExercisePageBodySchema.safeParse(control().value).success).toBe(true);
  });

  it('leaves a page with no exercise saveable — only publishing is refused', async () => {
    // An author writes the explanation, saves the draft, and attaches an
    // exercise later. `validate` refusing a null id would make that impossible.
    await setup();

    expect(control().valid).toBe(true);
    expect(control().errors).toBeNull();
    expect(value().h5pContentId).toBeNull();
  });

  it('refuses a file that is not an H5P package before any request', async () => {
    await setup();

    await choose(packageFile('notes.txt'));

    expect(recorded.sequence).toEqual([]);
    expect(recorded.errors).toEqual([notAnH5pPackageMessage('notes.txt')]);
    expect(value().h5pContentId).toBeNull();
  });

  it('refuses an oversized package before any request', async () => {
    await setup();

    await choose(packageFile('huge.h5p', MAX_H5P_UPLOAD_BYTES + 1));

    expect(recorded.sequence).toEqual([]);
    expect(recorded.errors).toEqual([h5pUploadTooLargeMessage()]);
  });

  it('puts the uploaded exercise on the body and attaches it to the page', async () => {
    // AC1 and AC2. The id reaches the body first; the index is reconciled after.
    await setup();

    await choose(packageFile());

    // The summary read trails the attach because it is driven by the id signal
    // and lands on the next change detection pass; the bookkeeping order is the
    // invariant, and it is asserted on its own below.
    expect(recorded.sequence).toEqual([
      'upload(telling-the-time.h5p)',
      'attach(c-new, p1)',
      'content(c-new)',
    ]);
    expect(value().h5pContentId).toBe('c-new');
    expect(value().h5pLibrary).toBe('H5P.MultiChoice 1.16');
    // Nothing was displaced, so nothing is said about a previous exercise.
    expect(recorded.infos).toEqual([]);
  });

  it('leaves h5pLibrary off the body when the package reported no main library', async () => {
    // An empty string is a value that means nothing, and the key is optional.
    await setup({ uploaded: { ...UPLOADED, mainLibrary: '' } });

    await choose(packageFile());

    expect(value().h5pContentId).toBe('c-new');
    expect('h5pLibrary' in value()).toBe(false);
  });

  it('repoints the page at a replacement and detaches the old exercise, in that order', async () => {
    // AC5. Detaching first would open a window in which no row names the page.
    await setup({ body: exerciseBody({ h5pContentId: 'c1' }) });

    await choose(packageFile());

    expect(recorded.sequence).toEqual([
      'content(c1)',
      'upload(telling-the-time.h5p)',
      'attach(c-new, p1)',
      'detach(c1)',
      'content(c-new)',
    ]);
    expect(value().h5pContentId).toBe('c-new');
    expect(recorded.infos).toEqual([EXERCISE_PREVIOUS_DETACHED]);
  });

  it('keeps the uploaded exercise on the body when the attach fails', async () => {
    // The package is installed by then. Discarding it to protect an index the
    // API explicitly allows to be stale would throw away the author's work.
    await setup({ attachFails: true });

    await choose(packageFile());

    expect(value().h5pContentId).toBe('c-new');
    // The interceptor carries the API's own sentence; nothing is added here.
    expect(recorded.errors).toEqual([]);
  });

  it('leaves the body untouched when the upload itself fails', async () => {
    await setup({
      body: exerciseBody({ h5pContentId: 'c1' }),
      uploadFails: new HttpErrorResponse({ status: 500, statusText: 'Boom' }),
    });
    const before = control().value;

    await choose(packageFile());

    expect(control().value).toEqual(before);
    expect(recorded.sequence).toEqual(['content(c1)', 'upload(telling-the-time.h5p)']);
    // A 5xx reaches the author as the interceptor's generic sentence, which
    // names neither the file nor the reason, so naming the file adds something.
    expect(recorded.errors).toEqual(['Could not upload telling-the-time.h5p.']);
  });

  it('lets the API’s own refusal stand rather than burying it', async () => {
    // A 400 naming what is wrong with the package has already been toasted
    // verbatim by the error interceptor.
    await setup({
      uploadFails: new HttpErrorResponse({ status: 400, statusText: 'Bad Request' }),
    });

    await choose(packageFile());

    expect(recorded.errors).toEqual([]);
    expect(value().h5pContentId).toBeNull();
  });

  it('refuses the upload until the page exists, and says which rule that is', async () => {
    // `/pages/new` has no page to attach the result to. It does **not** say
    // "save your changes first": the upload navigates nowhere, so nothing about
    // an unsaved edit is at risk.
    await setup({ pageId: null, exerciseBlockedReason: EXERCISE_NEEDS_PAGE });

    const upload = root().querySelector<HTMLButtonElement>('.h5p-body__upload');
    expect(upload?.disabled).toBe(true);
    expect(text('.h5p-body__upload-blocked')).toBe(EXERCISE_NEEDS_PAGE);
  });

  it('offers the upload on a saved page whose form is dirty, and withdraws only the widget link', async () => {
    // The two rules are different rules: the widget route reads the stored page
    // and the upload does not.
    await setup({ exerciseBlockedReason: EXERCISE_NEEDS_SAVE });

    expect(root().querySelector<HTMLButtonElement>('.h5p-body__upload')?.disabled).toBe(false);
    expect(root().querySelector('.h5p-body__upload-blocked')).toBeNull();
    expect(root().querySelector('a.h5p-body__exercise-link')).toBeNull();
    expect(text('.h5p-body__exercise-blocked')).toBe(EXERCISE_NEEDS_SAVE);
  });

  it('links to the widget route, and names the act by what is attached', async () => {
    await setup();

    expect(text('a.h5p-body__exercise-link')).toBe('Create exercise');
    expect(root().querySelector('a.h5p-body__exercise-link')?.getAttribute('href')).toBe(
      '/pages/p1/exercise',
    );

    await choose(packageFile());

    expect(text('a.h5p-body__exercise-link')).toBe('Edit exercise');
  });

  it('opens the file picker from the Upload button', async () => {
    // The button is what an author clicks; the input is hidden and does nothing
    // on its own.
    await setup();
    const input = root().querySelector<HTMLInputElement>('.h5p-body__picker');
    let clicks = 0;
    input?.addEventListener('click', (event) => {
      event.preventDefault();
      clicks += 1;
    });

    root().querySelector<HTMLButtonElement>('.h5p-body__upload')?.click();

    expect(clicks).toBe(1);
  });

  it('treats a programmatic write as a load and not as an author edit', async () => {
    await setup();

    control().setValue(exerciseBody({ h5pContentId: 'c1', explanationPosition: 'below' }));
    await settle();

    expect(control().pristine).toBe(true);
    expect(text('.h5p-body__title')).toBe('Telling the time');
    expect(text('.h5p-body__position')).toBe('Below the exercise');
  });

  it('stops accepting edits when the control is disabled', async () => {
    await setup();
    control().disable();
    await settle();

    expect(root().querySelector<HTMLButtonElement>('.h5p-body__upload')?.disabled).toBe(true);
    expect(root().querySelector<HTMLInputElement>('.h5p-body__track-results input')?.disabled).toBe(
      true,
    );
    expect(root().querySelector('.h5p-body__position')?.getAttribute('aria-disabled')).toBe('true');
    expect(
      root().querySelector('.rte__content .ProseMirror')?.getAttribute('contenteditable'),
    ).toBe('false');
  });
});
