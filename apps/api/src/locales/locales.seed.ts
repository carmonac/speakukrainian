import { DEFAULT_LOCALE, SEED_LOCALES, type CreateLocaleInput } from '@speakukrainian/shared';

/**
 * Keyed by `SEED_LOCALES` so adding a code there is a compile error until its
 * metadata is filled in — the list cannot drift from the definitions.
 *
 * `CreateLocaleInput` is the schema's output type, so the fields with Zod
 * defaults are required here. That is intentional: seed data states its values.
 */
export const SEED_LOCALE_DEFINITIONS: Record<(typeof SEED_LOCALES)[number], CreateLocaleInput> = {
  en: {
    code: 'en',
    name: 'English',
    nativeName: 'English',
    direction: 'ltr',
    enabled: true,
    sortOrder: 0,
  },
  es: {
    code: 'es',
    name: 'Spanish',
    nativeName: 'Español',
    direction: 'ltr',
    enabled: true,
    sortOrder: 1,
  },
  uk: {
    code: 'uk',
    name: 'Ukrainian',
    nativeName: 'Українська',
    direction: 'ltr',
    enabled: true,
    sortOrder: 2,
  },
};

/** Seeded documents are written by the system, not by a signed-in admin. */
export const SEED_ACTOR = 'system';

export const isSeedDefault = (code: string): boolean => code === DEFAULT_LOCALE;
