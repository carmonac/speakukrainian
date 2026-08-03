import { inject } from '@angular/core';
import { RedirectCommand, Router, type CanActivateFn } from '@angular/router';
import { toObservable } from '@angular/core/rxjs-interop';
import { filter, map, take } from 'rxjs';
import { AuthService } from './auth.service';

/**
 * Blocks the admin area until Firebase has restored the session. Waiting on
 * `ready` avoids the flash-of-login-page that a naive synchronous check causes
 * on a hard refresh.
 *
 * The attempted URL is stashed in `history.state` so the login page can send
 * the user back where they were going.
 */
export const authGuard: CanActivateFn = (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);

  return toObservable(auth.ready).pipe(
    filter(Boolean),
    take(1),
    map(() => {
      if (auth.isAuthenticated()) {
        return true;
      }
      // `RedirectCommand` is what lets a guard pass navigation state along —
      // `createUrlTree` alone has nowhere to put it.
      return new RedirectCommand(router.createUrlTree(['/login']), {
        state: { returnUrl: state.url },
      });
    }),
  );
};
