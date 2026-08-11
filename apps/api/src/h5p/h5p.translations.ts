import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Logger } from '@nestjs/common';
import type { ITranslationFunction } from '@lumieducation/h5p-server';
import { UK_CLIENT_STRINGS } from './h5p.translations.uk.js';

/** One locale's strings, flattened onto the dotted keys i18next asks for. */
export type FlatStrings = Readonly<Record<string, string>>;

/** namespace → language → flat keys. Languages are keyed lower-cased. */
export type TranslationDictionaries = ReadonlyMap<string, ReadonlyMap<string, FlatStrings>>;

/**
 * The namespaces the two constructors' default `SimpleTranslator`s carry.
 *
 * `H5PPlayer` has only `client`; `H5PEditor` has all three. Loading fewer would
 * make the callback we pass the editor *worse* than the default it replaces —
 * `metadata-semantics` and `copyright-semantics` would stop resolving at all.
 */
export const H5P_TRANSLATION_NAMESPACES = [
  'client',
  'metadata-semantics',
  'copyright-semantics',
] as const;

/**
 * The last candidate in every lookup, and the language `H5PPlayer.render` is
 * told when the request asks for none (`h5p-serve.service.ts`).
 */
const FALLBACK_LANGUAGE = 'en';

const logger = new Logger('H5pTranslations');

/**
 * Dotted keys, string leaves only.
 *
 * Upstream flattens with the `flat` package; five lines here rather than a
 * dependency for it. A non-string, non-object leaf — a number or a `null` in a
 * file someone hand-edited — is skipped rather than coerced, so the lookup can
 * treat "present" as "usable".
 */
export function flattenStrings(value: unknown, prefix = ''): Record<string, string> {
  const flat: Record<string, string> = {};

  if (typeof value !== 'object' || value === null) {
    return flat;
  }

  for (const [key, leaf] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;

    if (typeof leaf === 'string') {
      flat[path] = leaf;
    } else if (typeof leaf === 'object' && leaf !== null) {
      Object.assign(flat, flattenStrings(leaf, path));
    }
  }

  return flat;
}

/** Our own strings, which win over upstream's file for the same locale. */
export const UK_OVERLAY: TranslationDictionaries = new Map([
  ['client', new Map([['uk', UK_CLIENT_STRINGS]])],
]);

/**
 * Every locale `@lumieducation/h5p-server` ships, read once at boot.
 *
 * **Read at boot from a directory listing, never per request from a path built
 * out of `?lang`.** The requested language is a public query string; joining it
 * onto a directory to `readFile` a locale would be a traversal waiting to
 * happen. Loading the listing once and looking the request up in a `Map` means
 * the request's own string never reaches the filesystem.
 *
 * **Never throws.** A namespace directory that cannot be read, or a file that
 * will not parse, is warned about and skipped, because the API has to boot.
 * What that degrades to is *not* English: `en` is an entry in this same map
 * rather than a floor beneath it, so a load that produced nothing renders every
 * label as its literal i18next key — `client:fullscreen`, in every language
 * except Ukrainian, which is compiled in. `h5p.translations.spec.ts` is the
 * alarm instead: it reads the real installed package, so the commit that moves
 * these files fails a test rather than shipping a player labelled `client:*`.
 *
 * A last-resort English map compiled in here would make the degradation real,
 * and is deliberately absent: it would be a second copy of upstream's 169
 * strings, drifting from the first and needing its own parity test, to defend a
 * state that today cannot arise on its own — `H5PPlayer.js` statically
 * `require`s the very same `assets/translations/client/en.json`, so a tree that
 * is missing or corrupt fails the package's own import long before this runs.
 * The one branch that can fire alone is `upstreamTranslationsRoot` returning
 * `null`.
 */
export async function loadUpstreamTranslations(): Promise<TranslationDictionaries> {
  const root = upstreamTranslationsRoot();
  const dictionaries = new Map<string, ReadonlyMap<string, FlatStrings>>();

  if (root === null) {
    return dictionaries;
  }

  for (const namespace of H5P_TRANSLATION_NAMESPACES) {
    dictionaries.set(namespace, await loadNamespace(join(root, namespace)));
  }

  return dictionaries;
}

/**
 * A synchronous lookup over what is already in memory.
 *
 * For `ns:key` in language `L` it walks `L` lower-cased, then `L`'s primary
 * subtag (`uk-UA` → `uk`), then English, and inside each of those tries our
 * overlay before upstream's file. The first non-empty string wins, so:
 *
 * - a locale nobody ships gets English, whole;
 * - a **partially** translated locale gets English per missing key, never a
 *   blank label and never the literal `client:fullscreen`;
 * - an empty string counts as missing, so a half-filled entry falls back rather
 *   than rendering nothing;
 * - our overlay beats upstream's file for the same locale, so the day upstream
 *   ships `uk.json` nothing silently changes underneath us.
 *
 * Only if every candidate misses does it return the key unchanged, which is
 * `SimpleTranslator`'s own answer. That is reachable only if upstream's
 * `defaultClientStrings.json` and its `en.json` disagree, which a unit test
 * pins against.
 */
