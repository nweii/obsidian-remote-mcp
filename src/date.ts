// ABOUTME: Local-timezone date helpers for daily notes — parse and format YYYY-MM-DD using local components, matching the convention used by formatDailyNotePath in vault.ts.

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
