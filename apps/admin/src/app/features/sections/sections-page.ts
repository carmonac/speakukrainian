import { Component, computed, inject, signal, type OnInit } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
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
import { DELETE_WITH_CHILDREN_MESSAGE, MAX_DEPTH_MESSAGE } from './section-messages';
import { flattenTree, sectionTitle, type SectionRow } from './sections.model';
import { SectionsApi } from './sections.api';

@Component({
  selector: 'app-sections-page',
  imports: [RouterLink, MatButtonModule, MatIconModule, MatProgressBarModule, MatTooltipModule],
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

  protected readonly maxDepthMessage = MAX_DEPTH_MESSAGE;
  protected readonly deleteWithChildrenMessage = DELETE_WITH_CHILDREN_MESSAGE;

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
