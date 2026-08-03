import {
  type ApplicationConfig,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from '@angular/core';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import {
  provideRouter,
  withComponentInputBinding,
  withInMemoryScrolling,
  withRouterConfig,
} from '@angular/router';
import { routes } from './app.routes';
import { authInterceptor } from './core/auth/auth.interceptor';
import { errorInterceptor } from './core/http/error.interceptor';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    // Material's overlays and ripples need the animations package; loading it
    // asynchronously keeps it out of the initial bundle.
    provideAnimationsAsync(),
    provideHttpClient(withFetch(), withInterceptors([authInterceptor, errorInterceptor])),
    provideRouter(
      routes,
      // Route params and resolved data arrive as component inputs, which keeps
      // detail components free of manual ActivatedRoute plumbing.
      withComponentInputBinding(),
      withInMemoryScrolling({ scrollPositionRestoration: 'enabled', anchorScrolling: 'enabled' }),
      // Re-running resolvers on param-only changes matters for the section tree,
      // where navigating between siblings reuses the same component instance.
      withRouterConfig({ paramsInheritanceStrategy: 'always', onSameUrlNavigation: 'reload' }),
    ),
  ],
};
