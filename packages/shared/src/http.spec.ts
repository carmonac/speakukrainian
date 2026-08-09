import { describe, expect, it } from 'vitest';
import { MAX_JSON_BODY_BYTES, formatMaxJsonBodySize, jsonBodyTooLargeMessage } from './http.js';

describe('JSON body limit', () => {
  it('derives the size wording from the byte limit rather than restating it', () => {
    expect(MAX_JSON_BODY_BYTES).toBe(1024 * 1024);
    expect(formatMaxJsonBodySize()).toBe('1 MB');
    expect(jsonBodyTooLargeMessage()).toBe('Request bodies must be under 1 MB.');
    expect(jsonBodyTooLargeMessage()).toContain(formatMaxJsonBodySize());
  });

  it('stays inside what one Firestore document can hold', () => {
    // A JSON body is 1–2% larger than the document it becomes, so a body this
    // size or smaller can still produce a storable document.
    expect(MAX_JSON_BODY_BYTES).toBeLessThanOrEqual(1_048_576);
  });
});
