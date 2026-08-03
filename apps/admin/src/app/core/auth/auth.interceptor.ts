import { inject } from '@angular/core';
import type { HttpInterceptorFn } from '@angular/common/http';
import { from, switchMap } from 'rxjs';
import { AuthService } from './auth.service';
import { environment } from '../../../environments/environment';

/** Attaches a fresh Firebase ID token to every call to our own API. */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  if (!req.url.startsWith(environment.apiBaseUrl)) {
    return next(req);
  }

  const auth = inject(AuthService);

  return from(auth.getIdToken()).pipe(
    switchMap((token) =>
      next(token ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } }) : req),
    ),
  );
};
