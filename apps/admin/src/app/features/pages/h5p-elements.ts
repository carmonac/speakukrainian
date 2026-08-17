import { InjectionToken } from '@angular/core';
import { defineElements } from '@lumieducation/h5p-webcomponents';

/**
 * Registers `<h5p-editor>` as a custom element. This file is the **only** import
 * of `@lumieducation/h5p-webcomponents` in the admin, and the only place its
 * GPL-3.0 code enters the bundle (ADR-019).
 *
 * It is a token rather than a bare call so that a spec can leave `h5p-editor`
 * **undefined**, which is what makes that screen testable at all. A defined
 * element upgrades the moment it is appended, and `connectedCallback`
 * constructs a `ResizeObserver` — which jsdom does not implement — and then
 * awaits `onload` on every script URL the editor model lists, which jsdom never
 * fetches. A spec that upgraded the element would therefore *hang* rather than
 * fail. Left undefined, `<h5p-editor>` is an ordinary `HTMLElement` that takes
 * attributes, expando properties and real event listeners: exactly the surface
 * that screen drives.
 *
 * Nothing asserts that the token was called, the production factory is the real
 * registration, and `defineElements` guards on `customElements.get`
 * (`index.js:5-16`), so calling it once per mounted screen is idempotent.
 */
export const H5P_DEFINE_EDITOR_ELEMENT = new InjectionToken<() => void>('H5P editor element', {
  providedIn: 'root',
  factory: () => () => {
    defineElements(['h5p-editor']);
  },
});

/**
 * Registers `<h5p-player>`, for the exercise preview, on the same terms.
 *
 * **A second token rather than one call registering both tags.** A spec must be
 * able to leave one tag undefined without leaving the other one undefined too:
 * `H5PPlayerComponent.connectedCallback` constructs a `ResizeObserver`
 * (`h5p-player.js:178`) and its render awaits `onload` on scripts jsdom never
 * fetches, so an upgraded `<h5p-player>` reached by a page-form spec hangs the
 * run instead of failing it. One token registering both would make every spec
 * that mounts either surface pay for the other.
 */
export const H5P_DEFINE_PLAYER_ELEMENT = new InjectionToken<() => void>('H5P player element', {
  providedIn: 'root',
  factory: () => () => {
    defineElements(['h5p-player']);
  },
});
