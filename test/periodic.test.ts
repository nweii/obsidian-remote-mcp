// ABOUTME: Periodic note path resolution: env templates, the core Daily notes config, the Periodic
// Notes plugin config, moment format translation, and the built-in daily default.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { resolvePeriodicNotePath, PeriodicConfigError } from '../src/periodic.js';

const ENV_KEYS = [
  'VAULT_PATH', 'OBSIDIAN_CONFIG_DIR', 'DAILY_NOTE_PATH_TEMPLATE', 'WEEKLY_NOTE_PATH_TEMPLATE',
  'MONTHLY_NOTE_PATH_TEMPLATE', 'QUARTERLY_NOTE_PATH_TEMPLATE', 'YEARLY_NOTE_PATH_TEMPLATE', 'PERIODIC_WEEK_START',
];
let saved: Record<string, string | undefined>;
let vaultPath: string;

// 2026-10-12 is a Monday in ISO week 42, Q4.
const MON = new Date(2026, 9, 12);

beforeEach(async () => {
  saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  vaultPath = await mkdtemp(path.join(os.tmpdir(), 'periodic-'));
  process.env.VAULT_PATH = vaultPath;
});

afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(vaultPath, { recursive: true, force: true });
});

async function config(rel: string, value: unknown, configDir = '.obsidian') {
  const file = path.join(vaultPath, configDir, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value));
}

async function periodicNotes(data: unknown, configDir = '.obsidian') {
  await config('community-plugins.json', ['periodic-notes'], configDir);
  await config('plugins/periodic-notes/data.json', data, configDir);
}

function errorOf(run: () => unknown): PeriodicConfigError {
  try {
    run();
  } catch (e) {
    expect(e).toBeInstanceOf(PeriodicConfigError);
    return e as PeriodicConfigError;
  }
  throw new Error('expected a PeriodicConfigError');
}

