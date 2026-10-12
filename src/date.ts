// ABOUTME: Local-timezone date helpers for periodic notes — parse and format YYYY-MM-DD, compute ISO and locale week numbers, and bucket a date into the week, month, quarter, or year containing it, matching the buckets periodic.ts formats paths from.

// Parse a "YYYY-MM-DD" string as local midnight (not UTC) so the day of the
// resulting Date matches the calendar day the caller named, regardless of the
// server's timezone. Returns null for malformed or out-of-range input.
export function parseLocalYmd(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(year, month - 1, day);
  // Reject values like "2026-02-30" that JS silently rolls forward.
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  return d;
}

// Format a Date as "YYYY-MM-DD" using local-time components.
export function localYmd(d: Date): string {
  const y = String(d.getFullYear()).padStart(4, '0');
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ISO 8601 weeks start Monday and week 1 is the week containing the first
// Thursday of the year. The "Thursday of this week" trick: shift the date to
// the Thursday in the same ISO week, then count weeks from Jan 1 of that
// Thursday's year. That Thursday's year is the ISO week-year, which can differ
// from the calendar year for dates in late December or early January.
function isoThursday(d: Date): Date {
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const isoDay = (t.getDay() + 6) % 7; // Mon=0 .. Sun=6
  t.setDate(t.getDate() - isoDay + 3); // move to Thursday of this ISO week
  return t;
}

// ISO week number (1–53) for the week containing the given date.
export function isoWeek(d: Date): number {
  const thursday = isoThursday(d);
  const jan1 = new Date(thursday.getFullYear(), 0, 1);
  const days = Math.round((thursday.getTime() - jan1.getTime()) / 86400000);
  return Math.floor(days / 7) + 1;
}

// ISO week-year (the year that "owns" this date's ISO week). Differs from the
// calendar year around New Year — e.g. 2025-12-29 belongs to ISO week-year 2026.
export function isoWeekYear(d: Date): number {
  return isoThursday(d).getFullYear();
}

// Monday (local midnight) of the ISO week containing the given date.
export function startOfIsoWeek(d: Date): Date {
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const isoDay = (t.getDay() + 6) % 7; // Mon=0 .. Sun=6
  t.setDate(t.getDate() - isoDay);
  return t;
}

// Locale weeks, as moment.js computes them for gggg/ww: weeks start on `dow` (0 = Sunday) and
// week 1 is the week containing January (7 + dow - doy). Obsidian in English uses dow 0, doy 6:
// Sunday-start weeks where week 1 holds January 1, so 2025-12-28 opens week 1 of 2026.
export interface WeekConvention {
  dow: number;
  doy: number;
}

const isLeapYear = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const daysInYear = (y: number) => (isLeapYear(y) ? 366 : 365);

function dayOfYear(d: Date): number {
  return Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - new Date(d.getFullYear(), 0, 1).getTime()) / 86400000) + 1;
}

// Day-of-year offset of week 1's first day from January 1 (moment's firstWeekOffset).
function firstWeekOffset(year: number, { dow, doy }: WeekConvention): number {
  const fwd = 7 + dow - doy;
  const fwdlw = (7 + new Date(year, 0, fwd).getDay() - dow) % 7;
  return -fwdlw + fwd - 1;
}

function weeksInYear(year: number, conv: WeekConvention): number {
  return (daysInYear(year) - firstWeekOffset(year, conv) + firstWeekOffset(year + 1, conv)) / 7;
}

// Locale week number and the week-year that owns it.
export function localeWeek(d: Date, conv: WeekConvention): { week: number; year: number } {
  const year = d.getFullYear();
  const week = Math.floor((dayOfYear(d) - firstWeekOffset(year, conv) - 1) / 7) + 1;
  if (week < 1) return { week: week + weeksInYear(year - 1, conv), year: year - 1 };
  if (week > weeksInYear(year, conv)) return { week: week - weeksInYear(year, conv), year: year + 1 };
  return { week, year };
}

// First day (local midnight) of the locale week starting on `dow` that contains the given date.
export function startOfLocaleWeek(d: Date, dow: number): Date {
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  t.setDate(t.getDate() - ((t.getDay() - dow + 7) % 7));
  return t;
}

// First day (local midnight) of the month containing the given date.
export function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

// First day (local midnight) of the quarter containing the given date.
export function startOfQuarter(d: Date): Date {
  const quarterFirstMonth = Math.floor(d.getMonth() / 3) * 3;
  return new Date(d.getFullYear(), quarterFirstMonth, 1);
}

// First day (local midnight) of the year containing the given date.
export function startOfYear(d: Date): Date {
  return new Date(d.getFullYear(), 0, 1);
}
