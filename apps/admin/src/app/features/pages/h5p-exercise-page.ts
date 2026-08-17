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
import { H5P_DEFINE_EDITOR_ELEMENT } from './h5p-elements';
import { NotificationService } from '../../core/notifications/notification.service';
import {
  EXERCISE_RESULT_STATE,
  H5P_NEW_CONTENT_ID,
  mountH5pEditor,
  reattachExercise,
  reportAttachment,
  type ExerciseResult,
  type H5pEditorHost,
} from './h5p-exercise.model';
import type { H5pExerciseData } from './h5p-exercise.resolver';
import { H5pApi } from './h5p.api';
import { EXERCISE_LOADING, EXERCISE_PICK_TYPE, EXERCISE_SAVE_FAILED } from './page-messages';
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
  private readonly notifications = inject(NotificationService);
  private readonly router = inject(Router);
  /** Read once: the default locale does not change while a screen is open. */
  private readonly defaultCode = inject(LocalesStore).defaultCode();

  /** Resolved by `h5pExerciseResolver` and bound by `withComponentInputBinding()`. */
  readonly exerciseData = input.required<H5pExerciseData>();

  private readonly host = viewChild.required<ElementRef<HTMLElement>>('host');

  /**
   * True once the widget has built a content type's form and dispatched
   * `editorloaded`. Save waits for it because before it there is nothing the
   * widget can save: `H5PEditorComponent.save()` calls `getParams()` on a form
   * that does not exist and throws a raw `TypeError` **before** it reaches any
   * of its own `dispatchAndThrowError` calls, so it is a failure that reports
   * itself nowhere.
   *
   * For a new exercise that moment is when the author picks a content type, not
   * when the screen paints — which is why {@link waitingMessage} says different
   * things for the two cases rather than calling both of them "loading".
   */
  protected readonly ready = signal(false);
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

  /**
   * What the screen says while Save is disabled. A new exercise is not waiting
   * on this screen at all — the content type hub is up and the author's next act
   * is to choose one — so calling that "loading" would be a lie printed over a
   * working control.
   */
  protected readonly waitingMessage = computed(() =>
    this.exerciseData().contentId === null ? EXERCISE_PICK_TYPE : EXERCISE_LOADING,
  );

  /** Only the existing-exercise case is genuinely waiting on a fetch. */
  protected readonly loading = computed(
    () => !this.ready() && this.exerciseData().contentId !== null,
  );

  constructor() {
    inject(H5P_DEFINE_EDITOR_ELEMENT)();

    effect((onCleanup) => {
      const container = this.host().nativeElement;
      const data = this.exerciseData();

      this.ready.set(false);
      this.saving.set(false);
      this.error.set(null);
      this.savedContentId.set(null);
      this.saveResult = null;

      const teardown = mountH5pEditor(container, {
        contentId: data.contentId ?? H5P_NEW_CONTENT_ID,
        content: data.content,
        save: (contentId, body) => this.persist(contentId, body),
        onReady: () => this.ready.set(true),
        onSaved: (contentId) => void this.finish(contentId),
        onError: (message) => this.showFailure(message),
        onInvalid: (message) => this.showFailure(message),
      });

      onCleanup(() => {
        teardown();
        this.ready.set(false);
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
    return this.ready() && this.savedContentId() === null;
  }

  /**
   * **Every failure here has to end in a sentence on screen.** The component
   * dispatches `save-error` or `validation-error` for the failures it
   * recognises, and those set the banner with wording worth reading — but only
   * those. A throw it does not recognise, or an element that was never upgraded,
   * would otherwise leave a button that does nothing and says nothing, which is
   * the worst outcome available to this screen. So the `catch` fills the banner
   * in rather than swallowing, and only when an event has not already filled it
   * with something better.
   */
  protected async save(): Promise<void> {
    const element = this.host().nativeElement.querySelector<H5pEditorHost>('h5p-editor');
    if (element === null || !this.ready() || this.saving()) {
      return;
    }

    this.error.set(null);
    try {
      await (element.save?.() ?? Promise.reject(new Error(EXERCISE_SAVE_FAILED)));
    } catch {
      this.error.update((current) => current ?? EXERCISE_SAVE_FAILED);
    }
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

  /**
   * **The attach for this flow lives here and not in the body editor.** The
   * result reaches that editor through `writeValue`, which also runs on every
   * page load — so an attach there would fire on page open. This screen already
   * holds the page id and the id the body named before the save, which is
   * everything a replace needs.
   *
   * The navigation happens whatever the reconciliation returned: the exercise
   * is saved, and refusing to hand its id back would strand it.
   */
  private async finish(contentId: string): Promise<void> {
    // Before anything awaits, or the guard prompts on the way out of a screen
    // that has just saved.
    this.savedContentId.set(contentId);

    const result: ExerciseResult = {
      contentId,
      // The widget dispatches `saved` only after `saveContentCallback`
      // resolved, so the recorded result is the one this id came from.
      mainLibrary: this.saveResult?.mainLibrary ?? '',
    };

    reportAttachment(
      this.notifications,
      await reattachExercise(this.api, {
        pageId: this.exerciseData().page.id,
        // The resolver's own copy of `body.h5pContentId`, which is what the
        // page named on the way in — so a save under a new id is a replace.
        //
        // **That replace is not reachable from the UI today**: the widget saves
        // an existing exercise back to the same content id, so entering this
        // screen on a page that already has one and saving attaches nothing and
        // detaches nothing. The branch is defensive, and the only thing that
        // exercises it is the spec's forced `savedAs`. Worth knowing before
        // someone reads the dead detach as dead code.
        previousContentId: this.exerciseData().contentId,
        nextContentId: contentId,
      }),
    );

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
