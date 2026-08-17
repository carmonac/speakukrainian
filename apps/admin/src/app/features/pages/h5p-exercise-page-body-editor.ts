import {
  Component,
  type ElementRef,
  computed,
  forwardRef,
  inject,
  input,
  linkedSignal,
  signal,
  viewChild,
} from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { HttpErrorResponse } from '@angular/common/http';
import {
  FormsModule,
  NG_VALIDATORS,
  NG_VALUE_ACCESSOR,
  type AbstractControl,
  type ControlValueAccessor,
  type ValidationErrors,
  type Validator,
} from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';
import { concat, catchError, firstValueFrom, map, of, switchMap, type Observable } from 'rxjs';
import {
  H5P_PACKAGE_EXTENSION,
  MAX_H5P_UPLOAD_BYTES,
  h5pExercisePageBodySchema,
  h5pUploadTooLargeMessage,
  isH5pPackageFilename,
  notAnH5pPackageMessage,
  resolveLocalized,
  type H5pContent,
  type H5pExercisePageBody,
  type LocaleCode,
  type PageBody,
  type RichText,
} from '@speakukrainian/shared';
import { LocalesStore } from '../../core/locales/locales.store';
import { showsApiMessage } from '../../core/http/error.interceptor';
import { NotificationService } from '../../core/notifications/notification.service';
import { LocalizedRichTextEditor } from '../../shared/rich-text/localized-rich-text-editor';
import { H5pExercisePreview } from './h5p-exercise-preview';
import { reattachExercise, reportAttachment } from './h5p-exercise.model';
import { H5pApi } from './h5p.api';
import { emptyBodyFor } from './page-body';
import {
  EXERCISE_CONTENT_MISSING,
  EXERCISE_NEEDS_PAGE,
  EXERCISE_PREVIEW_HINT,
  EXERCISE_SUMMARY_FAILED,
  EXERCISE_UPLOAD_HINT,
  NO_EXERCISE_YET,
  PREVIEW_LOCALE_LABEL,
  TRACK_RESULTS_HINT,
} from './page-messages';

/**
 * The schema's own defaults, so no default is restated in this file (rule 1),
 * and through the one seed the admin has rather than a second parse of its own.
 */
const EMPTY_BODY: H5pExercisePageBody = emptyBodyFor('h5p_exercise');

/**
 * What the attached-exercise summary is showing.
 *
 * `missing` and `failed` are distinct because the remedies are: a 404 means the
 * exercise is gone and another has to be attached, anything else means the read
 * failed and the exercise is probably fine. Neither may read as "nothing is
 * attached", which is what `none` alone says.
 */
interface SummaryState {
  status: 'none' | 'loading' | 'ready' | 'missing' | 'failed';
  content: H5pContent | null;
}

const NONE: SummaryState = { status: 'none', content: null };
const LOADING: SummaryState = { status: 'loading', content: null };
const MISSING: SummaryState = { status: 'missing', content: null };
const FAILED: SummaryState = { status: 'failed', content: null };

/**
 * The `h5p_exercise` half of the page form: which exercise the page shows, and
 * the explanation that sits above or below it.
 *
 * Like its two siblings it is a `ControlValueAccessor` **and** a `Validator`
 * over the shell's single `FormControl<PageBody>`, so the value's shape and
 * what makes it invalid stay behind that one control.
 *
 * **It never writes the page.** An upload stores the package and puts the
 * resulting id on the body; the author presses Save. What it does write, on its
 * own, is `h5pContent.pageId` — the index over the relationship the body
 * records — and it does that *after* the body, never blocking it. See
 * `reattachExercise` for why that order is not negotiable.
 *
 * `validate()` says nothing about a null `h5pContentId`: a draft exercise page
 * with no exercise is a legitimate, saveable state. Only publishing is refused,
 * by the shell, through `publishBlockedReason` — the same function the API's
 * own refusal is worded by.
 */
@Component({
  selector: 'app-h5p-exercise-page-body-editor',
  imports: [
    FormsModule,
    RouterLink,
    MatButtonModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatProgressBarModule,
    MatSelectModule,
    MatTooltipModule,
    LocalizedRichTextEditor,
    H5pExercisePreview,
  ],
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => H5pExercisePageBodyEditor),
      multi: true,
    },
    {
      provide: NG_VALIDATORS,
      useExisting: forwardRef(() => H5pExercisePageBodyEditor),
      multi: true,
    },
  ],
  templateUrl: './h5p-exercise-page-body-editor.html',
  styleUrl: './h5p-exercise-page-body-editor.scss',
})
export class H5pExercisePageBodyEditor implements ControlValueAccessor, Validator {
  private readonly api = inject(H5pApi);
  private readonly notifications = inject(NotificationService);

  /**
   * The stored page's id, or `null` on `/pages/new`. Not body-type knowledge on
   * the shell's side — it is the page the form is already editing — and the
   * binding lives on the `@case`, so no other body editor sees it.
   */
  readonly pageId = input.required<string | null>();

