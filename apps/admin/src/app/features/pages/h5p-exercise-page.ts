import {
  Component,
  type ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { firstValueFrom } from 'rxjs';
import type { H5pSaveResult, SaveH5pContentInput } from '@speakukrainian/shared';
import { LocalesStore } from '../../core/locales/locales.store';
import type { HasUnsavedChanges } from '../../core/router/unsaved-changes.guard';
import { H5P_DEFINE_ELEMENTS } from './h5p-elements';
import {
  EXERCISE_RESULT_STATE,
  H5P_NEW_CONTENT_ID,
  mountH5pEditor,
  type ExerciseResult,
  type H5pEditorHost,
} from './h5p-exercise.model';
import type { H5pExerciseData } from './h5p-exercise.resolver';
import { H5pApi } from './h5p.api';
import { EXERCISE_SAVE_FAILED } from './page-messages';
import { pageTitle } from './pages.model';

/**
 * Joubel's H5P authoring widget, on `/pages/:id/exercise` — a real route, so it
 * deep-links and survives a refresh (rule 5).
 *
 * **It never writes the page.** A successful save posts the exercise and hands
 * the resulting content id back to the page form in `history.state`; the author
 * presses Save there. Two screens writing one document is how a body edit gets
 * lost, and `PageFormPage.submit` posts the whole body.
 *
 * **The mount lives in an `effect` that reads the resolved input**, not in
 * `ngOnInit`: a `/pages/1/exercise` → `/pages/2/exercise` navigation reuses this
 * component, and only reading the input inside the effect re-mounts the widget
 * for the second page. (#39 is where that rule is being written into ADR-005;
 * it is not there yet.)
 */
@Component({
  selector: 'app-h5p-exercise-page',
  imports: [RouterLink, MatButtonModule, MatCardModule, MatProgressBarModule],
  templateUrl: './h5p-exercise-page.html',
  styleUrl: './h5p-exercise-page.scss',
})
export class H5pExercisePage implements HasUnsavedChanges {
  private readonly api = inject(H5pApi);
  private readonly router = inject(Router);
  /** Read once: the default locale does not change while a screen is open. */
  private readonly defaultCode = inject(LocalesStore).defaultCode();

  /** Resolved by `h5pExerciseResolver` and bound by `withComponentInputBinding()`. */
  readonly exerciseData = input.required<H5pExerciseData>();

  private readonly host = viewChild.required<ElementRef<HTMLElement>>('host');

  /**
   * True once the widget has been mounted, which is the **only** readiness
   * signal this screen has. The component's `editorloaded` event is not one:
   * with the client assets this API pins it never reaches the host page, so
   * Save gated on it would never enable. ADR-019 has the evidence.
   */
  protected readonly mounted = signal(false);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly savedContentId = signal<string | null>(null);

  /** The last `H5pSaveResult`, which is where the ubername for the page comes from. */
  private saveResult: H5pSaveResult | null = null;

  protected readonly pageTitleText = computed(() =>
    pageTitle(this.exerciseData().page, this.defaultCode),
  );
  protected readonly heading = computed(() =>
    this.exerciseData().contentId === null ? 'Create exercise' : 'Edit exercise',
  );
  protected readonly pageLink = computed(() => ['/pages', this.exerciseData().page.id]);

  constructor() {
    inject(H5P_DEFINE_ELEMENTS)();

    effect((onCleanup) => {
      const container = this.host().nativeElement;
      const data = this.exerciseData();

      this.mounted.set(false);
      this.saving.set(false);
      this.error.set(null);
      this.savedContentId.set(null);
      this.saveResult = null;

      const teardown = mountH5pEditor(container, {
        contentId: data.contentId ?? H5P_NEW_CONTENT_ID,
        content: data.content,
        save: (contentId, body) => this.persist(contentId, body),
        onSaved: (contentId) => void this.finish(contentId),
        onError: (message) => this.showFailure(message),
        onInvalid: (message) => this.showFailure(message),
      });
      this.mounted.set(true);

      onCleanup(() => {
        teardown();
        this.mounted.set(false);
      });
    });
  }

  /**
   * There is no way to ask Joubel's editor whether it is dirty, so the honest
   * predicate is "the widget mounted and no save has succeeded since". It
   * over-prompts — Cancel on an untouched widget asks to discard — and that is
   * the right direction for work no reload can recover.
   */
  hasUnsavedChanges(): boolean {
    return this.mounted() && this.savedContentId() === null;
  }

  protected save(): void {
    const element = this.host().nativeElement.querySelector<H5pEditorHost>('h5p-editor');
    if (element === null || this.saving()) {
      return;
    }
    this.error.set(null);
    // The rejection is already reported through the component's own
    // `save-error` and `validation-error` events; this catch exists so an
    // unhandled rejection does not reach the console.
    void element.save().catch(() => {});
  }

  /**
   * What `saveContentCallback` delegates to. It throws a **sentence**, because
   * the component puts `error.message` into the `save-error` event's detail and
   * that detail is what the banner shows; the API's own wording arrives
   * separately as the interceptor's toast.
   */
  private async persist(
    contentId: string | undefined,
    body: SaveH5pContentInput,
  ): Promise<{ contentId: string }> {
    this.saving.set(true);
    try {
      const result = await firstValueFrom(this.api.save(contentId, body));
      this.saveResult = result;
      return { contentId: result.contentId };
    } catch {
      throw new Error(EXERCISE_SAVE_FAILED);
    } finally {
      this.saving.set(false);
    }
  }

  private async finish(contentId: string): Promise<void> {
    // Before the navigation, or the guard prompts on the way out of a screen
    // that has just saved.
    this.savedContentId.set(contentId);

    const result: ExerciseResult = {
      contentId,
      // The widget dispatches `saved` only after `saveContentCallback`
      // resolved, so the recorded result is the one this id came from.
      mainLibrary: this.saveResult?.mainLibrary ?? '',
    };

    await this.router.navigate(['/pages', this.exerciseData().page.id], {
      state: { [EXERCISE_RESULT_STATE]: result },
    });
  }

  /**
   * Both failure events mean the same thing to the author — the exercise was
   * not saved and the work is still on screen — so an event that arrived with
   * no message of its own falls back to that sentence rather than blanking the
   * banner.
   */
  private showFailure(message: string): void {
    this.error.set(message === '' ? EXERCISE_SAVE_FAILED : message);
  }
}
