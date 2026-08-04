import { Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatTableModule } from '@angular/material/table';
import { MatTooltipModule } from '@angular/material/tooltip';
import { firstValueFrom } from 'rxjs';
import type { Locale } from '@speakukrainian/shared';
import { LocalesStore } from '../../core/locales/locales.store';
import { NotificationService } from '../../core/notifications/notification.service';
import { ConfirmDialog, type ConfirmDialogData } from '../../shared/dialogs/confirm-dialog';

export const DEFAULT_LOCALE_TOOLTIP = 'The default locale cannot be disabled or deleted.';

@Component({
  selector: 'app-locales-page',
  imports: [
    RouterLink,
    MatButtonModule,
    MatIconModule,
    MatProgressBarModule,
    MatSlideToggleModule,
    MatTableModule,
    MatTooltipModule,
  ],
  templateUrl: './locales-page.html',
  styleUrl: './locales-page.scss',
})
export class LocalesPage {
  private readonly store = inject(LocalesStore);
  private readonly notifications = inject(NotificationService);
  private readonly dialog = inject(MatDialog);
  private readonly router = inject(Router);

  protected readonly locales = this.store.locales;
  protected readonly columns = [
    'code',
    'name',
    'nativeName',
    'direction',
    'isDefault',
    'enabled',
    'order',
    'actions',
  ];
  protected readonly busy = signal(false);
  protected readonly defaultTooltip = DEFAULT_LOCALE_TOOLTIP;

  /**
   * Set by the form page on save, so the row the admin just touched is obvious.
   * The pending navigation carries it during the save — the router only writes
   * it into `history.state` after this component is activated — and the browser
   * replays it from there across a refresh. A service would lose it (rule 5).
   */
  protected readonly savedCode = signal<string | null>(
    (this.router.getCurrentNavigation()?.extras.state?.['savedCode'] as string | undefined) ??
      (history.state?.['savedCode'] as string | undefined) ??
      null,
  );

  protected async makeDefault(locale: Locale): Promise<void> {
    await this.run(
      () => this.store.setDefault(locale.code),
      `${locale.name} is now the default locale.`,
    );
  }

  protected async setEnabled(locale: Locale, enabled: boolean): Promise<void> {
    await this.run(
      () => this.store.update(locale.code, { enabled }),
      `${locale.name} is now ${enabled ? 'enabled' : 'disabled'}.`,
    );
  }

  protected async move(index: number, offset: number): Promise<void> {
    const codes = this.locales().map((locale) => locale.code);
    const target = index + offset;
    const moved = codes[index];
    const displaced = codes[target];
    if (moved === undefined || displaced === undefined) {
      return;
    }

    codes[index] = displaced;
    codes[target] = moved;
    await this.run(() => this.store.reorder(codes), 'Locale order saved.');
  }

  protected async confirmDelete(locale: Locale): Promise<void> {
    const data: ConfirmDialogData = {
      title: `Delete ${locale.name}?`,
      message: `Content already authored in ${locale.name} stays stored and reappears if the locale is added back.`,
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

    await this.run(() => this.store.remove(locale.code), `${locale.name} was deleted.`);
  }

  /** Failures are already toasted by the error interceptor, so they stop here. */
  private async run(work: () => Promise<unknown>, success: string): Promise<void> {
    if (this.busy()) {
      return;
    }
    this.busy.set(true);
    try {
      await work();
      this.notifications.success(success);
    } catch {
      // Reported by the HTTP error interceptor.
    } finally {
      this.busy.set(false);
    }
  }
}
