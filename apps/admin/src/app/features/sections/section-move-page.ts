import { Component, DestroyRef, computed, inject, input, signal, type OnInit } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { HttpErrorResponse } from '@angular/common/http';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { firstValueFrom } from 'rxjs';
import { LocalesStore } from '../../core/locales/locales.store';
import { NotificationService } from '../../core/notifications/notification.service';
import { MAX_DEPTH_MESSAGE, SLUG_TAKEN_FALLBACK } from './section-messages';
import type { SectionMoveData } from './section-move.resolver';
import {
  applyMove,
  findNode,
  isNoOpMove,
  parentOptions,
  positionOptions,
  sectionTitle,
} from './sections.model';
import { SectionsApi } from './sections.api';

/**
 * Moves one section, on `/sections/:id/move`. It is the keyboard's way to do
 * what the tree's drag gesture does — the same `api.move` call with the same
 * `{ parentId, sortOrder }` body — and a real route, so it survives a refresh
 * and can be deep-linked.
 *
 * No `ErrorStateMatcher` provider and no `canDeactivate`: both selects always
 * hold a valid value, so Save is always enabled and `ngSubmit` really fires,
 * which is what Material's default matcher waits for; and a half-chosen
 * destination is not unsaved work worth prompting about.
 */
@Component({
  selector: 'app-section-move-page',
  imports: [
    ReactiveFormsModule,
    RouterLink,
    MatButtonModule,
    MatCardModule,
    MatFormFieldModule,
    MatProgressBarModule,
    MatSelectModule,
  ],
  templateUrl: './section-move-page.html',
  styleUrl: './section-move-page.scss',
})
export class SectionMovePage implements OnInit {
  private readonly api = inject(SectionsApi);
  private readonly notifications = inject(NotificationService);
  private readonly router = inject(Router);
  private readonly fb = inject(FormBuilder);
  private readonly destroyRef = inject(DestroyRef);
  /** Read once: the default locale does not change while a screen is open. */
  private readonly defaultCode = inject(LocalesStore).defaultCode();

  /** Resolved by `sectionMoveResolver` and bound by `withComponentInputBinding()`. */
  readonly formData = input.required<SectionMoveData>();

  protected readonly saving = signal(false);
  /** The API's own sentence about a slug clash, bound to the parent field. */
  protected readonly parentConflict = signal<string | null>(null);
  protected readonly maxDepthMessage = MAX_DEPTH_MESSAGE;

  protected readonly form = this.fb.group({
    parentId: this.fb.control<string | null>(null),
    position: this.fb.nonNullable.control(0),
  });

  /**
   * Change detection is zoneless, so what the template derives from a control
   * has to reach it as a signal: the `setValue` in `ngOnInit` notifies nothing
   * on its own. `initialValue` is the null the control is built with, and the
   * `setValue` below is what replaces it.
   */
  private readonly parentValue = toSignal(this.form.controls.parentId.valueChanges, {
    initialValue: null as string | null,
  });

  protected readonly title = computed(() =>
    sectionTitle(this.formData().section, this.defaultCode),
  );

  protected readonly parents = computed(() =>
    parentOptions(this.formData().tree, this.formData().section, this.defaultCode),
  );

  protected readonly positions = computed(() =>
    positionOptions(
      this.formData().tree,
      this.formData().section,
      this.parentValue(),
      this.defaultCode,
    ),
  );

  /** Where the section will answer once it has moved, the way the form page previews a slug. */
  protected readonly derivedPath = computed(() => {
    const { tree, section } = this.formData();
    const parentId = this.parentValue();
    const parent = parentId === null ? null : findNode(tree, parentId);
    return `${parent === null ? '' : parent.path}/${section.slug}`;
  });

  ngOnInit(): void {
    const { section, tree } = this.formData();
    const siblings =
      section.parentId === null ? tree : (findNode(tree, section.parentId)?.children ?? []);
    // Its own index among its siblings is the position that puts it back where
    // it is: taking it out shifts only the siblings after it.
    const index = siblings.findIndex((sibling) => sibling.id === section.id);

    this.form.setValue({
      parentId: section.parentId,
      position: Math.max(index, 0),
    });

    // Subscribed after the initial value, so opening the screen does not count
    // as choosing a new parent.
    this.form.controls.parentId.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        // The positions belong to the old parent's children and mean nothing
        // under the new one.
        this.form.controls.position.setValue(0);
        this.parentConflict.set(null);
      });
  }

  protected async submit(): Promise<void> {
    if (this.saving()) {
      return;
    }

    const { section, tree } = this.formData();
    const { parentId, position } = this.form.getRawValue();

    // The screen opens on the placement the section already has, so Move with
    // nothing changed is a request that would only rewrite the numbers the
    // server is holding. Same guard the drag gesture makes, over the same pure
    // functions. It goes back to the tree with the row highlighted and says
    // nothing: a "was moved" toast for a move that never happened is a lie, and
    // the highlighted row is where the section is.
    if (isNoOpMove(tree, applyMove(tree, section.id, { parentId, position }), section.id)) {
      await this.router.navigate(['/sections'], { state: { savedId: section.id } });
      return;
    }

    this.saving.set(true);
    try {
      await firstValueFrom(this.api.move(section.id, { parentId, sortOrder: position }));
      this.notifications.success(`"${this.title()}" was moved.`);
      // The same hand-off the form page makes, so the row lands highlighted.
      await this.router.navigate(['/sections'], { state: { savedId: section.id } });
    } catch (error) {
      this.applyConflict(error);
    } finally {
      this.saving.set(false);
    }
  }

  /**
   * The only 409 `PATCH /:id/move` raises is a sibling slug clash at the
   * destination — `has-children` belongs to DELETE. Binding it to the parent
   * field is what points at the choice to change; the interceptor's toast
   * carries the same sentence and is not suppressed, the pair #5 settled.
   */
  private applyConflict(error: unknown): void {
    if (!(error instanceof HttpErrorResponse) || error.status !== 409) {
      return;
    }
    const body = error.error as { message?: string } | null;
    this.parentConflict.set(body?.message ?? SLUG_TAKEN_FALLBACK);
    this.form.controls.parentId.setErrors({ taken: true });
    this.form.controls.parentId.markAsTouched();
  }
}
