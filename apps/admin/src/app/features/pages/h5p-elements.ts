import { InjectionToken } from '@angular/core';
import { defineElements } from '@lumieducation/h5p-webcomponents';

/**
 * Registers `<h5p-editor>` as a custom element. The **only** import of
 * `@lumieducation/h5p-webcomponents` in the admin, and the only place its
 * GPL-3.0 code enters the bundle (ADR-019).
 *
 * It is a token rather than a bare call so that a spec can leave the element
 * **undefined**, which is what makes this screen testable at all. A defined
 * element upgrades the moment it is appended, and `connectedCallback`
 * constructs a `ResizeObserver` — which jsdom does not implement — and then
 * awaits `onload` on every script URL the editor model lists, which jsdom never
 * fetches. A spec that upgraded the element would therefore *hang* rather than
 * fail. Left undefined, `<h5p-editor>` is an ordinary `HTMLElement` that takes
 * attributes, expando properties and real event listeners: exactly the surface
 * this screen drives.
 *
 * Nothing asserts that the token was called, the production factory is the real
 * registration, and `defineElements` guards on `customElements.get`, so calling
 * it once per mounted screen is idempotent.
 */
export const H5P_DEFINE_ELEMENTS = new InjectionToken<() => void>('H5P custom elements', {
  providedIn: 'root',
  factory: () => () => {
    defineElements(['h5p-editor']);
  },
});
