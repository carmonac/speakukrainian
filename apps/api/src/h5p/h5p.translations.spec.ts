import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  H5P_TRANSLATION_NAMESPACES,
  UK_OVERLAY,
  buildTranslationFunction,
  flattenStrings,
  loadUpstreamTranslations,
  type FlatStrings,
  type TranslationDictionaries,
} from './h5p.translations.js';
import { UK_CLIENT_STRINGS } from './h5p.translations.uk.js';

/**
 * These tests read the **real** installed `@lumieducation/h5p-server`, the way
 * `h5p.package-scan.spec.ts` does, because that is the only thing they are
 * worth asserting against: the loader warns and skips rather than throwing when
 * the package's layout changes, and what it degrades to is every label rendered
 * as its literal i18next key, not English. So without a test reading the same
 * files, that change is silent until a learner sees `client:fullscreen`.
 */
const upstreamAsset = async (...segments: string[]): Promise<Record<string, string>> => {
  const manifest = createRequire(import.meta.url).resolve('@lumieducation/h5p-server/package.json');
  const path = join(dirname(manifest), 'build', 'assets', ...segments);
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
  return flattenStrings(parsed);
};

describe('flattenStrings', () => {
  it('gives a nested object dotted keys and drops what is not a string', () => {
    expect(flattenStrings({ a: 'one', b: { c: 'two', d: { e: 'three' } } })).toEqual({
      a: 'one',
      'b.c': 'two',
      'b.d.e': 'three',
    });
    expect(flattenStrings({ a: 'one', b: 2, c: null, d: ['x'] })).toEqual({ a: 'one', 'd.0': 'x' });
  });
});

describe('loadUpstreamTranslations', () => {
  let dictionaries: TranslationDictionaries;

  beforeAll(async () => {
    dictionaries = await loadUpstreamTranslations();
  });

  it("loads upstream's own client translations", () => {
    const client = dictionaries.get('client');

    // 29 locales at the pinned version. Asserted as a floor rather than an
    // equality so that upstream adding one is not a failure; the point is that
    // the directory was found and read at all.
    expect(client?.size).toBeGreaterThanOrEqual(29);
    expect(client?.get('en')?.['fullscreen']).toBe('Fullscreen');
    expect(client?.get('es')?.['fullscreen']).toBe('PantallaCompleta');
  });

  it('loads all three namespaces the two constructors localize', () => {
    // Fewer than three would make the callback handed to `H5PEditor` worse than
    // the English-only default it replaces, which carries all three.
    expect([...dictionaries.keys()]).toEqual([...H5P_TRANSLATION_NAMESPACES]);
    for (const namespace of H5P_TRANSLATION_NAMESPACES) {
      expect(dictionaries.get(namespace)?.size).toBeGreaterThan(0);
    }
  });

  it('has no Ukrainian of its own, which is why we write it', () => {
    // The premise of the whole file. If upstream ever ships `uk.json`, this
    // fails and the question of whether to keep our overlay becomes live.
    expect(dictionaries.get('client')?.has('uk')).toBe(false);
  });
});

describe('the Ukrainian client strings', () => {
  it('cover exactly the keys upstream asks for', async () => {
    const english = await upstreamAsset('translations', 'client', 'en.json');

    expect(Object.keys(UK_CLIENT_STRINGS).sort()).toEqual(Object.keys(english).sort());
  });

  it('cover every key the player actually renders', async () => {
    // `H5PPlayer` builds `integration.l10n.H5P` by localizing every value of
    // `defaultClientStrings.json`, each of which is a `client:` key. Upstream's
    // `en.json` and that file agree today; if they ever stop, this says which
    // keys the chrome would render as literal `client:...` strings.
    const asked = Object.values(await upstreamAsset('defaultClientStrings.json'));

    expect(asked.length).toBeGreaterThan(0);
    const missing = asked
      .filter((key) => key.startsWith('client:'))
      .map((key) => key.slice('client:'.length))
      .filter((key) => !(key in UK_CLIENT_STRINGS));
    expect(missing).toEqual([]);
  });

  it('are all real strings', () => {
    // A half-filled overlay would otherwise be invisible: the per-key fallback
    // would quietly serve English for whatever was left blank.
    const suspect = Object.entries(UK_CLIENT_STRINGS).filter(
      ([key, value]) => value.trim() === '' || value === key,
    );

    expect(suspect).toEqual([]);
  });

  it('keep the placeholders and markup their English carries', async () => {
    // The player substitutes `:num`, `:title` and friends into these at render
    // time; a translation that dropped one would render the token's absence
    // rather than a value. Compared against upstream's English so the list of
    // tokens is not a copy of itself.
    const english = await upstreamAsset('translations', 'client', 'en.json');
    const tokens = (value: string): string[] => (value.match(/:[a-zA-Z]+/g) ?? []).sort();

    const dropped = Object.entries(english)
      .filter(([key, value]) => {
        const ours = UK_CLIENT_STRINGS[key];
        return ours !== undefined && tokens(ours).join() !== tokens(value).join();
      })
      .map(([key]) => key);

    expect(dropped).toEqual([]);
  });
});

