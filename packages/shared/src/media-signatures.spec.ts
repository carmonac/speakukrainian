import { describe, expect, it } from 'vitest';
import {
  CONTENT_TYPES_BY_CONTAINER,
  MEDIA_SIGNATURE_BYTES,
  contentMatchesBytes,
  detectMediaContainer,
} from './media-signatures.js';
import { AUDIO_CONTENT_TYPES, IMAGE_CONTENT_TYPES, type MediaContentType } from './media.js';

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);

const ascii = (text: string): number[] => [...text].map((character) => character.charCodeAt(0));

/**
 * A header per allowed type, written from the format specs rather than copied
 * from an encoder, so a wrong offset in the table shows up as a red test rather
 * than as a 415 on a file that plays fine.
 */
const HEADERS: Record<MediaContentType, Uint8Array> = {
  'image/png': bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d),
  'image/jpeg': bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...ascii('JFIF')),
  'image/gif': bytes(...ascii('GIF89a'), 0x10, 0x00, 0x10, 0x00),
  'image/webp': bytes(...ascii('RIFF'), 0x24, 0x00, 0x00, 0x00, ...ascii('WEBPVP8 ')),
  'audio/wav': bytes(...ascii('RIFF'), 0x24, 0x00, 0x00, 0x00, ...ascii('WAVEfmt ')),
  'audio/ogg': bytes(...ascii('OggS'), 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00),
  'audio/mp4': bytes(0x00, 0x00, 0x00, 0x20, ...ascii('ftypM4A '), 0x00, 0x00, 0x00, 0x00),
  'audio/webm': bytes(0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1f),
  'audio/mpeg': bytes(...ascii('ID3'), 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00),
};

describe('detectMediaContainer', () => {
  it('names the container behind each allowed type', () => {
    expect(detectMediaContainer(HEADERS['image/png'])).toBe('png');
    expect(detectMediaContainer(HEADERS['image/jpeg'])).toBe('jpeg');
    expect(detectMediaContainer(HEADERS['image/gif'])).toBe('gif');
    expect(detectMediaContainer(HEADERS['image/webp'])).toBe('webp');
    expect(detectMediaContainer(HEADERS['audio/wav'])).toBe('wav');
    expect(detectMediaContainer(HEADERS['audio/ogg'])).toBe('ogg');
    expect(detectMediaContainer(HEADERS['audio/mp4'])).toBe('iso-bmff');
    expect(detectMediaContainer(HEADERS['audio/webm'])).toBe('ebml');
    expect(detectMediaContainer(HEADERS['audio/mpeg'])).toBe('mp3');
  });

  it('accepts the older GIF revision too', () => {
    expect(detectMediaContainer(bytes(...ascii('GIF87a'), 0x01, 0x00))).toBe('gif');
  });

  it('reads both MP3 shapes: an ID3v2 tag and a bare frame sync', () => {
    expect(detectMediaContainer(bytes(...ascii('ID3'), 0x04, 0x00))).toBe('mp3');
    expect(detectMediaContainer(bytes(0xff, 0xfb, 0x90, 0x00))).toBe('mp3');
    expect(detectMediaContainer(bytes(0xff, 0xf3, 0x48, 0xc4))).toBe('mp3');
  });

  it('reads FF D8 FF as JPEG, not as an MP3 frame sync', () => {
    // Pins the rule ordering: the frame-sync rule is the loosest in the table
    // and must never be tried before a container with a real magic.
    expect(detectMediaContainer(HEADERS['image/jpeg'])).toBe('jpeg');
  });

  it('separates the two RIFF forms by the type at offset 8', () => {
    expect(detectMediaContainer(bytes(...ascii('RIFF'), 0, 0, 0, 0, ...ascii('AVI ')))).toBeNull();
    expect(detectMediaContainer(bytes(...ascii('RIFF'), 0, 0, 0, 0))).toBeNull();
  });

  it('returns null for bytes it does not recognise', () => {
    expect(detectMediaContainer(new Uint8Array(0))).toBeNull();
    expect(detectMediaContainer(bytes(...ascii('this is text')))).toBeNull();
    expect(detectMediaContainer(bytes(0x00, 0x00, 0x00, 0x00))).toBeNull();
    expect(detectMediaContainer(bytes(0x25, 0x50, 0x44, 0x46))).toBeNull();
  });

  it('returns null rather than reading past the end of a truncated header', () => {
    expect(detectMediaContainer(HEADERS['image/png'].slice(0, 4))).toBeNull();
    expect(detectMediaContainer(bytes(...ascii('GIF')))).toBeNull();
    expect(detectMediaContainer(bytes(0x1a, 0x45))).toBeNull();
    expect(detectMediaContainer(bytes(0xff))).toBeNull();
  });
});

describe('contentMatchesBytes', () => {
  it('accepts every allowed type given its own header', () => {
    for (const [contentType, header] of Object.entries(HEADERS) as [
      MediaContentType,
      Uint8Array,
    ][]) {
      expect(contentMatchesBytes(contentType, header)).toBe(true);
    }
  });

  it('refuses a header from a different type, in both directions', () => {
    expect(contentMatchesBytes('audio/mpeg', HEADERS['image/png'])).toBe(false);
    expect(contentMatchesBytes('image/png', HEADERS['audio/mpeg'])).toBe(false);
    expect(contentMatchesBytes('image/jpeg', HEADERS['image/png'])).toBe(false);
    expect(contentMatchesBytes('audio/wav', HEADERS['image/webp'])).toBe(false);
    expect(contentMatchesBytes('image/webp', HEADERS['audio/wav'])).toBe(false);
  });

  it('refuses text, empty and truncated input', () => {
    expect(contentMatchesBytes('audio/mpeg', bytes(...ascii('this is text')))).toBe(false);
    expect(contentMatchesBytes('audio/mpeg', new Uint8Array(0))).toBe(false);
    expect(contentMatchesBytes('image/png', HEADERS['image/png'].slice(0, 4))).toBe(false);
  });

  it('decides every rule within MEDIA_SIGNATURE_BYTES of the start', () => {
    // What the admin reads is a slice of that length, so a rule that needed
    // more would make the two ends of the check disagree.
    for (const [contentType, header] of Object.entries(HEADERS) as [
      MediaContentType,
      Uint8Array,
    ][]) {
      expect(contentMatchesBytes(contentType, header.slice(0, MEDIA_SIGNATURE_BYTES))).toBe(true);
    }
  });
});

describe('CONTENT_TYPES_BY_CONTAINER', () => {
  it('covers every allowed content type exactly once', () => {
    // The drift guard: a type added to an allow-list without a signature would
    // be unuploadable in production, and this is where that shows up instead.
    const mapped = Object.values(CONTENT_TYPES_BY_CONTAINER).flatMap((types) => [...types]);
    const allowed = [...IMAGE_CONTENT_TYPES, ...AUDIO_CONTENT_TYPES];

    expect([...mapped].sort()).toEqual([...allowed].sort());
  });

  it('has a header fixture for every allowed content type', () => {
    const allowed = [...IMAGE_CONTENT_TYPES, ...AUDIO_CONTENT_TYPES];

    expect(Object.keys(HEADERS).sort()).toEqual([...allowed].sort());
  });
});
