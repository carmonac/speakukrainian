import { Injectable, inject } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';

/** Thin wrapper over Material snackbars so call sites stay one-liners. */
@Injectable({ providedIn: 'root' })
export class NotificationService {
  private readonly snackBar = inject(MatSnackBar);

  success(message: string): void {
    this.snackBar.open(message, 'Dismiss', { duration: 4000, panelClass: 'toast-success' });
  }

  error(message: string): void {
    this.snackBar.open(message, 'Dismiss', { duration: 8000, panelClass: 'toast-error' });
  }

  info(message: string): void {
    this.snackBar.open(message, 'Dismiss', { duration: 4000 });
  }
}
