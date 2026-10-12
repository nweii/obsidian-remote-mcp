// ABOUTME: Resolves periodic note paths. Each cadence takes its path from its env template, then the
// Periodic Notes plugin config, then (daily only) the core Daily notes config, then the built-in daily
// default. Obsidian's moment.js formats are translated into the same date tokens env templates use.
import { readFileSync } from 'fs';
import path from 'path';
import { getVaultRoot } from './vault.js';
import { isoWeek, isoWeekYear, startOfIsoWeek, startOfMonth, startOfQuarter, startOfYear } from './date.js';

export type PeriodicCadence = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly';

export type PeriodicSource = 'env' | 'Periodic Notes plugin' | 'core Daily notes' | 'built-in default';

export interface PeriodicNotePath {
  path: string;
  source: PeriodicSource;
}

// A configuration that can't produce a path: an untranslatable format, or a cadence nothing
// configures. Messages name env vars and vault-relative config files, never host paths.
export class PeriodicConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PeriodicConfigError';
  }
}

const DEFAULT_DAILY_NOTE_TEMPLATE = 'Daily/{YYYY}-{MM}-{DD}.md';
const DEFAULT_DAILY_FORMAT = 'YYYY-MM-DD';

// Per-cadence facts: the env var holding its template, its key inside a Periodic Notes 1.x calendar
// set, the plugin's own default format, and how a date is bucketed into its period so any date in
// the period formats to the same note. The weekly default uses locale week tokens, which the
// translation refuses, so a vault relying on it is asked to set an ISO format.
const CADENCES: Record<PeriodicCadence, { envVar: string; calendarSetKey: string; defaultFormat: string; bucket: (d: Date) => Date }> = {
  daily: { envVar: 'DAILY_NOTE_PATH_TEMPLATE', calendarSetKey: 'day', defaultFormat: DEFAULT_DAILY_FORMAT, bucket: d => d },
  weekly: { envVar: 'WEEKLY_NOTE_PATH_TEMPLATE', calendarSetKey: 'week', defaultFormat: 'gggg-[W]ww', bucket: startOfIsoWeek },
  monthly: { envVar: 'MONTHLY_NOTE_PATH_TEMPLATE', calendarSetKey: 'month', defaultFormat: 'YYYY-MM', bucket: startOfMonth },
  quarterly: { envVar: 'QUARTERLY_NOTE_PATH_TEMPLATE', calendarSetKey: 'quarter', defaultFormat: 'YYYY-[Q]Q', bucket: startOfQuarter },
  yearly: { envVar: 'YEARLY_NOTE_PATH_TEMPLATE', calendarSetKey: 'year', defaultFormat: 'YYYY', bucket: startOfYear },
};

// --- Date tokens ---------------------------------------------------------------

// The date tokens a path can use. Env templates spell them in braces ({YYYY}); moment formats
// spell them bare. Every other moment token is refused rather than approximated, so a format this
// server can't reproduce exactly fails instead of naming the wrong note. Month and weekday names
// are English, matching Obsidian in English; a vault whose app language changes moment's names
// should set the env templates.
const TOKENS = ['YYYY', 'YY', 'GGGG', 'GG', 'WW', 'Q', 'MMMM', 'MMM', 'MM', 'M', 'DD', 'D', 'dddd', 'ddd', 'dd'] as const;
type Token = (typeof TOKENS)[number];
type Segment = { literal: string } | { token: Token };

const SHORT_WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function formatToken(date: Date, token: Token): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  switch (token) {
    case 'YYYY': return String(date.getFullYear());
    case 'YY': return String(date.getFullYear()).slice(-2);
    case 'GGGG': return String(isoWeekYear(date));
    case 'GG': return String(isoWeekYear(date)).slice(-2);
    case 'WW': return pad(isoWeek(date));
    case 'Q': return String(Math.floor(date.getMonth() / 3) + 1);
    case 'MMMM': return MONTH_NAMES[date.getMonth()]!;
    case 'MMM': return MONTH_NAMES[date.getMonth()]!.slice(0, 3);
    case 'MM': return pad(date.getMonth() + 1);
    case 'M': return String(date.getMonth() + 1);
    case 'DD': return pad(date.getDate());
    case 'D': return String(date.getDate());
    case 'dddd': return DAY_NAMES[date.getDay()]!;
    case 'ddd': return DAY_NAMES[date.getDay()]!.slice(0, 3);
    case 'dd': return SHORT_WEEKDAYS[date.getDay()]!;
  }
}

function formatSegments(date: Date, segments: Segment[]): string {
  return segments.map(s => ('literal' in s ? s.literal : formatToken(date, s.token))).join('');
}

const BRACED_TOKEN = new RegExp(`\\{(${TOKENS.join('|')})\\}`, 'g');

// Env templates: {TOKEN} expands; everything else, including unknown braces, is literal.
function parseTemplate(template: string): Segment[] {
  const segments: Segment[] = [];
  let last = 0;
  for (const match of template.matchAll(BRACED_TOKEN)) {
    if (match.index > last) segments.push({ literal: template.slice(last, match.index) });
    segments.push({ token: match[1] as Token });
    last = match.index + match[0].length;
  }
  if (last < template.length) segments.push({ literal: template.slice(last) });
  return segments;
}

