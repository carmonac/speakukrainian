import { describe, expect, it } from 'vitest';
import {
  AUDIO_CONTENT_TYPES,
  FILE_EXTENSION_BY_CONTENT_TYPE,
  IMAGE_CONTENT_TYPES,
  MAX_AUDIO_UPLOAD_BYTES,
  MAX_IMAGE_UPLOAD_BYTES,
  MEDIA_UPLOAD_RULES,
  contentDoesNotMatchMessage,
  formatMaxUploadSize,
  isAllowedContentType,
  mediaAcceptAttribute,
  unsupportedContentTypeMessage,
  uploadTooLargeMessage,
} from './media.js';

describe('media upload rules', () => {
  const allContentTypes = [...IMAGE_CONTENT_TYPES, ...AUDIO_CONTENT_TYPES];

  it('maps every allowed content type to an extension, and nothing else', () => {
    // A content type added to an allow-list without an extension would produce
    // an object path ending in `.undefined`.
    expect(Object.keys(FILE_EXTENSION_BY_CONTENT_TYPE).sort()).toEqual([...allContentTypes].sort());
  });

  it('uses extensions that are safe as a path suffix', () => {
    for (const extension of Object.values(FILE_EXTENSION_BY_CONTENT_TYPE)) {
      expect(extension).toBe(extension.toLowerCase());
      expect(extension).not.toContain('.');
      expect(extension).not.toContain('/');
      expect(extension.length).toBeGreaterThan(0);
    }
  });

  it('pins the byte limits, which are a contract between the admin and the API', () => {
    expect(MAX_IMAGE_UPLOAD_BYTES).toBe(10 * 1024 * 1024);
    expect(MAX_AUDIO_UPLOAD_BYTES).toBe(50 * 1024 * 1024);
    expect(MEDIA_UPLOAD_RULES.image.maxBytes).toBe(MAX_IMAGE_UPLOAD_BYTES);
    expect(MEDIA_UPLOAD_RULES.audio.maxBytes).toBe(MAX_AUDIO_UPLOAD_BYTES);
  });

  it('stores each kind under its own prefix', () => {
    expect(MEDIA_UPLOAD_RULES.image.prefix).toBe('images');
    expect(MEDIA_UPLOAD_RULES.audio.prefix).toBe('audio');
  });
});

describe('isAllowedContentType', () => {
  it('accepts every type on its own kind list', () => {
    for (const contentType of IMAGE_CONTENT_TYPES) {
      expect(isAllowedContentType('image', contentType)).toBe(true);
    }
    for (const contentType of AUDIO_CONTENT_TYPES) {
      expect(isAllowedContentType('audio', contentType)).toBe(true);
    }
  });

  it('does not let one kind accept the other kind', () => {
    expect(isAllowedContentType('audio', 'image/png')).toBe(false);
    expect(isAllowedContentType('image', 'audio/mpeg')).toBe(false);
  });

  it('rejects an empty or unknown content type', () => {
    expect(isAllowedContentType('audio', '')).toBe(false);
    expect(isAllowedContentType('audio', 'text/plain')).toBe(false);
    expect(isAllowedContentType('image', 'application/octet-stream')).toBe(false);
  });

  it('matches case-sensitively', () => {
    expect(isAllowedContentType('audio', 'AUDIO/MPEG')).toBe(false);
  });

  it('does not accept SVG, which has no header signature to check', () => {
    expect(isAllowedContentType('image', 'image/svg+xml')).toBe(false);
    expect(mediaAcceptAttribute('image')).not.toContain('svg');
  });
});

describe('media messages', () => {
  it('names the limit in the too-large message', () => {
    expect(formatMaxUploadSize('audio')).toBe('50 MB');
    expect(formatMaxUploadSize('image')).toBe('10 MB');
    expect(uploadTooLargeMessage('audio')).toContain('50 MB');
    expect(uploadTooLargeMessage('image')).toContain('10 MB');
  });

  it('names the rejected type and every allowed one', () => {
    const message = unsupportedContentTypeMessage('audio', 'text/plain');

    expect(message).toContain('text/plain');
    for (const contentType of AUDIO_CONTENT_TYPES) {
      expect(message).toContain(contentType);
    }
    expect(message).not.toContain('image/png');
  });

  it('names the declared type in the byte-mismatch message', () => {
    const message = contentDoesNotMatchMessage('audio', 'audio/mpeg');

    expect(message).toContain('audio/mpeg');
    expect(message).toContain('audio');
  });
});

describe('mediaAcceptAttribute', () => {
  it('is the comma-joined content type list', () => {
    expect(mediaAcceptAttribute('image')).toBe(IMAGE_CONTENT_TYPES.join(','));
    expect(mediaAcceptAttribute('audio')).toBe(AUDIO_CONTENT_TYPES.join(','));
  });
});