describe('daily notes from the core Daily notes config', () => {
  test('adds .md only when the format does not already render it', async () => {
    await config('daily-notes.json', { folder: 'Daily', format: 'YYYY-MM-DD[.md]' });
    expect(resolvePeriodicNotePath('daily', MON).path).toBe('Daily/2026-10-12.md');
  });

  test('follows the configured folder and moment format', async () => {
    await config('daily-notes.json', { folder: '01-Days', format: 'YYYY-MM-DD-ddd' });
    expect(resolvePeriodicNotePath('daily', MON)).toEqual({ path: '01-Days/2026-10-12-Mon.md', source: 'core Daily notes' });
  });

  test('DAILY_NOTE_PATH_TEMPLATE wins over the config', async () => {
    await config('daily-notes.json', { folder: '01-Days', format: 'YYYY-MM-DD-ddd' });
    process.env.DAILY_NOTE_PATH_TEMPLATE = 'Journal/{YYYY}-{MM}-{DD}.md';
    expect(resolvePeriodicNotePath('daily', MON).path).toBe('Journal/2026-10-12.md');
  });

  test('without env or config the built-in default applies', () => {
    expect(resolvePeriodicNotePath('daily', MON)).toEqual({ path: 'Daily/2026-10-12.md', source: 'built-in default' });
  });

  test('empty folder and format follow Obsidian defaults', async () => {
    await config('daily-notes.json', {});
    expect(resolvePeriodicNotePath('daily', MON).path).toBe('2026-10-12.md');
  });

  test('literal text in brackets and folder separators inside the format', async () => {
    await config('daily-notes.json', { folder: '/Journal/', format: 'YYYY/MMMM/[Day] D, dddd' });
    expect(resolvePeriodicNotePath('daily', MON).path).toBe('Journal/2026/October/Day 12, Monday.md');
  });

  test('literal text never re-expands as a token', async () => {
    await config('daily-notes.json', { format: 'YYYY-[{MM}]' });
    expect(resolvePeriodicNotePath('daily', MON).path).toBe('2026-{MM}.md');
  });

  test('ordinal days are English', async () => {
    await config('daily-notes.json', { format: 'dddd, MMMM Do YYYY' });
    expect(resolvePeriodicNotePath('daily', MON).path).toBe('Monday, October 12th 2026.md');
    expect(resolvePeriodicNotePath('daily', new Date(2026, 9, 1)).path).toBe('Thursday, October 1st 2026.md');
    expect(resolvePeriodicNotePath('daily', new Date(2026, 9, 22)).path).toBe('Thursday, October 22nd 2026.md');
    expect(resolvePeriodicNotePath('daily', new Date(2026, 9, 13)).path).toBe('Tuesday, October 13th 2026.md');
  });

  test('an unsupported token fails with an error naming it', async () => {
    await config('daily-notes.json', { format: 'YYYY-DDDD' });
    const error = errorOf(() => resolvePeriodicNotePath('daily', MON));
    expect(error.message).toContain('"DDDD"');
    expect(error.message).not.toContain(vaultPath);
  });

  test('a missing or unparseable config falls through to the default', async () => {
    await config('daily-notes.json', '{not json');
    expect(resolvePeriodicNotePath('daily', MON).path).toBe('Daily/2026-10-12.md');
    await config('daily-notes.json', '[1, 2]');
    expect(resolvePeriodicNotePath('daily', MON).path).toBe('Daily/2026-10-12.md');
  });

  test('a disabled core plugin falls through', async () => {
    await config('daily-notes.json', { folder: '01-Days' });
    await config('core-plugins.json', { 'daily-notes': false });
    expect(resolvePeriodicNotePath('daily', MON).path).toBe('Daily/2026-10-12.md');
    await config('core-plugins.json', ['file-explorer']);
    expect(resolvePeriodicNotePath('daily', MON).path).toBe('Daily/2026-10-12.md');
    await config('core-plugins.json', ['daily-notes']);
    expect(resolvePeriodicNotePath('daily', MON).path).toBe('01-Days/2026-10-12.md');
  });

  test('OBSIDIAN_CONFIG_DIR moves the config folder', async () => {
    await config('daily-notes.json', { folder: 'Mobile' }, '.obsidian-mobile');
    expect(resolvePeriodicNotePath('daily', MON).path).toBe('Daily/2026-10-12.md');
    process.env.OBSIDIAN_CONFIG_DIR = '.obsidian-mobile';
    expect(resolvePeriodicNotePath('daily', MON).path).toBe('Mobile/2026-10-12.md');
  });

  test('config changes apply on the next call', async () => {
    await config('daily-notes.json', { folder: 'A' });
    expect(resolvePeriodicNotePath('daily', MON).path).toBe('A/2026-10-12.md');
    await config('daily-notes.json', { folder: 'B' });
    expect(resolvePeriodicNotePath('daily', MON).path).toBe('B/2026-10-12.md');
  });
});

