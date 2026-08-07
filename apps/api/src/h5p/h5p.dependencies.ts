import { LibraryName } from '@lumieducation/h5p-server';
import type { ILibraryName } from '@lumieducation/h5p-server';

/**
 * All three lists are optional here even though `IContentMetadata` requires
 * `preloadedDependencies`: the same check reads library metadata, where it is
 * optional, and a package with none is malformed rather than a crash.
 */
export interface DependencyLists {
  preloadedDependencies?: ILibraryName[];
  editorDependencies?: ILibraryName[];
  dynamicDependencies?: ILibraryName[];
}

/**
 * Whether any of the metadata's three dependency lists names `library`.
 *
 * The library ships this as `helpers/DependencyChecker`, but it is not
 * re-exported from the package root and the package has no `exports` map, so
 * using it would mean a deep import into `build/src/helpers/…` that a patch
 * release is free to move. Six lines is cheaper than that coupling.
 */
export function hasDependencyOn(metadata: DependencyLists, library: ILibraryName): boolean {
  const lists = [
    metadata.preloadedDependencies,
    metadata.editorDependencies,
    metadata.dynamicDependencies,
  ];

  return lists.some((list) => list?.some((dependency) => LibraryName.equal(dependency, library)));
}