describe('buildTranslationFunction', () => {
  let translate: ReturnType<typeof buildTranslationFunction>;

  beforeAll(async () => {
    translate = buildTranslationFunction(await loadUpstreamTranslations(), UK_OVERLAY);
  });

  it('prefers our Ukrainian over the English default', () => {
    expect(translate('client:fullscreen', 'uk')).toBe(UK_CLIENT_STRINGS['fullscreen']);
    expect(translate('client:fullscreen', 'uk')).not.toBe('Fullscreen');
  });

  it("answers a region subtag with the base language's strings", () => {
    // What an SSR locale of `uk-UA` will ask for once the public exercise page
    // exists.
    expect(translate('client:fullscreen', 'uk-UA')).toBe(translate('client:fullscreen', 'uk'));
    expect(translate('client:close', 'es-ES')).toBe('Cerrar');
  });

  it("answers a locale upstream ships with upstream's own strings", () => {
    expect(translate('client:fullscreen', 'es')).toBe('PantallaCompleta');
  });

  it('falls back to English for a locale nobody has', () => {
    expect(translate('client:fullscreen', 'zz')).toBe('Fullscreen');
    // Upstream has `zh-cn` and no `zh`, so the primary subtag misses here.
    expect(translate('client:fullscreen', 'zh')).toBe('Fullscreen');
  });

  it('never answers undefined, and never throws on a key it does not know', () => {
    expect(translate('client:nosuchkey', 'uk')).toBe('client:nosuchkey');
    // `SimpleTranslator`, which this replaces, raises a `TypeError` here.
    expect(() => translate('nosuchnamespace:key', 'uk')).not.toThrow();
    expect(translate('nosuchnamespace:key', 'uk')).toBe('nosuchnamespace:key');
    expect(translate('nocolon', 'uk')).toBe('nocolon');
    expect(translate(':leadingcolon', 'uk')).toBe(':leadingcolon');
    // A namespace with nothing after it: the `separator === key.length - 1`
    // guard, which without this would be an untested branch.
    expect(translate('client:', 'uk')).toBe('client:');
  });

  it('does not read a file path out of the requested language', () => {
    // The language arrives from a public query string. If someone ever
    // "optimises" the loader into a lazy `readFile(join(dir, lang + '.json'))`,
    // this is what says no.
    expect(translate('client:fullscreen', '../../en')).toBe('Fullscreen');
    expect(translate('client:fullscreen', '../client/es')).toBe('Fullscreen');
  });
});

describe('buildTranslationFunction over a partial locale', () => {
  const stub = (strings: FlatStrings): TranslationDictionaries =>
    new Map([['client', new Map([['uk', strings]])]]);

  const english: TranslationDictionaries = new Map([
    ['client', new Map([['en', { fullscreen: 'Fullscreen', close: 'Close', size: 'Size' }]])],
  ]);

  it('falls back per key rather than per file', () => {
    // The half of the fallback rule no e2e can reach while the real overlay is
    // complete: one missing key must not cost the locale its other labels.
    const translate = buildTranslationFunction(english, stub({ close: 'Закрити' }));

    expect(translate('client:close', 'uk')).toBe('Закрити');
    expect(translate('client:fullscreen', 'uk')).toBe('Fullscreen');
  });

  it('treats an empty value as missing rather than rendering a blank label', () => {
    const translate = buildTranslationFunction(english, stub({ size: '' }));

    expect(translate('client:size', 'uk')).toBe('Size');
  });

  it('resolves nothing for a namespace with an empty key after it', () => {
    // `client:` is a namespace and no key. Over the real dictionaries the
    // outcome is the same either way, so the guard for it is only observable
    // against a dictionary that stores something under the empty key — drop
    // `separator === key.length - 1` and this answers `'заглушка'`.
    const translate = buildTranslationFunction(english, stub({ '': 'заглушка' }));

    expect(translate('client:', 'uk')).toBe('client:');
  });

  it('prefers the overlay over an upstream file for the same locale', () => {
    // The day upstream ships `uk.json`, nothing changes underneath us.
    const upstream: TranslationDictionaries = new Map([
      ['client', new Map([['uk', { fullscreen: "upstream's Ukrainian" }]])],
    ]);

    expect(
      buildTranslationFunction(upstream, stub({ fullscreen: 'наше' }))('client:fullscreen', 'uk'),
    ).toBe('наше');
  });
});