describe('cadences from the Periodic Notes plugin config', () => {
  const legacy = {
    daily: { enabled: true, folder: 'Days', format: 'YYYY-MM-DD' },
    weekly: { enabled: true, folder: 'Weeks', format: 'GGGG-[W]WW' },
    monthly: { enabled: true, folder: 'Months', format: 'YYYY-MM' },
    quarterly: { enabled: true, folder: 'Quarters', format: 'YYYY-[Q]Q' },
    yearly: { enabled: true, folder: 'Years', format: 'YYYY' },
  };

  test('each enabled cadence follows its folder and format', async () => {
    await periodicNotes(legacy);
    expect(resolvePeriodicNotePath('daily', MON)).toEqual({ path: 'Days/2026-10-12.md', source: 'Periodic Notes plugin' });
    expect(resolvePeriodicNotePath('weekly', MON).path).toBe('Weeks/2026-W42.md');
    expect(resolvePeriodicNotePath('monthly', MON).path).toBe('Months/2026-10.md');
    expect(resolvePeriodicNotePath('quarterly', MON).path).toBe('Quarters/2026-Q4.md');
    expect(resolvePeriodicNotePath('yearly', MON).path).toBe('Years/2026.md');
  });

  test('ISO week tokens use the ISO week-year at New Year', async () => {
    await periodicNotes(legacy);
    expect(resolvePeriodicNotePath('weekly', new Date(2025, 11, 31)).path).toBe('Weeks/2026-W01.md');
  });

  test('the calendar-set format of newer plugin versions', async () => {
    await periodicNotes({
      activeCalendarSet: 'b',
      calendarSets: [
        { id: 'a', week: { enabled: true, folder: 'Wrong', format: 'GGGG-[W]WW' } },
        { id: 'b', week: { enabled: true, folder: 'Right', format: 'GGGG-[W]WW' } },
      ],
    });
    expect(resolvePeriodicNotePath('weekly', MON).path).toBe('Right/2026-W42.md');
  });

  test('the plugin wins over the core Daily notes config', async () => {
    await config('daily-notes.json', { folder: 'Core' });
    await periodicNotes(legacy);
    expect(resolvePeriodicNotePath('daily', MON).path).toBe('Days/2026-10-12.md');
  });

  test('env vars win over the plugin', async () => {
    await periodicNotes(legacy);
    process.env.WEEKLY_NOTE_PATH_TEMPLATE = 'W/{GGGG}-{WW}.md';
    expect(resolvePeriodicNotePath('weekly', MON).path).toBe('W/2026-42.md');
  });

  test('disabled cadences fall through', async () => {
    await config('daily-notes.json', { folder: 'Core' });
    await periodicNotes({ ...legacy, daily: { ...legacy.daily, enabled: false } });
    expect(resolvePeriodicNotePath('daily', MON).path).toBe('Core/2026-10-12.md');
  });

  test('a disabled plugin is ignored', async () => {
    await config('plugins/periodic-notes/data.json', legacy);
    expect(() => resolvePeriodicNotePath('weekly', MON)).toThrow(PeriodicConfigError);
    expect(resolvePeriodicNotePath('daily', MON).path).toBe('Daily/2026-10-12.md');
  });

  test("the plugin's default weekly format uses Sunday-start locale weeks", async () => {
    await periodicNotes({ weekly: { enabled: true, folder: 'Weeks', format: '' } });
    expect(resolvePeriodicNotePath('weekly', MON).path).toBe('Weeks/2026-W42.md');
    // Sunday 2026-10-11 opens locale week 42; in ISO weeks it closes week 41.
    expect(resolvePeriodicNotePath('weekly', new Date(2026, 9, 11)).path).toBe('Weeks/2026-W42.md');
    expect(resolvePeriodicNotePath('weekly', new Date(2026, 9, 10)).path).toBe('Weeks/2026-W41.md');
  });

  test('an unconfigured cadence names its env var and every source checked', async () => {
    const error = errorOf(() => resolvePeriodicNotePath('monthly', MON));
    expect(error.message).toContain('MONTHLY_NOTE_PATH_TEMPLATE');
    expect(error.message).toContain('.obsidian/plugins/periodic-notes/data.json');
    expect(error.message).not.toContain(vaultPath);
  });
});

