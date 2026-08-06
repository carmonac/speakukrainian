import { Component, computed, inject, signal, type OnInit } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { DragDropModule, type CdkDrag, type CdkDragDrop } from '@angular/cdk/drag-drop';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { firstValueFrom } from 'rxjs';
import type { SectionTreeNode } from '@speakukrainian/shared';
import { LocalesStore } from '../../core/locales/locales.store';
import { NotificationService } from '../../core/notifications/notification.service';
import { navigationState } from '../../core/router/navigation-state';
import { ConfirmDialog, type ConfirmDialogData } from '../../shared/dialogs/confirm-dialog';
import {
  DELETE_WITH_CHILDREN_MESSAGE,
  MAX_DEPTH_MESSAGE,
  NEST_HINT,
  TREE_DRAG_HINT,
} from './section-messages';
import {
  applyMove,
  canMoveInto,
  findNode,
  flattenTree,
  isNoOpMove,
  isSiblingSlot,
  sectionTitle,
  siblingPositionAt,
  type SectionRow,
} from './sections.model';
import { SectionsApi } from './sections.api';

@Component({
  selector: 'app-sections-page',
  imports: [
    DragDropModule,
    RouterLink,
    MatButtonModule,
    MatIconModule,
    MatProgressBarModule,
    MatTooltipModule,
  ],
  templateUrl: './sections-page.html',
  styleUrl: './sections-page.scss',
})
export class SectionsPage implements OnInit {
  private readonly api = inject(SectionsApi);
  private readonly dialog = inject(MatDialog);
  private readonly notifications = inject(NotificationService);
  private readonly router = inject(Router);
  private readonly defaultCode = inject(LocalesStore).defaultCode;

  private readonly tree = signal<readonly SectionTreeNode[]>([]);
  /** Ids whose subtree is folded away, so a fresh tree comes up fully open. */
  private readonly collapsed = signal<ReadonlySet<string>>(new Set());

  protected readonly loading = signal(true);
  protected readonly busy = signal(false);
  protected readonly rows = computed(() => flattenTree(this.tree(), this.collapsed()));

  /** The row being dragged, which is what tells its descendants to dim. */
  protected readonly dragging = signal<string | null>(null);

  /**
   * The nest columns the tree hands a drag to, named and connected by id.
   *
   * Not a `cdkDropListGroup`: a `cdkDropList` provides `CDK_DROP_LIST_GROUP:
   * undefined` to its own subtree, so a nest column — which lives inside a row
   * of this very list — resolves no group, joins nothing, and leaves the tree
   * with no sibling to hand the drag to. That failure is silent, which is why
   * `sections-page.spec.ts` pins the connection.
   */
  protected readonly nestListIds = computed(() => this.rows().map((row) => this.nestListId(row)));

  protected readonly maxDepthMessage = MAX_DEPTH_MESSAGE;
  protected readonly deleteWithChildrenMessage = DELETE_WITH_CHILDREN_MESSAGE;
  protected readonly nestHint = NEST_HINT;
  protected readonly dragHint = TREE_DRAG_HINT;

  /**
   * Set by the form page on save, so the row the admin just touched is obvious.
   * It travels in the navigation state, never in a service, so it survives a
   * refresh of `/sections` (rule 5).
   */
  protected readonly savedId = signal<string | null>(
    navigationState<string>(this.router, 'savedId') ?? null,
  );

  ngOnInit(): void {
    void this.load();
  }

  protected title(row: SectionRow): string {
    return sectionTitle(row.section, this.defaultCode());
  }

  protected toggle(id: string): void {
    // A new Set, not a mutation: zoneless change detection notices the signal
    // being set, never a set being edited in place.
    const next = new Set(this.collapsed());
    if (!next.delete(id)) {
      next.add(id);
    }
    this.collapsed.set(next);
  }

  /** The drop list id of a row's nest column, and the name the tree connects to. */
  protected nestListId(row: SectionRow): string {
    return `nest-${row.section.id}`;
  }

  /** True for a row that travels with the drag: CDK moves only the dragged element. */
  protected travelsWithDrag(row: SectionRow): boolean {
    const id = this.dragging();
    return id !== null && row.section.ancestorIds.includes(id);
  }

