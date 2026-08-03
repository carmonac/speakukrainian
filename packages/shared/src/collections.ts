/**
 * Firestore collection names. Always reference these constants instead of
 * hard-coding strings, so a rename is a single-line change.
 */
export const COLLECTIONS = {
  locales: 'locales',
  sections: 'sections',
  pages: 'pages',
  scheduleSlots: 'scheduleSlots',
  users: 'users',
  h5pContent: 'h5pContent',
  assets: 'assets',
} as const;

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];

/** Cloud Storage object prefixes. */
export const STORAGE_PREFIXES = {
  images: 'images',
  audio: 'audio',
  h5pContent: 'h5p/content',
  h5pLibraries: 'h5p/libraries',
  h5pTemp: 'h5p/temp',
} as const;
