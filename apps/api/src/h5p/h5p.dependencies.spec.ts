import { describe, expect, it } from 'vitest';
import { hasDependencyOn, type DependencyLists } from './h5p.dependencies.js';

const LIBRARY = { machineName: 'H5P.MultiChoice', majorVersion: 1, minorVersion: 16 };

describe('hasDependencyOn', () => {
  it.each([['preloadedDependencies'], ['editorDependencies'], ['dynamicDependencies']] as const)(
    'finds the library in %s',
    (list) => {
      expect(hasDependencyOn({ [list]: [LIBRARY] } as DependencyLists, LIBRARY)).toBe(true);
    },
  );

  it('is false when no list mentions the library', () => {
    expect(
      hasDependencyOn(
        {
          preloadedDependencies: [{ machineName: 'H5P.Blanks', majorVersion: 1, minorVersion: 0 }],
        },
        LIBRARY,
      ),
    ).toBe(false);
  });

  it('is false for metadata with no dependency lists at all', () => {
    expect(hasDependencyOn({}, LIBRARY)).toBe(false);
  });

  it('compares major and minor version, not only the machine name', () => {
    expect(
      hasDependencyOn({ preloadedDependencies: [{ ...LIBRARY, minorVersion: 15 }] }, LIBRARY),
    ).toBe(false);
    expect(
      hasDependencyOn({ preloadedDependencies: [{ ...LIBRARY, majorVersion: 2 }] }, LIBRARY),
    ).toBe(false);
  });
});