  // The four members below are the drop decisions, and they are public rather
  // than protected because a spec calls them: jsdom gives every element a zero
  // rect, so CDK's own sorting maths is meaningless there and a synthesised
  // pointer sequence would assert nothing. They are driven directly instead.

  /**
   * Where the drag placeholder may go: a slot among the dragged row's own
   * siblings and nowhere else, so a plain vertical drag is always a reorder and
   * never an accidental re-parent.
   */
  readonly sortPredicate = (index: number, drag: CdkDrag<SectionRow>): boolean =>
    isSiblingSlot(this.rows(), drag.data.section.id, index);

  /**
   * Whether the dragged section may be dropped into `target`'s nest column.
   * Refuses while a move is in flight, so a second drop cannot race the first
   * one's rollback.
   */
  nestPredicate(target: SectionRow): (drag: CdkDrag<SectionRow>) => boolean {
    return (drag) => !this.busy() && canMoveInto(drag.data.section, target.section);
  }

  /** A vertical drag: same parent, new position among its siblings. */
  reorder(event: CdkDragDrop<SectionRow[]>): void {
    const moving = event.item.data.section;
    const position = siblingPositionAt(this.rows(), moving.id, event.currentIndex);
    void this.move(moving.id, moving.parentId, position);
  }

  /** A drop on a row's nest column: the dragged section becomes its last child. */
  nest(target: SectionRow, event: CdkDragDrop<SectionRow>): void {
    const moving = event.item.data.section;
    // Unfold the target first, or the row lands somewhere the tree does not show.
    const next = new Set(this.collapsed());
    next.delete(target.section.id);
    this.collapsed.set(next);

    void this.move(moving.id, target.section.id, target.section.children.length);
  }

  /**
   * Repaints first and asks afterwards. On success the optimistic tree stands
   * rather than being replaced by a re-read: `applyMove` recomputes exactly
   * what the server recomputes from the same inputs, the body carries no
   * derived field, and the next visit to `/sections` re-reads anyway. On a
   * failure nothing changed on the server, so putting the previous tree back is
   * the whole repair — the interceptor has already said what went wrong.
   */
  private async move(id: string, parentId: string | null, position: number): Promise<void> {
    if (this.busy()) {
      return;
    }

    const previous = this.tree();
    const before = findNode(previous, id);
    if (before === null) {
      return;
    }

    const next = applyMove(previous, id, { parentId, position });
    if (isNoOpMove(previous, next, id)) {
      return;
    }

    this.busy.set(true);
    this.tree.set(next);
    try {
      await firstValueFrom(this.api.move(id, { parentId, sortOrder: position }));
      this.notifications.success(`"${sectionTitle(before, this.defaultCode())}" was moved.`);
    } catch {
      // Reported by the HTTP error interceptor. The server refused, so the tree
      // it had before the drop is still the true one.
      this.tree.set(previous);
    } finally {
      this.busy.set(false);
    }
  }

  protected async confirmDelete(row: SectionRow): Promise<void> {
    if (this.busy()) {
      return;
    }

    const title = this.title(row);
    const data: ConfirmDialogData = {
      title: `Delete "${title}"?`,
      message: 'This cannot be undone.',
      confirmLabel: 'Delete',
    };
    const confirmed = await firstValueFrom(
      this.dialog
        .open<ConfirmDialog, ConfirmDialogData, boolean>(ConfirmDialog, { data })
        .afterClosed(),
    );
    if (!confirmed) {
      return;
    }

    this.busy.set(true);
    try {
      await firstValueFrom(this.api.remove(row.section.id));
      this.notifications.success(`"${title}" was deleted.`);
    } catch {
      // Reported by the HTTP error interceptor.
    } finally {
      // Re-read whatever happened. A refused delete means the tree on screen
      // disagreed with the API — the 409 is it saying a subsection exists that
      // this row does not show — and the reloaded row then carries the disabled
      // Delete and `DELETE_WITH_CHILDREN_MESSAGE` that say what to do about it.
      await this.load();
      this.busy.set(false);
    }
  }

  /** A failure leaves the tree as it was; the interceptor has already toasted. */
  private async load(): Promise<void> {
    this.loading.set(true);
    try {
      this.tree.set(await firstValueFrom(this.api.tree()));
    } catch {
      // Reported by the HTTP error interceptor.
    } finally {
      this.loading.set(false);
    }
  }
}
