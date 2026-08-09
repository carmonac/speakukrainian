import { STORAGE_PREFIXES } from './collections.js';

/**
 * Upload rules for the media endpoints.
 *
 * The admin checks a file against these before it opens a request and the API
 * checks the multipart part against the same values, so the client-side
 * message and the server's 415/413 cannot describe different rules. The
 * user-facing wording lives here for the same reason.
 *
 * A declared type is only accepted if the file's leading bytes agree with it
 * (`media-signatures.ts`), so every type on these lists needs a header
 * signature. `image/svg+xml` is therefore off them: an SVG is plain text with
 * no signature, and it can also carry script, which runs with the origin that
 * served it — harmless while media is served from the bucket, a hole the day it
 * is served from ours. Re-adding it means sanitizing the SVG on upload, not
 * exempting it from the byte check. See ADR-016.
 */
export const IMAGE_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

export const AUDIO_CONTENT_TYPES = [
  'audio/mpeg',
  'audio/mp4',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
] as const;

export type ImageContentType = (typeof IMAGE_CONTENT_TYPES)[number];
export type AudioContentType = (typeof AUDIO_CONTENT_TYPES)[number];
export type MediaContentType = ImageContentType | AudioContentType;

export const MAX_IMAGE_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_AUDIO_UPLOAD_BYTES = 50 * 1024 * 1024;

export const MEDIA_KINDS = ['image', 'audio'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

/**
 * The stored object's extension is derived from the content type, never from
 * the uploaded filename: a caller cannot choose the name an object lands under.
 */
export const FILE_EXTENSION_BY_CONTENT_TYPE: Record<MediaContentType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/webm': 'weba',
};

export interface MediaUploadRule {
  contentTypes: readonly MediaContentType[];
  maxBytes: number;
  /** Cloud Storage prefix from `STORAGE_PREFIXES`. */
  prefix: string;
}

export const MEDIA_UPLOAD_RULES = {
  image: {
    contentTypes: IMAGE_CONTENT_TYPES,
    maxBytes: MAX_IMAGE_UPLOAD_BYTES,
    prefix: STORAGE_PREFIXES.images,
  },
  audio: {
    contentTypes: AUDIO_CONTENT_TYPES,
    maxBytes: MAX_AUDIO_UPLOAD_BYTES,
    prefix: STORAGE_PREFIXES.audio,
  },
} as const satisfies Record<MediaKind, MediaUploadRule>;

/** Plural noun used to open a message, e.g. "Audio files must be under 50 MB." */
const KIND_NOUN: Record<MediaKind, string> = {
  image: 'Images',
  audio: 'Audio files',
};

/** Matching is exact and case-sensitive: browsers send lowercase content types. */
export function isAllowedContentType(kind: MediaKind, value: string): value is MediaContentType {
  const allowed: readonly string[] = MEDIA_UPLOAD_RULES[kind].contentTypes;
  return allowed.includes(value);
}

/** `accept` attribute value for a file input, e.g. `image/png,image/jpeg,…`. */
export function mediaAcceptAttribute(kind: MediaKind): string {
  return MEDIA_UPLOAD_RULES[kind].contentTypes.join(',');
}

/** "10 MB" / "50 MB". Both limits are whole megabytes. */
export function formatMaxUploadSize(kind: MediaKind): string {
  return `${MEDIA_UPLOAD_RULES[kind].maxBytes / (1024 * 1024)} MB`;
}

export function uploadTooLargeMessage(kind: MediaKind): string {
  return `${KIND_NOUN[kind]} must be under ${formatMaxUploadSize(kind)}.`;
}

export function unsupportedContentTypeMessage(kind: MediaKind, received: string): string {
  const allowed = MEDIA_UPLOAD_RULES[kind].contentTypes.join(', ');
  return `${received} is not a supported ${kind} format. Allowed: ${allowed}.`;
}

/**
 * One message for both directions of a byte/declaration mismatch. It names the
 * declared type rather than the detected container: the author can see the
 * former, and the action — re-export it — is the same either way.
 */
export function contentDoesNotMatchMessage(kind: MediaKind, declared: string): string {
  return `This file is not a valid ${declared}. Renaming a file does not change its contents; re-export it as a supported ${kind} format.`;
}