describe('locale weeks', () => {
  beforeEach(() => {
    process.env.WEEKLY_NOTE_PATH_TEMPLATE = '{gggg}-W{ww}.md';
  });

  test('week 1 is the week holding January 1, owned by the new year', () => {
    expect(resolvePeriodicNotePath('weekly', new Date(2025, 11, 28)).path).toBe('2026-W01.md');
    expect(resolvePeriodicNotePath('weekly', new Date(2026, 0, 3)).path).toBe('2026-W01.md');
    expect(resolvePeriodicNotePath('weekly', new Date(2025, 11, 27)).path).toBe('2025-W52.md');
    expect(resolvePeriodicNotePath('weekly', new Date(2026, 0, 4)).path).toBe('2026-W02.md');
  });

  test('bucket a date to the first day of its locale week', () => {
    process.env.WEEKLY_NOTE_PATH_TEMPLATE = '{gggg}-W{w}-{DD}.md';
    expect(resolvePeriodicNotePath('weekly', new Date(2026, 9, 17)).path).toBe('2026-W42-11.md');
  });

  test('PERIODIC_WEEK_START moves the first day of the week', () => {
    process.env.PERIODIC_WEEK_START = 'Monday';
    expect(resolvePeriodicNotePath('weekly', new Date(2026, 9, 11)).path).toBe('2026-W41.md');
    expect(resolvePeriodicNotePath('weekly', MON).path).toBe('2026-W42.md');
  });

  test('a weekStart set in the Calendar plugin is followed, and the env var wins over it', async () => {
    await config('community-plugins.json', ['calendar']);
    await config('plugins/calendar/data.json', { weekStart: 'monday' });
    expect(resolvePeriodicNotePath('weekly', new Date(2026, 9, 11)).path).toBe('2026-W41.md');
    process.env.PERIODIC_WEEK_START = 'sunday';
    expect(resolvePeriodicNotePath('weekly', new Date(2026, 9, 11)).path).toBe('2026-W42.md');
  });

  test('Periodic Notes 1.x takes its week start from the vault settings', async () => {
    await config('community-plugins.json', ['periodic-notes']);
    await config('app.json', { weekStart: 'monday' });
    expect(resolvePeriodicNotePath('weekly', new Date(2026, 9, 11)).path).toBe('2026-W41.md');
    await config('app.json', { weekStart: 'locale' });
    expect(resolvePeriodicNotePath('weekly', new Date(2026, 9, 11)).path).toBe('2026-W42.md');
  });

  test('"locale" or a disabled Calendar plugin keeps the Sunday default', async () => {
    await config('community-plugins.json', ['calendar']);
    await config('plugins/calendar/data.json', { weekStart: 'locale' });
    expect(resolvePeriodicNotePath('weekly', new Date(2026, 9, 11)).path).toBe('2026-W42.md');
    await config('community-plugins.json', []);
    await config('plugins/calendar/data.json', { weekStart: 'monday' });
    expect(resolvePeriodicNotePath('weekly', new Date(2026, 9, 11)).path).toBe('2026-W42.md');
  });

  test('an invalid PERIODIC_WEEK_START fails only paths that use locale weeks', () => {
    process.env.PERIODIC_WEEK_START = 'funday';
    expect(errorOf(() => resolvePeriodicNotePath('weekly', MON)).message).toContain('PERIODIC_WEEK_START');
    process.env.WEEKLY_NOTE_PATH_TEMPLATE = '{GGGG}-W{WW}.md';
    expect(resolvePeriodicNotePath('weekly', MON).path).toBe('2026-W42.md');
  });
});

describe('env templates', () => {
  test('expand every supported token', () => {
    process.env.DAILY_NOTE_PATH_TEMPLATE = '{YYYY}{YY}{GGGG}{GG}{WW}{W}{gggg}{gg}{ww}{w}{Q}{MM}{M}{DD}{Do}{D}{MMM}{MMMM}{dd}{ddd}{dddd}{unknown}.md';
    expect(resolvePeriodicNotePath('daily', MON).path).toBe(
      '20262620262642422026264242410101212th12OctOctoberMoMonMonday{unknown}.md',
    );
  });

  test('bucket a date into its containing period', () => {
    process.env.WEEKLY_NOTE_PATH_TEMPLATE = '{GGGG}-W{WW}-{DD}.md';
    process.env.MONTHLY_NOTE_PATH_TEMPLATE = '{YYYY}-{MM}-{DD}.md';
    process.env.QUARTERLY_NOTE_PATH_TEMPLATE = '{YYYY}-{MM}-{DD}.md';
    process.env.YEARLY_NOTE_PATH_TEMPLATE = '{YYYY}-{MM}-{DD}.md';
    const thu = new Date(2026, 10, 19);
    expect(resolvePeriodicNotePath('weekly', thu).path).toBe('2026-W47-16.md');
    expect(resolvePeriodicNotePath('monthly', thu).path).toBe('2026-11-01.md');
    expect(resolvePeriodicNotePath('quarterly', thu).path).toBe('2026-10-01.md');
    expect(resolvePeriodicNotePath('yearly', thu).path).toBe('2026-01-01.md');
  });

  test('pair the week with the ISO week-year, not the calendar year', () => {
    // 2025-12-29 is in ISO week 1 of 2026.
    process.env.WEEKLY_NOTE_PATH_TEMPLATE = '{GGGG}-W{WW}.md';
    expect(resolvePeriodicNotePath('weekly', new Date(2025, 11, 29)).path).toBe('2026-W01.md');
    process.env.WEEKLY_NOTE_PATH_TEMPLATE = '{YYYY}-W{WW}.md';
    expect(resolvePeriodicNotePath('weekly', new Date(2025, 11, 29)).path).toBe('2025-W01.md');
  });
});
