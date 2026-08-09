import type { MediaContentType } from './media.js';

/**
 * Leading bytes the detector needs to decide every rule below. The deepest one
 * reads offsets 8–11 (`RIFF….WEBP` / `RIFF….WAVE`), so a caller holding only a
 * prefix of the file — the admin reads a slice rather than the whole upload —
 * must read at least this many for the answer to match the API's.
 */
export const MEDIA_SIGNATURE_BYTES = 16;

/**
 * What the bytes prove, which is the *container*, not the content type. Several
 * of the allowed types are containers that also carry video, and a header
 * cannot tell an audio-only MP4 from one with a video track.
 */
export type MediaContainer =
  'png' | 'jpeg' | 'gif' | 'webp' | 'wav' | 'ogg' | 'iso-bmff' | 'ebml' | 'mp3';

/**
 * The declared types each container can legitimately be.
 *
 * Every entry is a singleton today only because no video type is on either
 * allow-list: `iso-bmff` covers `.mp4` and `.m4a` alike and `ebml` covers both
 * WebM flavours, so `audio/mp4` and `audio/webm` are simply the only things we
 * accept that those containers could be. Expressed as a set so that adding
 * `video/mp4` later is one more element rather than a redesign.
 */
export const CONTENT_TYPES_BY_CONTAINER: Record<MediaContainer, readonly MediaContentType[]> = {
  png: ['image/png'],
  jpeg: ['image/jpeg'],
  gif: ['image/gif'],
  webp: ['image/webp'],
  wav: ['audio/wav'],
  ogg: ['audio/ogg'],
  'iso-bmff': ['audio/mp4'],
  ebml: ['audio/webm'],
  mp3: ['audio/mpeg'],
};

function hasBytesAt(bytes: Uint8Array, offset: number, length: number): boolean {
  return bytes.length >= offset + length;
}

/** Compares a magic as byte values, so a short or non-UTF-8 buffer cannot throw. */
function matchesAscii(bytes: Uint8Array, offset: number, magic: string): boolean {
  if (!hasBytesAt(bytes, offset, magic.length)) {
    return false;
  }
  for (let index = 0; index < magic.length; index += 1) {
    if (bytes[offset + index] !== magic.charCodeAt(index)) {
      return false;
    }
  }
  return true;
}

function matchesBytes(bytes: Uint8Array, offset: number, magic: readonly number[]): boolean {
  if (!hasBytesAt(bytes, offset, magic.length)) {
    return false;
  }
  return magic.every((value, index) => bytes[offset + index] === value);
}

/**
 * The container these bytes start with, or `null` for anything else — including
 * an empty, truncated or absent buffer. Absent matters: `file.buffer` is only
 * populated under multer's memory storage, and a route wired another way must
 * fail closed rather than pass unverified bytes through.
 */
export function detectMediaContainer(bytes: Uint8Array): MediaContainer | null {
  if (!bytes || bytes.length === 0) {
    return null;
  }

  if (matchesBytes(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'png';
  }
  // SOI marker plus the first byte of the marker that always follows it.
  if (matchesBytes(bytes, 0, [0xff, 0xd8, 0xff])) {
    return 'jpeg';
  }
  if (matchesAscii(bytes, 0, 'GIF87a') || matchesAscii(bytes, 0, 'GIF89a')) {
    return 'gif';
  }
  // Both are RIFF containers; the form type at offset 8 is what separates them,
  // so stopping at `RIFF` would let a WebP pass as a WAV and the reverse.
  if (matchesAscii(bytes, 0, 'RIFF')) {
    if (matchesAscii(bytes, 8, 'WEBP')) {
      return 'webp';
    }
    if (matchesAscii(bytes, 8, 'WAVE')) {
      return 'wav';
    }
    return null;
  }
  if (matchesAscii(bytes, 0, 'OggS')) {
    return 'ogg';
  }
  // ISO base media: the `ftyp` box type follows its 4-byte size field.
  if (matchesAscii(bytes, 4, 'ftyp')) {
    return 'iso-bmff';
  }
  // EBML header, the outer container of every Matroska/WebM file.
  if (matchesBytes(bytes, 0, [0x1a, 0x45, 0xdf, 0xa3])) {
    return 'ebml';
  }
  // MP3 needs two rules: most encoders write an ID3v2 tag ahead of the audio,
  // and a tagless file starts directly at a frame sync.
  if (matchesAscii(bytes, 0, 'ID3')) {
    return 'mp3';
  }
  // Deliberately last. Eleven set bits is the loosest rule in the table, and
  // ahead of the others it would claim headers that have a real magic — a JPEG
  // opens `FF D8`, and only `(0xd8 & 0xe0) === 0xc0` keeps it out of here.
  if (hasBytesAt(bytes, 0, 2) && bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0) {
    return 'mp3';
  }

  return null;
}

/**
 * Whether these bytes could be the declared type. The one function the admin's
 * pre-check and the API's upload both call, so the two cannot drift.
 */
export function contentMatchesBytes(declared: MediaContentType, bytes: Uint8Array): boolean {
  const container = detectMediaContainer(bytes);
  if (container === null) {
    return false;
  }
  return CONTENT_TYPES_BY_CONTAINER[container].includes(declared);
}
