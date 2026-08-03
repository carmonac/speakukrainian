/**
 * Injection tokens live apart from the modules that provide them.
 *
 * A module imports its own services, and those services need the token — under
 * ESM that pair of imports forms a real cycle and the token is still in its
 * temporal dead zone when the decorator runs, which crashes at boot rather
 * than at build time. A leaf module with no imports of its own breaks it.
 */
export const CLOUD_STORAGE = Symbol('CLOUD_STORAGE');
