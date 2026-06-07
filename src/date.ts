// ABOUTME: Local-timezone date helpers for periodic notes — parse and format YYYY-MM-DD, compute ISO week numbers, and bucket a date into the week, month, quarter, or year containing it, matching the convention used by formatPeriodicNotePath in vault.ts.

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
