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
export const H5P_WORKING_DIRS = Symbol('H5P_WORKING_DIRS');

/**
 * Absolute paths of the local scratch directories, resolved once from
 * `H5P_TEMP_DIR` so multer and the temporary file storage cannot disagree
 * about where they are.
 */
export interface H5pWorkingDirs {
  root: string;
  /** Multer's destination for the incoming `.h5p`; emptied per request. */
  uploads: string;
  /** Root of the editor's temporary file storage. */
  editorTemp: string;
}
