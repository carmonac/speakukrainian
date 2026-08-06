import {
  Component,
  computed,
  inject,
  signal,
  viewChild,
  type ElementRef,
  type OnDestroy,
  type OnInit,
} from '@angular/core';
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
  isInNestStrip,
  isNoOpMove,
  isSiblingSlot,
  rowBandAt,
  sectionTitle,
  siblingPositionAt,
  type NestStrip,
  type RowBand,
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
export class SectionsPage implements OnInit, OnDestroy {
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
   * Whether the pointer is in the nest strip, which is the gesture saying "this
   * drop re-parents, it does not reorder".
   */
  protected readonly nesting = signal(false);

  /** The row a release would nest into right now, or `null` for none. */
  protected readonly nestTargetId = signal<string | null>(null);

  private readonly treeList = viewChild<ElementRef<HTMLElement>>('treeList');

  /** Measured once per drag: only the vertical layout moves while one runs. */
  private strip: NestStrip | null = null;
  /** The row translations CDK's sort applied, while they are suspended. */
  private suspended: Map<HTMLElement, string> | null = null;
  private stopTrackingPointer: (() => void) | null = null;

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

  /** The pointer listeners outlive the view otherwise: they are on `window`. */
  ngOnDestroy(): void {
    this.stopTrackingPointer?.();
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

  /** True for a row that travels with the drag: CDK moves only the dragged element. */
  protected travelsWithDrag(row: SectionRow): boolean {
    const id = this.dragging();
    return id !== null && row.section.ancestorIds.includes(id);
  }

  // The members below are the drag's own decisions, and they are public rather
  // than protected because a spec calls them: some are driven directly and the
  // rest are read back after a synthesised gesture.

  /**
   * The rows the dragged section may legally become a child of, which is what
   * the nest columns light up from. Empty while nothing is being dragged.
   */
  readonly nestable = computed<ReadonlySet<string>>(() => {
    const id = this.dragging();
    const moving = id === null ? null : findNode(this.tree(), id);
    if (moving === null) {
      return new Set<string>();
    }
    return new Set(
      this.rows()
        .filter((row) => canMoveInto(moving, row.section))
        .map((row) => row.section.id),
    );
  });

  /**
   * Where the drag placeholder may go: a slot among the dragged row's own
   * siblings and nowhere else, so a plain vertical drag is always a reorder and
   * never an accidental re-parent — and nowhere at all while the pointer is in
   * the nest strip, where a release re-parents instead.
   */
  readonly sortPredicate = (index: number, drag: CdkDrag<SectionRow>): boolean =>
    !this.nesting() && isSiblingSlot(this.rows(), drag.data.section.id, index);

  /**
   * Starts following the pointer for the whole gesture.
   *
   * On `window` and in the capture phase deliberately: CDK listens on
   * `document`, also capturing, and asks `sortPredicate` from inside that
   * handler. A capture listener one node higher is the only placement that is
   * guaranteed to have read the new pointer position before the sort decides
   * what to do with it.
   */
  beginDrag(row: SectionRow): void {
    this.dragging.set(row.section.id);
    this.nesting.set(false);
    this.nestTargetId.set(null);
    this.strip = this.measureNestStrip();

    const options: AddEventListenerOptions = { capture: true, passive: true };
    window.addEventListener('mousemove', this.trackPointer, options);
    window.addEventListener('touchmove', this.trackPointer, options);
    this.stopTrackingPointer = () => {
      window.removeEventListener('mousemove', this.trackPointer, options);
      window.removeEventListener('touchmove', this.trackPointer, options);
    };
  }

  /**
   * Ends the gesture's *visual* state only. What the drop decides is left
   * standing, because CDK raises `ended` before it raises the drop.
   */
  endDrag(): void {
    this.stopTrackingPointer?.();
    this.stopTrackingPointer = null;
    this.resumeSort();
    this.strip = null;
    this.dragging.set(null);
  }

  /**
   * The one thing a release can mean, decided by where the pointer was: in the
   * nest strip it re-parents onto the highlighted row and does nothing at all
   * when no row is highlighted, and anywhere else it reorders to the slot the
   * placeholder was holding. Never both, and never a reorder the strip did not
   * show.
   */
  drop(event: CdkDragDrop<SectionRow[]>): void {
    const targetId = this.nestTargetId();
    const wasNesting = this.nesting();
    this.nesting.set(false);
    this.nestTargetId.set(null);

    if (wasNesting) {
      const target = this.rows().find((row) => row.section.id === targetId);
      if (target !== undefined) {
        this.nest(target, event.item.data.section);
      }
      return;
    }

    this.reorder(event);
  }

  /** A vertical drag: same parent, new position among its siblings. */
  reorder(event: CdkDragDrop<SectionRow[]>): void {
    const moving = event.item.data.section;
    const position = siblingPositionAt(this.rows(), moving.id, event.currentIndex);
    void this.move(moving.id, moving.parentId, position);
  }

  /** A release on a row's nest column: the dragged section becomes its last child. */
  nest(target: SectionRow, moving: SectionTreeNode): void {
    // Unfold the target first, or the row lands somewhere the tree does not show.
    const next = new Set(this.collapsed());
    next.delete(target.section.id);
    this.collapsed.set(next);

    void this.move(moving.id, target.section.id, target.section.children.length);
  }

  /**
   * Where a release would land, recomputed from the live layout on every move.
   *
   * Hit-tested here rather than by giving each row its own `cdkDropList`: CDK
   * caches a receiving list's rectangle once, when the drag starts, and a row
   * that its own sort has since translated is then in two places at once — the
   * cached rectangle it no longer occupies and the one it does. A sibling of the
   * dragged row is always translated, so it could never take a drop.
   */
  private readonly trackPointer = (event: MouseEvent | TouchEvent): void => {
    const point = 'touches' in event ? event.touches[0] : event;
    if (point === undefined) {
      return;
    }

    if (!isInNestStrip(this.strip, point.clientX)) {
      this.resumeSort();
      this.nesting.set(false);
      this.nestTargetId.set(null);
      return;
    }

    this.suspendSort();
    this.nesting.set(true);
    const id = rowBandAt(this.rowBands(), point.clientY);
    this.nestTargetId.set(id !== null && this.nestable().has(id) ? id : null);
  };

  /** The strip is where the nest columns are, taken from the columns themselves. */
  private measureNestStrip(): NestStrip | null {
    const list = this.treeList()?.nativeElement;
    if (list === undefined) {
      return null;
    }

    let left = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    for (const column of list.querySelectorAll<HTMLElement>('.sections-tree__nest')) {
      const rect = column.getBoundingClientRect();
      if (rect.width === 0) {
        continue;
      }
      left = Math.min(left, rect.left);
      right = Math.max(right, rect.right);
    }
    return right > left ? { left, right } : null;
  }

  private rowBands(): RowBand[] {
    const list = this.treeList()?.nativeElement;
    if (list === undefined) {
      return [];
    }

    const bands: RowBand[] = [];
    for (const item of list.querySelectorAll<HTMLElement>('li[data-section-id]')) {
      // The dragged row itself is parked outside the list for the duration and
      // a clone of it holds its slot. Neither is a target for its own drag.
      if (item.classList.contains('cdk-drag-placeholder')) {
        continue;
      }
      const id = item.getAttribute('data-section-id');
      if (id === null) {
        continue;
      }
      const rect = item.getBoundingClientRect();
      bands.push({ id, top: rect.top, bottom: rect.bottom });
    }
    return bands;
  }

  /**
   * Puts the tree back in its resting layout for as long as the pointer is in
   * the strip.
   *
   * CDK sorts by translating the rows it is not dragging, and `sortPredicate`
   * only stops it applying *new* translations. The ones already applied while
   * the pointer travelled would leave every row a little away from where the
   * tree draws it at rest, so the row under the pointer would not be the row the
   * eye is aiming at. Restoring the offsets on the way out hands the sort back
   * exactly the layout it had.
   */
  private suspendSort(): void {
    const list = this.treeList()?.nativeElement;
    if (list === undefined || this.suspended !== null) {
      return;
    }

    const offsets = new Map<HTMLElement, string>();
    for (const item of list.querySelectorAll<HTMLElement>('li')) {
      offsets.set(item, item.style.transform);
      item.style.transform = '';
    }
    this.suspended = offsets;
  }

  private resumeSort(): void {
    const offsets = this.suspended;
    if (offsets === null) {
      return;
    }
    this.suspended = null;
    for (const [item, transform] of offsets) {
      item.style.transform = transform;
    }
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
