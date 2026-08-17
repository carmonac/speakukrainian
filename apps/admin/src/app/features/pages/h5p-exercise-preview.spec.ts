import { Component, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Subject, of, throwError } from 'rxjs';
import { describe, expect, it } from 'vitest';
import type { H5pExercisePageBody } from '@speakukrainian/shared';
import { H5P_DEFINE_PLAYER_ELEMENT } from './h5p-elements';
import { H5pExercisePreview } from './h5p-exercise-preview';
import { H5pApi, type H5pPlayerModel } from './h5p.api';
import { EXERCISE_PREVIEW_FAILED } from './page-messages';

/**
 * `h5p-player` is never defined here: `H5P_DEFINE_PLAYER_ELEMENT` is provided as
 * a no-op, so the element stays a plain `HTMLElement`. An upgraded one would
 * construct a `ResizeObserver` jsdom does not implement and then wait forever on
 * scripts jsdom never fetches, which hangs a run rather than failing it.
 */
function model(contentId: string): H5pPlayerModel {
  return {
    contentId,
    integration: { contents: {} },
    scripts: ['/api/h5p/core/js/h5p.js'],
    styles: ['/api/h5p/core/styles/h5p.css'],
    embedTypes: ['iframe'],
  };
}

@Component({
  selector: 'app-preview-host',
  imports: [H5pExercisePreview],
  template: `<app-h5p-exercise-preview
    [contentId]="contentId()"
    [explanationHtml]="explanationHtml()"
    [position]="position()"
  />`,
})
class PreviewHost {
  readonly contentId = signal('c1');
  readonly explanationHtml = signal('');
  readonly position = signal<H5pExercisePageBody['explanationPosition']>('above');
}

interface Options {
  fails?: boolean;
  /** Holds the answer until the test releases it, so the loading state is observable. */
  gate?: boolean;
}

interface Recorded {
  /** Every id `playerModel` was asked for, which is what the re-mount tests count. */
  requests: string[];
  release: () => void;
}

