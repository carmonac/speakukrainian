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
    // The three tag revisions in the wild, each with a synchsafe size: v2.2, a
    // v2.3 tag with the extended-header flag, and a v2.4 tag 2 MB long.
    expect(detectMediaContainer(bytes(...ascii('ID3'), 0x02, 0x00, 0x00, 0, 0, 0x02, 0x76))).toBe(
      'mp3',
    );
    expect(detectMediaContainer(bytes(...ascii('ID3'), 0x03, 0x00, 0x40, 0, 0, 0x1f, 0x76))).toBe(
      'mp3',
    );
    expect(
      detectMediaContainer(bytes(...ascii('ID3'), 0x04, 0x00, 0x00, 0, 0x7f, 0x7f, 0x76)),
    ).toBe('mp3');
    // The four leading bytes lame and ffmpeg actually wrote for a tagless file,
    // across all three MPEG versions: 1, 2 and 2.5, Layer III throughout.
    expect(detectMediaContainer(bytes(0xff, 0xfb, 0x90, 0xc4))).toBe('mp3');
    expect(detectMediaContainer(bytes(0xff, 0xf3, 0x80, 0xc4))).toBe('mp3');
    expect(detectMediaContainer(bytes(0xff, 0xe3, 0x40, 0xc4))).toBe('mp3');
    expect(detectMediaContainer(bytes(0xff, 0xfb, 0xe0, 0xc4))).toBe('mp3');
  });

  it('refuses a text file whose byte-order mark passes for a frame sync', () => {
    // The reported hole: `FF FE` is the UTF-16LE BOM and satisfies the 11-bit
    // sync on its own, so a `.txt` saved as "Unicode" and renamed `.mp3` was
    // stored. Decoding the rest of the header is what closes it — `FE` reads as
    // MPEG-1 Layer I, which no encoder writes into a file offered as an MP3.
    const utf16le = bytes(0xff, 0xfe, 0x74, 0x00, 0x68, 0x00, 0x65, 0x00);
    const utf32le = bytes(0xff, 0xfe, 0x00, 0x00, 0x74, 0x00, 0x00, 0x00);

    expect(detectMediaContainer(utf16le)).toBeNull();
    expect(detectMediaContainer(utf32le)).toBeNull();
    expect(contentMatchesBytes('audio/mpeg', utf16le)).toBe(false);
    expect(contentMatchesBytes('audio/mpeg', utf32le)).toBe(false);
  });

  it('refuses a frame header whose fields are reserved or meaningless', () => {
    // Each of these carries a valid sync and one field an MPEG audio frame
    // cannot hold, so anything that accepts them is reading the sync alone.
    const invalid: Record<string, Uint8Array> = {
      'reserved version': bytes(0xff, 0xeb, 0x90, 0x00),
      'layer I': bytes(0xff, 0xfe, 0x90, 0x00),
      'layer II': bytes(0xff, 0xfc, 0x90, 0x00),
      'reserved layer': bytes(0xff, 0xf8, 0x90, 0x00),
      'free bitrate': bytes(0xff, 0xfb, 0x04, 0x00),
      'invalid bitrate': bytes(0xff, 0xfb, 0xf4, 0x00),
      'reserved sample rate': bytes(0xff, 0xfb, 0x9c, 0x00),
      'header cut short': bytes(0xff, 0xfb),
    };

    for (const [reason, header] of Object.entries(invalid)) {
      expect(detectMediaContainer(header), reason).toBeNull();
    }
  });

  it('refuses an ID3 identifier that is not a well-formed tag header', () => {
    // Three ASCII letters were as weak a claim as the bare frame sync was, so
    // the whole 10-byte header has to be present and hold values a tag can.
    const invalid: Record<string, Uint8Array> = {
      'the identifier and nothing else': bytes(...ascii('ID3')),
      'a header one byte short': bytes(...ascii('ID3'), 0x03, 0x00, 0x00, 0x00, 0x00, 0x00),
      'reserved version byte': bytes(...ascii('ID3'), 0xff, 0x00, 0x00, 0, 0, 0x02, 0x76),
      'reserved revision byte': bytes(...ascii('ID3'), 0x03, 0xff, 0x00, 0, 0, 0x02, 0x76),
      'a size byte with its high bit set': bytes(
        ...ascii('ID3'),
        0x03,
        0x00,
        0x00,
        0,
        0,
        0x82,
        0x76,
      ),
      'a size that ends in a high bit': bytes(...ascii('ID3'), 0x03, 0x00, 0x00, 0, 0, 0x02, 0xf6),
    };

    for (const [reason, header] of Object.entries(invalid)) {
      expect(detectMediaContainer(header), reason).toBeNull();
      expect(contentMatchesBytes('audio/mpeg', header), reason).toBe(false);
    }
  });

  it('lets a literal magic win over the frame-sync rule that also claims it', () => {
    // Pins the rule ordering, which is otherwise invisible: an ISO-BMFF box
    // size is four arbitrary bytes and may well read as a valid frame header,
    // so this header satisfies both rules. The one with a real magic must win,
    // which it does only because the frame-sync rule is tried last.
    const ambiguous = bytes(0xff, 0xfb, 0x90, 0x00, ...ascii('ftypM4A '));

    expect(detectMediaContainer(ambiguous)).toBe('iso-bmff');
    expect(contentMatchesBytes('audio/mp4', ambiguous)).toBe(true);
    expect(contentMatchesBytes('audio/mpeg', ambiguous)).toBe(false);
  });

  it('refuses a near miss of each literal magic', () => {
    const nearMisses: Record<string, Uint8Array> = {
      'PNG without its line-ending trap': bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0b),
      'JPEG SOI not followed by a marker': bytes(0xff, 0xd8, 0xfe, 0x00),
      'a GIF revision that does not exist': bytes(...ascii('GIF88a'), 0x10, 0x00),
      'RIFX, the big-endian RIFF': bytes(...ascii('RIFX'), 0, 0, 0, 0, ...ascii('WAVE')),
      'Ogg with the wrong fourth byte': bytes(...ascii('OggT'), 0x00, 0x02, 0x00, 0x00),
      'ftyp at offset 0 instead of 4': bytes(...ascii('ftypM4A '), 0x00, 0x00, 0x00, 0x00),
      'EBML with the last byte off': bytes(0x1a, 0x45, 0xdf, 0xa2, 0x01, 0x00),
      // Well formed in every respect but its case, so only the magic refuses it.
      'a lower-case ID3 tag': bytes(...ascii('id3'), 0x03, 0x00, 0x00, 0, 0, 0x02, 0x76),
    };

    for (const [reason, header] of Object.entries(nearMisses)) {
      expect(detectMediaContainer(header), reason).toBeNull();
    }
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
