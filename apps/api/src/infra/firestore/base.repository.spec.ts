import { describe, expect, it } from 'vitest';
import { Timestamp } from '@google-cloud/firestore';
import { deepConvertTimestamps } from './base.repository.js';

describe('deepConvertTimestamps', () => {
  const instant = new Date('2026-03-04T05:06:07.000Z');

  it('converts a top-level Timestamp to an ISO string', () => {
    expect(deepConvertTimestamps(Timestamp.fromDate(instant))).toBe('2026-03-04T05:06:07.000Z');
  });

  it('converts Timestamps nested inside objects', () => {
    const result = deepConvertTimestamps({
      audit: { createdAt: Timestamp.fromDate(instant), createdBy: 'admin' },
    }) as { audit: { createdAt: string; createdBy: string } };

    expect(result.audit.createdAt).toBe('2026-03-04T05:06:07.000Z');
    expect(result.audit.createdBy).toBe('admin');
  });

  it('converts Timestamps inside arrays', () => {
    const result = deepConvertTimestamps([Timestamp.fromDate(instant)]) as string[];
    expect(result[0]).toBe('2026-03-04T05:06:07.000Z');
  });

  it('leaves other values untouched', () => {
    const input = { title: { en: 'Hello' }, count: 3, enabled: false, missing: null };
    expect(deepConvertTimestamps(input)).toEqual(input);
  });

  it('does not recurse into class instances that merely look like objects', () => {
    // Firestore returns GeoPoint and DocumentReference values whose internals
    // would be mangled by a naive deep copy.
    class Opaque {
      constructor(readonly value = 1) {}
    }
    const opaque = new Opaque();
    expect(deepConvertTimestamps(opaque)).toBe(opaque);
  });
});
