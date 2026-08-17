import {
  Component,
  type ElementRef,
  computed,
  effect,
  inject,
  input,
  viewChild,
} from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { catchError, concat, map, of, switchMap, type Observable } from 'rxjs';
import type { H5pExercisePageBody } from '@speakukrainian/shared';
import { H5P_DEFINE_PLAYER_ELEMENT } from './h5p-elements';
import { mountH5pPlayer } from './h5p-exercise.model';
import { H5pApi, type H5pPlayerModel } from './h5p.api';
import { EXERCISE_PREVIEW_FAILED } from './page-messages';

/**
 * What the panel is showing.
 *
 * The id is held **inside** the state rather than read from the input again at
 * mount time, and that is structural: it is what keeps the mount effect's
 * dependency set to this one signal. See the effect below.
 */
interface PlayerState {
  status: 'loading' | 'ready' | 'failed';
  /** The id this model was fetched for, or `null` when there is no model. */
  contentId: string | null;
  model: H5pPlayerModel | null;
}

const LOADING: PlayerState = { status: 'loading', contentId: null, model: null };
const FAILED: PlayerState = { status: 'failed', contentId: null, model: null };

/**
 * Plays one attached exercise with its explanation above or below it, laid out
 * as the public page will lay it out.
 *
 * It knows nothing about locales: the body editor resolves the explanation for
 * the preview language and hands down a string, which is what keeps this
 * component's own surface to three inputs.
 *
 * **A green suite is not evidence that this boots.** jsdom implements no
 * `ResizeObserver`, executes no cross-origin `<script src>` and runs no
 * `iframe.contentDocument.write`, so what the specs cover is the request, the
 * mount's write order, the teardown and the layout — never the exercise
 * actually running (ADR-013, ADR-019).
 */
@Component({
  selector: 'app-h5p-exercise-preview',
  imports: [MatProgressBarModule],
  templateUrl: './h5p-exercise-preview.html',
  styleUrl: './h5p-exercise-preview.scss',
})
export class H5pExercisePreview {
  private readonly api = inject(H5pApi);

  /** The exercise to play. Never empty: the panel is behind the caller's `@if`. */
  readonly contentId = input.required<string>();
  /** Already resolved for the preview locale, and sanitized on the way into the DOM. */
  readonly explanationHtml = input('');
  readonly position = input.required<H5pExercisePageBody['explanationPosition']>();

  protected readonly previewFailed = EXERCISE_PREVIEW_FAILED;

  private readonly host = viewChild.required<ElementRef<HTMLElement>>('host');

  /**
   * `switchMap` and not an `effect()`: it cancels an in-flight read when the id
   * changes again, so a slow answer for a replaced exercise can never land after
   * the answer for the one that replaced it.
   */
  private readonly state = toSignal(
    toObservable(this.contentId).pipe(switchMap((id) => this.load(id))),
    { initialValue: LOADING },
  );

  protected readonly status = computed(() => this.state().status);

  constructor() {
    inject(H5P_DEFINE_PLAYER_ELEMENT)();

    /**
     * **This effect reads the state and the host and nothing else.** `state`
     * changes only when `contentId` changes, because `contentId` is the only
     * input of the pipeline that produces it — so the explanation and the
     * position are structurally incapable of tearing the exercise down and
     * refetching it. The id is taken out of the state for the same reason:
     * reading `contentId()` here "for the id" would add it as a dependency and
     * lose that guarantee at the next edit of this file.
     */
    effect((onCleanup) => {
      const state = this.state();
      const host = this.host().nativeElement;
      if (state.model === null || state.contentId === null) {
        return;
      }
      onCleanup(mountH5pPlayer(host, { contentId: state.contentId, model: state.model }));
    });
  }

  private load(contentId: string): Observable<PlayerState> {
    return concat(
      of(LOADING),
      this.api.playerModel(contentId).pipe(
        map((model): PlayerState => ({ status: 'ready', contentId, model })),
        // Swallowed so the panel can say so in its own words; the HTTP error
        // interceptor has already toasted the API's.
        catchError(() => of(FAILED)),
      ),
    );
  }
}
