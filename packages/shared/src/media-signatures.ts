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
  if (isId3v2Header(bytes)) {
    return 'mp3';
  }
  // Deliberately last. It is the only rule without a literal magic, so ahead of
  // the others it could claim a header that one of them owns — an ISO-BMFF box
  // size is four arbitrary bytes and may well begin `FF FB`.
  if (isMpegAudioFrameHeader(bytes)) {
    return 'mp3';
  }

  return null;
}

/** Identifier, version, revision, flags and a four-byte size. */
const ID3V2_HEADER_BYTES = 10;

/**
 * Whether the file opens on an ID3v2 tag, which is how most encoders start an
 * MP3.
 *
 * The three-letter identifier alone is as weak as the bare frame sync was: any
 * text file beginning "ID3" would satisfy it, which is the same renamed-`.txt`
 * hole in a different rule. So the whole header is required to be well formed.
 * The fields with an encoding a tag cannot hold are:
 *
 * - version and revision, where `FF` is reserved by the spec;
 * - the size, stored synchsafe so that it can never contain a frame sync, which
 *   means all four bytes have their high bit clear.
 *
 * The flags byte is left alone: v2.2, v2.3 and v2.4 each define a different set
 * of bits, and refusing an unknown one would refuse a future revision rather
 * than a text file. Nothing here reads the tag itself — the size can be 2 MB of
 * cover art, and the frames behind the header are not the question.
 */
function isId3v2Header(bytes: Uint8Array): boolean {
  if (!matchesAscii(bytes, 0, 'ID3') || !hasBytesAt(bytes, 0, ID3V2_HEADER_BYTES)) {
    return false;
  }
  if (bytes[3] === 0xff || bytes[4] === 0xff) {
    return false;
  }
  for (let offset = 6; offset < ID3V2_HEADER_BYTES; offset += 1) {
    if (((bytes[offset] ?? 0) & 0x80) !== 0) {
      return false;
    }
  }
  return true;
}

/**
 * Whether the file opens on an MPEG audio frame header, which is how a tagless
 * MP3 begins.
 *
 * The 11-bit frame sync alone is far too weak to decide anything: `FF FE` is
 * the UTF-16LE byte-order mark, so an ordinary text file saved as "Unicode" and
 * renamed to `.mp3` would pass — the exact case this check exists to refuse. So
 * the rest of the header is decoded and every field that has a reserved or
 * meaningless encoding has to be sane:
 *
 * ```
 * byte 1: 1 1 1 V V L L C     byte 2: B B B B S S P R
 * ```
 *
 * - `V` version: `01` is reserved.
 * - `L` layer: `01` is Layer III, which is what `audio/mpeg` in a `.mp3` is.
 *   Layer I and II are refused; no encoder writes them into a file offered as
 *   an MP3, and admitting them would readmit the `FF FE` BOM (Layer I).
 * - `B` bitrate index: `0000` is "free" and `1111` is invalid.
 * - `S` sample rate index: `11` is reserved.
 *
 * The rest — CRC protection, padding, private — carries no invalid value, so
 * there is nothing there to check.
 */
function isMpegAudioFrameHeader(bytes: Uint8Array): boolean {
  // The bound this function reads within, stated rather than inferred. No test
  // can fail if it goes: two bytes leaves `bytes[2] ?? 0` reading as bitrate
  // index `0000`, which the free-bitrate rule refuses by coincidence. Deleting
  // it would leave the coincidence as the only thing keeping the reads in range.
  if (!hasBytesAt(bytes, 0, 3)) {
    return false;
  }
  const sync = bytes[0] ?? 0;
  const flags = bytes[1] ?? 0;
  const rates = bytes[2] ?? 0;
  if (sync !== 0xff || (flags & 0xe0) !== 0xe0) {
    return false;
  }
  const version = (flags >> 3) & 0b11;
  const layer = (flags >> 1) & 0b11;
  const bitrateIndex = (rates >> 4) & 0b1111;
  const sampleRateIndex = (rates >> 2) & 0b11;

  return (
    version !== 0b01 &&
    layer === 0b01 &&
    bitrateIndex !== 0b0000 &&
    bitrateIndex !== 0b1111 &&
    sampleRateIndex !== 0b11
  );
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