  /**
   * Why the widget route is refused, or `''`. The shell owns this rule because
   * it is about the *form* — an unsaved edit would be invisible to a route that
   * reads the stored page — and it is bound as a method call so it keeps
   * re-evaluating as the form's dirty flag changes.
   *
   * Deliberately **not** applied to the upload, which navigates nowhere: see
   * {@link uploadBlockedReason}.
   */
  readonly exerciseBlockedReason = input.required<string>();

  private readonly store = inject(LocalesStore);
  protected readonly locales = this.store.codes;
  private readonly defaultCode = this.store.defaultCode;

  protected readonly noExerciseYet = NO_EXERCISE_YET;
  protected readonly uploadHint = EXERCISE_UPLOAD_HINT;
  protected readonly summaryFailed = EXERCISE_SUMMARY_FAILED;
  protected readonly contentMissing = EXERCISE_CONTENT_MISSING;
  protected readonly trackResultsHint = TRACK_RESULTS_HINT;
  protected readonly previewHint = EXERCISE_PREVIEW_HINT;
  protected readonly previewLocaleLabel = PREVIEW_LOCALE_LABEL;
  protected readonly acceptAttribute = H5P_PACKAGE_EXTENSION;

  protected readonly h5pContentId = signal<string | null>(EMPTY_BODY.h5pContentId);
  /** `undefined` **is** the absent key, which is what the schema stores for it. */
  protected readonly h5pLibrary = signal<string | undefined>(undefined);
  protected readonly explanation = signal<RichText>({});
  protected readonly explanationPosition = signal<H5pExercisePageBody['explanationPosition']>(
    EMPTY_BODY.explanationPosition,
  );
  protected readonly trackResults = signal(EMPTY_BODY.trackResults);
  protected readonly disabled = signal(false);
  protected readonly uploading = signal(false);

  private readonly picker = viewChild.required<ElementRef<HTMLInputElement>>('picker');

  /**
   * `switchMap` and not an `effect()`: it cancels an in-flight read when the id
   * changes again, so the summary of a replaced exercise can never land after
   * the summary of the one that replaced it.
   */
  private readonly summary = toSignal(
    toObservable(this.h5pContentId).pipe(
      switchMap((id) => (id === null ? of(NONE) : this.readSummary(id))),
    ),
    { initialValue: LOADING },
  );

  protected readonly summaryStatus = computed(() => this.summary().status);
  protected readonly summaryTitle = computed(() => this.summary().content?.title ?? '');

  /**
   * The index row's ubername when it could be read, and the body's own stored
   * one when it could not — the body is where the library is recorded, so a
   * failed read costs the title and not this.
   */
  protected readonly libraryLabel = computed(
    () => this.summary().content?.mainLibrary ?? this.h5pLibrary() ?? '',
  );

  /**
   * Why the upload is refused, or `''`. **One rule, not two.** The package goes
   * to `POST /h5p/content` and the author stays on this form, so nothing about
   * an unsaved edit is at risk — printing `EXERCISE_NEEDS_SAVE` here would be a
   * sentence that is not true of this control. What it does need is a page to
   * attach the result to, which `/pages/new` does not have yet.
   */
  protected readonly uploadBlockedReason = computed(() =>
    this.pageId() === null ? EXERCISE_NEEDS_PAGE : '',
  );

  /**
   * Derived view state with nothing shareable in it, so it is not routed:
   * ADR-005 is about state a refresh would *lose*, and a refresh re-derives this
   * from the default locale at no cost.
   */
  protected readonly previewLocale = linkedSignal<LocaleCode | null>(
    () => this.defaultCode() ?? this.locales()[0] ?? null,
  );

  /**
   * Not routed either, and for a second reason: the preview is keyed on the id
   * in the **control**, which a refresh discards in favour of the stored page's.
   * A deep link to "preview open" could therefore play a different exercise than
   * the one the author was looking at.
   */
  protected readonly previewOpen = signal(false);

  protected readonly previewToggleLabel = computed(() =>
    this.previewOpen() ? 'Hide preview' : 'Preview exercise',
  );

  /**
   * The explanation the preview shows. A locale the author has not written falls
   * back to the default and then to `''`, so nothing renders `undefined`.
   */
  protected readonly explanationHtml = computed(() => {
    const locale = this.previewLocale();
    return locale === null
      ? ''
      : resolveLocalized(this.explanation(), locale, this.defaultCode() ?? locale);
  });

  protected readonly exerciseLinkLabel = computed(() =>
    this.h5pContentId() === null ? 'Create exercise' : 'Edit exercise',
  );

  /** The widget route is keyed on a stored page, so it has no target without one. */
  protected readonly exerciseRoute = computed(() => {
    const id = this.pageId();
    return id === null ? ['/pages'] : ['/pages', id, 'exercise'];
  });

  private onChange: (value: PageBody) => void = () => {};
  private onTouched: () => void = () => {};

  /** Emits nothing: a `writeValue` that called `onChange` would dirty the form on load. */
  writeValue(value: PageBody | null): void {
    const body = value?.type === 'h5p_exercise' ? value : EMPTY_BODY;
    this.h5pContentId.set(body.h5pContentId);
    this.h5pLibrary.set(body.h5pLibrary);
    this.explanation.set(body.explanation ?? {});
    this.explanationPosition.set(body.explanationPosition);
    this.trackResults.set(body.trackResults);
  }

