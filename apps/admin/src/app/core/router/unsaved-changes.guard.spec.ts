import { TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import {
  provideRouter,
  type ActivatedRouteSnapshot,
  type RouterStateSnapshot,
} from '@angular/router';
import { firstValueFrom, isObservable, of } from 'rxjs';
import { describe, expect, it } from 'vitest';
import {
  UNSAVED_CHANGES_DIALOG,
  unsavedChangesGuard,
  type HasUnsavedChanges,
} from './unsaved-changes.guard';

interface DialogSpy {
  opened: unknown[];
}

function runGuard(
  dirty: boolean,
  closesWith: boolean | undefined,
): {
  result: Promise<boolean>;
  dialog: DialogSpy;
} {
  const dialog: DialogSpy = { opened: [] };

  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      {
        provide: MatDialog,
        useValue: {
          open: (_component: unknown, config: { data: unknown }) => {
            dialog.opened.push(config.data);
            return { afterClosed: () => of(closesWith) };
          },
        } as unknown as MatDialog,
      },
    ],
  });

  const component: HasUnsavedChanges = { hasUnsavedChanges: () => dirty };
  const snapshot = {} as ActivatedRouteSnapshot;
  const state = {} as RouterStateSnapshot;
  const returned = TestBed.runInInjectionContext(() =>
    unsavedChangesGuard(component, snapshot, state, state),
  );

  if (!isObservable(returned)) {
    throw new Error('unsavedChangesGuard is expected to return an observable');
  }
  return { result: firstValueFrom(returned) as Promise<boolean>, dialog };
}

describe('unsavedChangesGuard', () => {
  it('lets a clean form go without asking', async () => {
    const { result, dialog } = runGuard(false, undefined);

    expect(await result).toBe(true);
    expect(dialog.opened).toEqual([]);
  });

  it('lets a dirty form go once the author confirms', async () => {
    const { result, dialog } = runGuard(true, true);

    expect(await result).toBe(true);
    expect(dialog.opened).toEqual([UNSAVED_CHANGES_DIALOG]);
  });

  it('keeps the author on a dirty form when the confirmation is declined', async () => {
    const { result } = runGuard(true, false);

    expect(await result).toBe(false);
  });

  it('keeps the author on a dirty form when the dialog is dismissed', async () => {
    // Escape and a backdrop click close with `undefined`, which the router does
    // not accept as a `GuardResult` — it has to become an explicit `false`.
    const { result } = runGuard(true, undefined);

    expect(await result).toBe(false);
  });
});
