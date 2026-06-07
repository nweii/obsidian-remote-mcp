// ABOUTME: Unit tests for local-timezone date helpers used by vault_periodic_note.
import { describe, expect, test } from 'bun:test';
import {
  parseLocalYmd,
  localYmd,
  isoWeek,
  isoWeekYear,
  startOfIsoWeek,
  startOfMonth,
  startOfQuarter,
  startOfYear,
} from '../src/date.js';

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

describe('isoWeek and isoWeekYear', () => {
  test('numbers a mid-year week (week 1 contains the first Thursday)', () => {
    // 2026-03-26 is a Thursday in ISO week 13 of 2026.
    const d = new Date(2026, 2, 26);
    expect(isoWeek(d)).toBe(13);
    expect(isoWeekYear(d)).toBe(2026);
  });

  test('a late-December date can belong to week 1 of the next ISO year', () => {
    // 2025-12-29 (Mon) starts the ISO week whose Thursday is 2026-01-01,
    // so it is week 1 of week-year 2026 even though the calendar year is 2025.
    const d = new Date(2025, 11, 29);
    expect(isoWeek(d)).toBe(1);
    expect(isoWeekYear(d)).toBe(2026);
    expect(d.getFullYear()).toBe(2025); // calendar year differs from week-year
  });

  test('an early-January date can belong to the last week of the previous ISO year', () => {
    // 2021-01-01 is a Friday in ISO week 53 of week-year 2020.
    const d = new Date(2021, 0, 1);
    expect(isoWeek(d)).toBe(53);
    expect(isoWeekYear(d)).toBe(2020);
  });
});

describe('period start helpers', () => {
  test('startOfIsoWeek returns the Monday of the containing week', () => {
    // 2026-03-26 (Thu) → Monday 2026-03-23.
    expect(localYmd(startOfIsoWeek(new Date(2026, 2, 26)))).toBe('2026-03-23');
    // A Sunday belongs to the week that started the previous Monday.
    expect(localYmd(startOfIsoWeek(new Date(2026, 2, 29)))).toBe('2026-03-23');
    // A Monday is already its own week start.
    expect(localYmd(startOfIsoWeek(new Date(2026, 2, 23)))).toBe('2026-03-23');
  });

  test('startOfMonth returns the first of the month', () => {
    expect(localYmd(startOfMonth(new Date(2026, 2, 26)))).toBe('2026-03-01');
  });

  test('startOfQuarter returns the first day of the quarter', () => {
    expect(localYmd(startOfQuarter(new Date(2026, 0, 15)))).toBe('2026-01-01');
    expect(localYmd(startOfQuarter(new Date(2026, 2, 26)))).toBe('2026-01-01');
    expect(localYmd(startOfQuarter(new Date(2026, 3, 1)))).toBe('2026-04-01');
    expect(localYmd(startOfQuarter(new Date(2026, 11, 31)))).toBe('2026-10-01');
  });

  test('startOfYear returns January 1', () => {
    expect(localYmd(startOfYear(new Date(2026, 11, 31)))).toBe('2026-01-01');
  });
});