describe('H5pExercisePreview', () => {
  let fixture: ComponentFixture<PreviewHost>;
  let recorded: Recorded;

  async function setup(options: Options = {}): Promise<void> {
    let release = (): void => {};
    recorded = { requests: [], release: () => release() };

    const api = {
      playerModel: (contentId: string) => {
        recorded.requests.push(contentId);
        if (options.fails === true) {
          return throwError(() => new Error('offline'));
        }
        if (options.gate === true) {
          const gate = new Subject<H5pPlayerModel>();
          release = () => {
            gate.next(model(contentId));
            gate.complete();
          };
          return gate.asObservable();
        }
        return of(model(contentId));
      },
    } as unknown as H5pApi;

    TestBed.configureTestingModule({
      providers: [
        { provide: H5pApi, useValue: api },
        // A no-op, so `<h5p-player>` is never upgraded.
        { provide: H5P_DEFINE_PLAYER_ELEMENT, useValue: () => {} },
      ],
    });

    fixture = TestBed.createComponent(PreviewHost);
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

  function players(): NodeListOf<HTMLElement> {
    return root().querySelectorAll<HTMLElement>('h5p-player');
  }

  function player(): HTMLElement {
    const element = root().querySelector<HTMLElement>('h5p-player');
    if (element === null) {
      throw new Error('Expected an h5p-player');
    }
    return element;
  }

  /** Whether the player host comes after the explanation in document order. */
  function playerFollowsExplanation(): boolean {
    const explanation = root().querySelector('.h5p-preview__explanation');
    const host = root().querySelector('.h5p-preview__player');
    if (explanation === null || host === null) {
      throw new Error('Expected both an explanation and a player host');
    }
    return (explanation.compareDocumentPosition(host) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  }

  it('mounts one player for the exercise it was given', async () => {
    await setup();

    expect(recorded.requests).toEqual(['c1']);
    expect(players()).toHaveLength(1);
    expect(player().getAttribute('content-id')).toBe('c1');
  });

  it('does not re-mount the exercise when the explanation or the position changes', async () => {
    // **The defect this issue names as most likely.** If the mount effect read
    // `explanationHtml`, every keystroke would tear the exercise down and refetch
    // it — and an author would lose their place in a half-answered exercise.
    await setup();
    const mounted = player();

    for (const html of ['<p>a</p>', '<p>ab</p>', '<p>abc</p>']) {
      fixture.componentInstance.explanationHtml.set(html);
      await settle();
    }
    fixture.componentInstance.position.set('below');
    await settle();
    fixture.componentInstance.position.set('above');
    await settle();

    expect(recorded.requests).toEqual(['c1']);
    // Identity, not a count: teardown does `replaceChildren()`, so a re-mount
    // necessarily produces a different element.
    expect(player()).toBe(mounted);
    expect(players()).toHaveLength(1);
  });

  it('re-mounts when the attached exercise changes', async () => {
    await setup();
    const first = player();

    fixture.componentInstance.contentId.set('c2');
    await settle();

    expect(recorded.requests).toEqual(['c1', 'c2']);
    expect(player()).not.toBe(first);
    expect(player().getAttribute('content-id')).toBe('c2');
    expect(players()).toHaveLength(1);
  });

  it('puts the explanation before the exercise when the position is above', async () => {
    await setup();
    fixture.componentInstance.explanationHtml.set('<p>Listen, then answer.</p>');
    await settle();

    // Document order, not a CSS property: a preview whose DOM order disagrees
    // with the page's is not a preview of the page.
    expect(playerFollowsExplanation()).toBe(true);
  });

  it('puts the explanation after the exercise when the position is below', async () => {
    await setup();
    fixture.componentInstance.explanationHtml.set('<p>Listen, then answer.</p>');
    fixture.componentInstance.position.set('below');
    await settle();

    expect(playerFollowsExplanation()).toBe(false);
  });

  it('renders no explanation block at all when there is nothing to explain', async () => {
    await setup();

    expect(root().querySelector('.h5p-preview__explanation')).toBeNull();

    fixture.componentInstance.position.set('below');
    await settle();

    expect(root().querySelector('.h5p-preview__explanation')).toBeNull();
  });

  it('keeps an embedded audio clip and drops a script, which is Angular’s sanitizer', async () => {
    // Unlike a stored explanation this HTML has not been through
    // `PagesService.sanitizeBody`, so `[innerHTML]` is the only pass over it.
    await setup();
    fixture.componentInstance.explanationHtml.set(
      '<p>Listen</p><audio src="/api/media/hello.mp3" controls></audio><script>alert(1)</script>',
    );
    await settle();

    const audio = root().querySelector<HTMLAudioElement>('.h5p-preview__explanation audio');
    expect(audio?.getAttribute('src')).toBe('/api/media/hello.mp3');
    expect(audio?.hasAttribute('controls')).toBe(true);
    expect(root().querySelector('.h5p-preview__explanation script')).toBeNull();
  });

  it('says the exercise could not be loaded, and mounts nothing', async () => {
    // The player forwards a falsy `content-id` rather than refusing it, so
    // "never mount without a model" is this component's guarantee.
    await setup({ fails: true });

    expect(root().querySelector('.h5p-preview__failed')?.textContent?.trim()).toBe(
      EXERCISE_PREVIEW_FAILED,
    );
    expect(players()).toHaveLength(0);
  });

  it('shows a progress bar while the model is on its way, and no player yet', async () => {
    await setup({ gate: true });

    expect(root().querySelector('mat-progress-bar')).not.toBeNull();
    expect(players()).toHaveLength(0);

    recorded.release();
    await settle();

    expect(root().querySelector('mat-progress-bar')).toBeNull();
    expect(players()).toHaveLength(1);
  });
});
