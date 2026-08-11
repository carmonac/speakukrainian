import { InjectionToken } from '@angular/core';

/**
 * The IANA zone names this runtime will offer in a picker.
 *
 * A token for the same two reasons `BROWSER_TIME_ZONE` is one: the factory runs
 * in an injection context and never at module scope, and every spec overrides
 * it. **The override is not optional here.** The list is runtime-dependent in a
 * way a spec cannot see: on this project's Node it holds 418 entries including
 * `Europe/Kiev`, `Asia/Calcutta` and `America/New_York`, and **not**
 * `Europe/Kyiv`, `Asia/Kolkata`, `US/Eastern`, `UTC` or any `Etc/*`; Chromium
 * answers differently. A spec asserting against the real token asserts ICU's
 * version rather than this code.
 *
 * That same gap is why nothing may build a `<mat-select>` straight from this
 * list. It is **canonical names only**, while `timeZoneSchema` deliberately
 * accepts every backward-compatibility link `Intl` resolves and stores the
 * spelling the admin used (ADR-014). A slot stored `Europe/Kyiv` — this
 * product's own zone — would therefore open on a select with no matching
 * option, render blank, and be re-zoned by the next save. `timeZoneOptions` in
 * `schedule-form.model.ts` is what closes that, and this list is its input.
 */
export const SUPPORTED_TIME_ZONES = new InjectionToken<readonly string[]>('SUPPORTED_TIME_ZONES', {
  providedIn: 'root',
  factory: () => Intl.supportedValuesOf('timeZone'),
});
