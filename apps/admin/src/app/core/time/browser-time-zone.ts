import { InjectionToken } from '@angular/core';

/**
 * The IANA zone the grid is drawn in: whichever one this browser is set to.
 *
 * A token rather than a direct `Intl` call at the point of use, for two
 * reasons. The factory runs in an injection context and never at module scope,
 * so nothing reads the machine's clock while the bundle is evaluating. And
 * every schedule spec overrides it — which is the only thing that makes those
 * tests independent of the machine the suite happens to run on, where a leaked
 * zone fails as a slot in the wrong day column rather than as an error.
 *
 * `packages/shared/src/time.ts` places a live obligation on its callers: its
 * formatter cache is bounded only because every zone that reaches it has been
 * through `timeZoneSchema`, which refuses fixed offsets. This value satisfies
 * that obligation without a parse — `resolvedOptions().timeZone` always
 * answers a canonical IANA name and never an offset. Said here because this is
 * the admin's first caller of that module and the obligation is invisible from
 * the call site.
 */
export const BROWSER_TIME_ZONE = new InjectionToken<string>('BROWSER_TIME_ZONE', {
  providedIn: 'root',
  factory: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
});
