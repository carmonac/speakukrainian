/**
 * Injection tokens for the H5P module.
 *
 * Their own file, per ADR-008: under ESM, a token declared in the module that
 * provides it sits in its temporal dead zone by the time a service imports it,
 * and the app crashes at boot with `Cannot access 'X' before initialization`.
 */
export const H5P_AJAX_ENDPOINT = Symbol('H5P_AJAX_ENDPOINT');
export const H5P_CONFIG = Symbol('H5P_CONFIG');
export const H5P_EDITOR = Symbol('H5P_EDITOR');
export const H5P_PLAYER = Symbol('H5P_PLAYER');
export const H5P_TEMPORARY_STORAGE = Symbol('H5P_TEMPORARY_STORAGE');
export const H5P_TRANSLATE = Symbol('H5P_TRANSLATE');
export const H5P_WORKING_DIRS = Symbol('H5P_WORKING_DIRS');

/**
 * Absolute paths of the local scratch directories, resolved once from
 * `H5P_TEMP_DIR`.
 *
 * Only multer writes here, and only for the length of one request. The
 * editor's temporary files are **not** local: they live in the bucket under
 * `h5p/temp/<ownerId>/`, because a file written by one Cloud Run instance has
 * to be readable by the next.
 */
export interface H5pWorkingDirs {
  root: string;
  /** Multer's destination for an incoming upload; emptied per request. */
  uploads: string;
}