  registerOnChange(fn: (value: PageBody) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  setDisabledState(isDisabled: boolean): void {
    this.disabled.set(isDisabled);
  }

  /**
   * The schema half only. A null `h5pContentId` is **not** an error: an author
   * writes the explanation, saves the draft, and attaches an exercise later.
   * The one thing that cannot happen to such a page is publication, and that is
   * refused by the shell rather than by making the form unsaveable.
   */
  validate(control: AbstractControl): ValidationErrors | null {
    return h5pExercisePageBodySchema.safeParse(control.value).success ? null : { body: true };
  }

  protected chooseFile(): void {
    this.picker().nativeElement.click();
  }

  /**
   * The input's value is cleared before anything else, so choosing the **same**
   * file again still fires `change` — which is exactly what an author does after
   * fixing a package the API refused.
   */
  protected async onFileChosen(event: Event): Promise<void> {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) {
      return;
    }
    const file = input.files?.[0] ?? null;
    input.value = '';
    if (file !== null) {
      await this.upload(file);
    }
  }

  protected onExplanation(next: RichText): void {
    this.explanation.set(next);
    this.emit();
  }

  protected onExplanationPosition(position: H5pExercisePageBody['explanationPosition']): void {
    this.explanationPosition.set(position);
    this.emit();
  }

  /**
   * Closing destroys the preview, and with it the mounted `<h5p-player>` — which
   * is what makes reopening a fresh mount rather than a second one.
   */
  protected togglePreview(): void {
    this.previewOpen.update((open) => !open);
  }

  protected onTrackResults(track: boolean): void {
    this.trackResults.set(track);
    this.emit();
  }

  /**
   * Pre-checked in the browser against the same two rules the API enforces, so
   * an author who picked the wrong file is told before a 100 MB round trip —
   * the shape `MediaPickerService.uploadFile` sets, down to letting the
   * interceptor's own sentence stand when the API explained itself.
   *
   * On success the id reaches the **body first** and the index is reconciled
   * after. The package is on the server by then, and the body is the
   * authoritative record of what the page shows; failing the upload because a
   * bookkeeping call failed would discard content already stored. The order is
   * not merely tidier: Save on the page form is **not** disabled while an
   * upload is in flight, so emitting after the attach would leave a window in
   * which Save stores the previous id and orphans the package just installed.
   */
  private async upload(file: File): Promise<void> {
    if (!isH5pPackageFilename(file.name)) {
      this.notifications.error(notAnH5pPackageMessage(file.name));
      return;
    }
    if (file.size > MAX_H5P_UPLOAD_BYTES) {
      this.notifications.error(h5pUploadTooLargeMessage());
      return;
    }

    const pageId = this.pageId();
    if (pageId === null || this.uploading() || this.disabled()) {
      return;
    }

    this.uploading.set(true);
    const previousContentId = this.h5pContentId();
    try {
      const result = await firstValueFrom(this.api.uploadPackage(file));

      this.h5pContentId.set(result.contentId);
      // Left off rather than stored empty, the rule `applyExerciseResult`
      // already follows: `h5pLibrary` is optional, and `''` means nothing.
      this.h5pLibrary.set(result.mainLibrary === '' ? undefined : result.mainLibrary);
      this.emit();

      reportAttachment(
        this.notifications,
        await reattachExercise(this.api, {
          pageId,
          previousContentId,
          nextContentId: result.contentId,
        }),
      );
    } catch (error) {
      // A rejection the API explained itself — 413 naming the limit, 400 naming
      // what is wrong with the package — has already been toasted verbatim by
      // the error interceptor, and a generic toast on top would bury it.
      if (!(error instanceof HttpErrorResponse) || !showsApiMessage(error)) {
        this.notifications.error(`Could not upload ${file.name}.`);
      }
    } finally {
      this.uploading.set(false);
    }
  }

  private emit(): void {
    const library = this.h5pLibrary();
    const explanation = this.explanation();
    this.onChange({
      type: 'h5p_exercise',
      h5pContentId: this.h5pContentId(),
      ...(library === undefined ? {} : { h5pLibrary: library }),
      // Carried whenever the record has any key at all, including
      // `{ en: '<p></p>' }`: blank-but-present is what a tab the author opened
      // and left empty looks like (ADR-009), and it is the rule
      // `SubsectionListPageBodyEditor.emit` states for `intro`.
      ...(Object.keys(explanation).length === 0 ? {} : { explanation }),
      explanationPosition: this.explanationPosition(),
      trackResults: this.trackResults(),
    });
    this.onTouched();
  }

  private readSummary(id: string): Observable<SummaryState> {
    return concat(
      of(LOADING),
      this.api.content(id).pipe(
        map((content): SummaryState => ({ status: 'ready', content })),
        // Swallowed so the panel can say which of the two happened; the HTTP
        // error interceptor has already toasted the API's own sentence.
        catchError((error: unknown) =>
          of(error instanceof HttpErrorResponse && error.status === 404 ? MISSING : FAILED),
        ),
      ),
    );
  }
}