export function buildTranslationFunction(
  dictionaries: TranslationDictionaries,
  overlays: TranslationDictionaries,
): ITranslationFunction {
  const sources = [overlays, dictionaries];

  return (key: string, language: string): string => {
    // Split at the **first** colon, not with upstream's greedy `/^(.+):(.+)$/`.
    // Every key has exactly one, so the two agree today; the first-colon split
    // is the one that stays right if a key ever gains another.
    const separator = key.indexOf(':');
    if (separator <= 0 || separator === key.length - 1) {
      // No namespace, so nothing to look up — `SimpleTranslator` does the same.
      return key;
    }

    const namespace = key.slice(0, separator);
    const entry = key.slice(separator + 1);

    for (const candidate of languageCandidates(language)) {
      for (const source of sources) {
        const value = source.get(namespace)?.get(candidate)?.[entry];
        if (typeof value === 'string' && value !== '') {
          return value;
        }
      }
    }

    // An unknown namespace lands here too, where `SimpleTranslator` raises a
    // `TypeError` instead. A label that reads `client:fullscreen` is bad; a
    // player model that 500s because a namespace was misspelled is worse.
    return key;
  };
}

/**
 * The languages to try, in order, deduped so English is never tried twice.
 *
 * Only the lower-cased form is tried rather than the requested spelling as
 * well, because the dictionaries are keyed lower-cased at load — the two
 * lookups would be the same one.
 */
function languageCandidates(language: string): string[] {
  // `?? ''` guards a parameter whose type says it cannot be missing. Every
  // caller of an `ITranslationFunction` is upstream's own untyped JavaScript,
  // which hands on whatever it was given; without this, a `render` call that
  // omitted the language would throw inside the player model instead of
  // answering English.
  const lower = (language ?? '').toLowerCase();
  // BCP 47 uses `-`; upstream's own filenames also use `_` (`pt_BR`).
  const primary = lower.split(/[-_]/)[0] ?? '';

  return [...new Set([lower, primary, FALLBACK_LANGUAGE].filter((candidate) => candidate !== ''))];
}

/**
 * Where the installed `@lumieducation/h5p-server` keeps its translations, or
 * `null` if it cannot be resolved at all.
 *
 * They ship inside the package (`files: ["build/"]`), unlike the browser-side
 * core and editor, which `scripts/fetch-h5p-core.ts` downloads — so there is
 * nothing to fetch, pin or copy in the Dockerfile for these.
 */
function upstreamTranslationsRoot(): string | null {
  try {
    const manifest = createRequire(import.meta.url).resolve(
      '@lumieducation/h5p-server/package.json',
    );
    return join(dirname(manifest), 'build', 'assets', 'translations');
  } catch (error: unknown) {
    // Say what an operator will actually see. A line promising English while
    // the player renders `client:fullscreen` costs more time in an incident
    // than no line at all.
    logger.warn(
      `The H5P server package could not be resolved, so no translations were loaded; every player label will render as its raw i18next key ("client:fullscreen") in every language except Ukrainian, which is compiled in. ${String(error)}`,
    );
    return null;
  }
}

/** One namespace directory, keyed by the lower-cased file basename. */
async function loadNamespace(directory: string): Promise<ReadonlyMap<string, FlatStrings>> {
  const languages = new Map<string, FlatStrings>();

  let files: string[];
  try {
    files = await readdir(directory);
  } catch (error: unknown) {
    logger.warn(`H5P translations could not be listed in "${directory}": ${String(error)}`);
    return languages;
  }

  // Sorted so that if two filenames ever normalize onto the same key, which one
  // wins is a property of their names rather than of the filesystem's order.
  // No pair does today: `es-mx.json` and `es_MX.json` differ by their
  // separator, which lower-casing leaves alone. `zh-cn.json` exists with no
  // `zh.json`, so `?lang=zh` gets English — named, not fixed.
  for (const file of [...files].sort()) {
    // Upstream ships a `.en.json` in namespaces we do not load; a leading dot
    // would key it under `.en`, which nothing could ever ask for.
    if (!file.endsWith('.json') || file.startsWith('.')) {
      continue;
    }

    const language = file.slice(0, -'.json'.length).toLowerCase();
    if (languages.has(language)) {
      continue;
    }

    const path = join(directory, file);
    try {
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
      languages.set(language, flattenStrings(parsed));
    } catch (error: unknown) {
      logger.warn(`H5P translations in "${path}" could not be read: ${String(error)}`);
    }
  }

  return languages;
}