// Moment formats: [text] and \x are literal, non-letters are literal, and a run of one letter is a
// token (with a trailing `o` for ordinals such as Do). A run outside TOKENS is refused by name.
function parseMomentFormat(format: string, source: string): Segment[] {
  const segments: Segment[] = [];
  let i = 0;
  while (i < format.length) {
    const ch = format[i]!;
    if (ch === '[') {
      const end = format.indexOf(']', i + 1);
      if (end === -1) throw new PeriodicConfigError(`${source}: unclosed "[" in format "${format}".`);
      segments.push({ literal: format.slice(i + 1, end) });
      i = end + 1;
    } else if (ch === '\\' && i + 1 < format.length) {
      segments.push({ literal: format[i + 1]! });
      i += 2;
    } else if (/[A-Za-z]/.test(ch)) {
      let end = i;
      while (format[end] === ch) end++;
      if (ch !== 'o' && format[end] === 'o') end++;
      const run = format.slice(i, end);
      if (!(TOKENS as readonly string[]).includes(run)) {
        throw new PeriodicConfigError(
          `${source}: the format "${format}" uses the moment token "${run}", which this server can't reproduce. ` +
            `Supported tokens: ${TOKENS.join(', ')}. Wrap literal text in [brackets].`,
        );
      }
      segments.push({ token: run as Token });
      i = end;
    } else {
      segments.push({ literal: ch });
      i++;
    }
  }
  return segments;
}

// --- Obsidian config -----------------------------------------------------------

// The vault's Obsidian config folder, relative to the vault root. Read on every call, so edits made
// in Obsidian apply without a restart; the files are a few hundred bytes.
function configDir(): string {
  return process.env.OBSIDIAN_CONFIG_DIR?.trim() || '.obsidian';
}

// Parsed JSON, or undefined when the file is missing, unreadable or not JSON.
function readConfigJson(rel: string): unknown {
  try {
    return JSON.parse(readFileSync(path.resolve(getVaultRoot(), rel), 'utf-8'));
  } catch {
    return undefined;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const trimmedString = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

interface ConfiguredFormat {
  folder: string;
  format: string;
}

type Lookup = { found: ConfiguredFormat } | { skipped: string };

// Config files, as vault-relative paths (also how errors name them).
const configFile = (name: string) => `${configDir()}/${name}`;
const periodicNotesFile = () => configFile('plugins/periodic-notes/data.json');
const dailyNotesFile = () => configFile('daily-notes.json');

// Periodic Notes keeps cadences keyed by name (0.x) or inside the active calendar set (1.x).
function lookupPeriodicNotes(cadence: PeriodicCadence): Lookup {
  const enabled = readConfigJson(configFile('community-plugins.json'));
  if (!Array.isArray(enabled) || !enabled.includes('periodic-notes')) return { skipped: 'plugin not enabled' };
  const data = readConfigJson(periodicNotesFile());
  if (!isRecord(data)) return { skipped: 'not found or unreadable' };
  let settings: unknown = data[cadence];
  if (Array.isArray(data.calendarSets)) {
    const sets = data.calendarSets.filter(isRecord);
    const active = sets.find(s => s.id === data.activeCalendarSet) ?? sets[0];
    settings = active?.[CADENCES[cadence].calendarSetKey];
  }
  if (!isRecord(settings) || settings.enabled !== true) return { skipped: `${cadence} not enabled` };
  return { found: { folder: trimmedString(settings.folder), format: trimmedString(settings.format) || CADENCES[cadence].defaultFormat } };
}

// core-plugins.json is a list of enabled ids in older Obsidian and an id → boolean map in newer.
// Without it, Daily notes counts as on, as it is in a fresh vault.
function lookupCoreDailyNotes(): Lookup {
  const core = readConfigJson(configFile('core-plugins.json'));
  const disabled = Array.isArray(core) ? !core.includes('daily-notes') : isRecord(core) && core['daily-notes'] === false;
  if (disabled) return { skipped: 'plugin not enabled' };
  const data = readConfigJson(dailyNotesFile());
  if (!isRecord(data)) return { skipped: 'not found or unreadable' };
  return { found: { folder: trimmedString(data.folder), format: trimmedString(data.format) || DEFAULT_DAILY_FORMAT } };
}

function configuredPath(date: Date, { folder, format }: ConfiguredFormat, source: string): string {
  const name = formatSegments(date, parseMomentFormat(format, source));
  const dir = folder.replace(/^\/+|\/+$/g, '');
  return `${dir ? `${dir}/` : ''}${name}.md`;
}

// --- Resolution ----------------------------------------------------------------

// Resolves a cadence's note path for a date (today by default), trying each source in order. A
// source that is present but can't be translated throws instead of falling through, because a
// later source would name a note the vault owner doesn't use. Throws PeriodicConfigError when no
// source configures the cadence, listing every source checked.
export function resolvePeriodicNotePath(cadence: PeriodicCadence, date: Date = new Date()): PeriodicNotePath {
  const { envVar, bucket } = CADENCES[cadence];
  const bucketed = bucket(date);
  const template = process.env[envVar]?.trim();
  if (template) return { path: formatSegments(bucketed, parseTemplate(template)), source: 'env' };

  const checked = [`${envVar} (not set)`];
  const plugin = lookupPeriodicNotes(cadence);
  if ('found' in plugin) {
    return { path: configuredPath(bucketed, plugin.found, periodicNotesFile()), source: 'Periodic Notes plugin' };
  }
  checked.push(`${periodicNotesFile()} (${plugin.skipped})`);

  if (cadence === 'daily') {
    const core = lookupCoreDailyNotes();
    if ('found' in core) {
      return { path: configuredPath(bucketed, core.found, dailyNotesFile()), source: 'core Daily notes' };
    }
    return { path: formatSegments(bucketed, parseTemplate(DEFAULT_DAILY_NOTE_TEMPLATE)), source: 'built-in default' };
  }

  throw new PeriodicConfigError(
    `No ${cadence} note path is configured. Checked: ${checked.join('; ')}. ` +
      `Set ${envVar}, or enable ${cadence} notes in the Periodic Notes plugin.`,
  );
}
