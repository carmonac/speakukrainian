import { inject } from '@angular/core';
import { RedirectCommand, Router, type CanActivateFn } from '@angular/router';
import { toObservable } from '@angular/core/rxjs-interop';
import { filter, from, map, of, switchMap, take } from 'rxjs';
import { AuthService } from './auth.service';

export const STAFF_DENIED_MESSAGE = 'You do not have access to the admin panel.';

/**
 * Requires at least an `editor` role for the admin shell. It waits on `ready`
 * itself rather than assuming `authGuard` ran first, so it is order-independent.
 *
 * A browser refresh restores a cached ID token whose claims can be up to an hour
 * stale, so a user promoted since their last sign-in would be refused here. One
 * forced token refresh — only when the cached claims are insufficient — lets the
 * promotion take effect without a sign-out. A genuine student pays one extra
 * token fetch on the way out.
 */
export const staffGuard: CanActivateFn = (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);

  const deny = () => {
    // Someone who is simply signed out is not being refused; `authGuard` covers
    // them, and telling them they lack access would be misleading.
    const message = auth.isAuthenticated() ? { message: STAFF_DENIED_MESSAGE } : {};
    // `RedirectCommand` is what lets a guard pass navigation state along —
    // `createUrlTree` alone has nowhere to put it.
    return new RedirectCommand(router.createUrlTree(['/login']), {
      state: { returnUrl: state.url, ...message },
    });
  };

  return toObservable(auth.ready).pipe(
    filter(Boolean),
    take(1),
    switchMap(() =>
      auth.isStaff() ? of(true) : from(auth.refreshClaims()).pipe(map(() => auth.isStaff())),
    ),
    map((allowed) => (allowed ? true : deny())),
  );
};
