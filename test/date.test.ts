// ABOUTME: Unit tests for local-timezone date helpers used by vault_daily_note.
import { describe, expect, test } from 'bun:test';
import { parseLocalYmd, localYmd } from '../src/date.js';

describe('parseLocalYmd', () => {
  test('parses well-formed YYYY-MM-DD as local midnight', () => {
    const d = parseLocalYmd('2026-04-25');
    expect(d).not.toBeNull();
    expect(d!.getFullYear()).toBe(2026);
    expect(d!.getMonth()).toBe(3); // April = index 3
    expect(d!.getDate()).toBe(25);
    expect(d!.getHours()).toBe(0);
    expect(d!.getMinutes()).toBe(0);
  });

  test('roundtrip with localYmd preserves the day in any timezone', () => {
    const d = parseLocalYmd('2026-04-25');
    expect(localYmd(d!)).toBe('2026-04-25');
  });

  test('returns null for malformed input', () => {
    expect(parseLocalYmd('2026-4-25')).toBeNull();
    expect(parseLocalYmd('04-25-2026')).toBeNull();
    expect(parseLocalYmd('garbage')).toBeNull();
    expect(parseLocalYmd('')).toBeNull();
    expect(parseLocalYmd('2026-04-25T00:00:00Z')).toBeNull();
  });

  test('rejects out-of-range dates that JS would silently roll forward', () => {
    expect(parseLocalYmd('2026-02-30')).toBeNull();
    expect(parseLocalYmd('2026-13-01')).toBeNull();
    expect(parseLocalYmd('2026-04-31')).toBeNull();
  });

  test('accepts leap day in leap year, rejects in non-leap year', () => {
    expect(parseLocalYmd('2024-02-29')).not.toBeNull();
    expect(parseLocalYmd('2026-02-29')).toBeNull();
  });
});

describe('localYmd', () => {
  test('formats local components, not UTC', () => {
    // Use a Date constructed via local components — its YMD output should always match.
    const d = new Date(2026, 0, 5); // 2026-01-05 local
    expect(localYmd(d)).toBe('2026-01-05');
  });

  test('zero-pads single-digit month and day', () => {
    const d = new Date(2026, 0, 1); // 2026-01-01 local
    expect(localYmd(d)).toBe('2026-01-01');
  });
});
