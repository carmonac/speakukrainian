import { inject } from '@angular/core';
import type { ResolveFn } from '@angular/router';
import type { Locale } from '@speakukrainian/shared';
import { LocalesStore } from './locales.store';

/**
 * Loads the locale list before any admin screen activates, so a deep link to a
 * form with a localized editor never paints an empty tab strip. A failure is
 * already reported by the error interceptor; resolving `[]` keeps the
 * navigation alive instead of stranding the user on the previous screen.
 */
export const localesResolver: ResolveFn<readonly Locale[]> = () =>
  inject(LocalesStore)
    .load()
    .catch(() => []);
