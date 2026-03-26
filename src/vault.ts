// ABOUTME: Filesystem operations for the configured Obsidian vault - safe path resolution, read/write/search helpers.
import fs from 'fs/promises';
import { readFileSync } from 'fs';
import { load as parseYaml, dump as stringifyYaml } from 'js-yaml';
import path from 'path';
import { fileURLToPath } from 'url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CONTEXT_NOTE_CANDIDATES = ['AGENTS.md', 'CLAUDE.md'] as const;
export const DEFAULT_DAILY_NOTE_TEMPLATE = 'Daily/{YYYY}-{MM}-{DD}.md';

function collectVaultPaths(vaults: Record<string, { path?: string }>): { id: string; absPath: string }[] {
  const out: { id: string; absPath: string }[] = [];
  for (const [id, v] of Object.entries(vaults)) {
    const p = v?.path;
    if (typeof p === 'string' && p.trim() !== '') {
      out.push({ id, absPath: path.resolve(p.trim()) });
    }
  }
  return out;
}

function pickVaultFromObsidianConfig(configPath: string): string {
  let data: { vaults?: Record<string, { path?: string }> };
  try {
    data = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    throw new Error(`Invalid JSON in Obsidian config: ${configPath}`);
  }
  const vaults = data.vaults;
  if (!vaults || Object.keys(vaults).length === 0) {
    throw new Error(`Obsidian config has no vaults: ${configPath}`);
  }
  const entries = collectVaultPaths(vaults);
  if (entries.length === 0) {
    throw new Error(`Obsidian config has no vault entries with a path: ${configPath}`);
  }
  const pickId = process.env.OBSIDIAN_VAULT_ID?.trim();
  if (pickId) {
    const hit = entries.find(e => e.id.toLowerCase() === pickId.toLowerCase());
    if (!hit) {
      throw new Error(
        `OBSIDIAN_VAULT_ID="${pickId}" not in ${configPath}. Available: ${entries.map(e => e.id).join(', ')}`,
      );
    }
    return hit.absPath;
  }
  if (entries.length > 1) {
    throw new Error(
      `Multiple vaults in ${configPath}; set OBSIDIAN_VAULT_ID to one of: ${entries.map(e => e.id).join(', ')}`,
    );
  }
  return entries[0]!.absPath;
}

function findObsidianConfigPath(): string | null {
  const startDirs = new Set([process.cwd(), path.resolve(MODULE_DIR, '..')]);
  for (const start of startDirs) {
    let dir = path.resolve(start);
    while (true) {
      const configPath = path.join(dir, '.config', 'obsidian', 'obsidian.json');
      try {
        readFileSync(configPath);
        return configPath;
      } catch {
        // not found
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

function pathExists(absPath: string): boolean {
  try {
    readFileSync(absPath);
    return true;
  } catch {
    return false;
  }
}

function resolveVaultRoot(): string {
  const fromEnv = process.env.VAULT_PATH?.trim();
  if (fromEnv) return path.resolve(fromEnv);

  const configPath = findObsidianConfigPath();
  if (configPath) {
    return pickVaultFromObsidianConfig(configPath);
  }

  throw new Error(
    'Vault root not configured: set VAULT_PATH, or place .config/obsidian/obsidian.json (with vault path entries) where it can be found by walking up from the working directory or this package directory.',
  );
}

const VAULT_ROOT = resolveVaultRoot();

export function getVaultDisplayName(): string {
  const fromEnv = process.env.VAULT_DISPLAY_NAME?.trim();
  return fromEnv || path.basename(VAULT_ROOT);
}

export function getContextNotePath(): string | null {
  const fromEnv = process.env.VAULT_CONTEXT_PATH?.trim();
  if (fromEnv) return fromEnv;

  for (const candidate of DEFAULT_CONTEXT_NOTE_CANDIDATES) {
    if (pathExists(path.join(VAULT_ROOT, candidate))) {
      return candidate;
    }
  }

  return null;
}

// --- .mcpignore --------------------------------------------------------------

// Patterns from <vault>/.mcpignore — relative paths from vault root, one per line.
// Lines starting with # are comments. Trailing slashes are stripped before matching.
function loadIgnorePatterns(): string[] {
  try {
    return readFileSync(path.join(VAULT_ROOT, '.mcpignore'), 'utf-8')
      .split('\n')
      .map(l => l.trim().replace(/\/$/, ''))
      .filter(l => l && !l.startsWith('#'));
  } catch {
    return [];
  }
}

const IGNORE_PATTERNS = loadIgnorePatterns();

function isIgnored(absPath: string): boolean {
  if (IGNORE_PATTERNS.length === 0) return false;
  const rel = path.relative(VAULT_ROOT, absPath);
  return IGNORE_PATTERNS.some(p => rel === p || rel.startsWith(p + path.sep));
}

// --- Read-only mode ----------------------------------------------------------

// Throws if VAULT_READ_ONLY=true is set in the environment.
function assertWritable() {
  if (process.env.VAULT_READ_ONLY === 'true') {
    throw new Error('Vault is in read-only mode (VAULT_READ_ONLY=true)');
  }
}

// --- Path safety -------------------------------------------------------------

// Ensure path stays within vault root and is not blocked by .mcpignore. Returns absolute path.
export function resolveSafePath(relativePath: string): string {
  const resolved = path.resolve(VAULT_ROOT, relativePath);
  const root = VAULT_ROOT.endsWith(path.sep) ? VAULT_ROOT : VAULT_ROOT + path.sep;
  if (!resolved.startsWith(root) && resolved !== VAULT_ROOT) {
    throw new Error(`Path escapes vault root: ${relativePath}`);
  }
  if (isIgnored(resolved)) {
    throw new Error(`Path is blocked by .mcpignore: ${relativePath}`);
  }
  return resolved;
}

export async function readNote(relativePath: string): Promise<string> {
  return fs.readFile(resolveSafePath(relativePath), 'utf-8');
}

function splitFrontmatter(content: string): { frontmatter: string | null; body: string } {
  if (!content.startsWith('---\n')) {
    return { frontmatter: null, body: content };
  }

  const end = content.indexOf('\n---\n', 4);
  if (end === -1) {
    return { frontmatter: null, body: content };
  }

  return {
    frontmatter: content.slice(4, end),
    body: content.slice(end + 5),
  };
}

function normalizeFrontmatterValue(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

function parseFrontmatter(content: string): Record<string, unknown> | null {
  const { frontmatter } = splitFrontmatter(content);
  if (frontmatter === null) return null;
  const parsed = parseYaml(frontmatter);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
}

function serializeFrontmatter(data: Record<string, unknown>, body: string): string {
  const yaml = stringifyYaml(data, {
    lineWidth: 0,
    noRefs: true,
  }).trimEnd();
  return `---\n${yaml}\n---\n${body}`;
}

export async function writeNote(relativePath: string, content: string): Promise<void> {
  assertWritable();
  const absPath = resolveSafePath(relativePath);
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, content, 'utf-8');
}

export async function getFrontmatter(relativePath: string): Promise<Record<string, unknown> | null> {
  const content = await readNote(relativePath);
  return parseFrontmatter(content);
}

export async function getFrontmatterProperty(relativePath: string, name: string): Promise<unknown> {
  const frontmatter = await getFrontmatter(relativePath);
  return frontmatter?.[name];
}

export async function setFrontmatterProperty(relativePath: string, name: string, value: unknown): Promise<void> {
  assertWritable();
  const content = await readNote(relativePath);
  const { body } = splitFrontmatter(content);
  const frontmatter = parseFrontmatter(content) ?? {};
  frontmatter[name] = value;
  await writeNote(relativePath, serializeFrontmatter(frontmatter, body));
}

export async function appendNote(relativePath: string, content: string): Promise<void> {
  assertWritable();
  await fs.appendFile(resolveSafePath(relativePath), content, 'utf-8');
}

export async function deleteNote(relativePath: string): Promise<void> {
  await fs.unlink(resolveSafePath(relativePath));
}

export async function trashNote(relativePath: string): Promise<void> {
  assertWritable();
  const absPath = resolveSafePath(relativePath);
  const trashDir = path.join(VAULT_ROOT, '.trash');
  await fs.mkdir(trashDir, { recursive: true });
  // Avoid collisions in .trash by prefixing with a timestamp
  const trashPath = path.join(trashDir, `${Date.now()}-${path.basename(relativePath)}`);
  await fs.rename(absPath, trashPath);
}

export interface SearchResult {
  path: string;
  matches: string[];
}

export interface SearchOptions {
  caseSensitive?: boolean;
  folder?: string;   // relative path to scope the search; defaults to vault root
  limit?: number;    // max matching files to return; 0 means no limit
}

export async function searchContent(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
  const { caseSensitive = false, folder, limit = 20 } = options;
  const root = folder ? resolveSafePath(folder) : VAULT_ROOT;
  const results: SearchResult[] = [];
  const regex = new RegExp(query, caseSensitive ? '' : 'i');
  const maxResults = limit > 0 ? limit : Number.POSITIVE_INFINITY;

  async function walk(dir: string) {
    if (results.length >= maxResults) return;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= maxResults) break;
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.name.endsWith('.md')) {
        let content: string;
        try {
          content = await fs.readFile(fullPath, 'utf-8');
        } catch {
          continue; // skip unreadable files (e.g. permission denied)
        }
        const matches = content.split('\n').filter(line => regex.test(line));
        if (matches.length > 0) {
          results.push({ path: path.relative(VAULT_ROOT, fullPath), matches });
        }
      }
    }
  }

  await walk(root);
  return results;
}

export async function searchFilename(pattern: string): Promise<string[]> {
  const results: string[] = [];
  const regex = new RegExp(pattern, 'i');

  async function walk(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (regex.test(entry.name)) {
        results.push(path.relative(VAULT_ROOT, fullPath));
      }
    }
  }

  await walk(VAULT_ROOT);
  return results;
}

export interface FindResult {
  path: string;
  title: string; // filename without .md extension
}

// Find notes by title, matching against filenames (case-insensitive).
// exact=true requires a full match; exact=false matches any filename containing the query.
export async function findByTitle(query: string, exact = false, limit = 50): Promise<FindResult[]> {
  const results: FindResult[] = [];
  const normalizedQuery = query.toLowerCase();
  const maxResults = limit > 0 ? limit : Number.POSITIVE_INFINITY;

  async function walk(dir: string) {
    if (results.length >= maxResults) return;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= maxResults) break;
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.name.endsWith('.md')) {
        const title = entry.name.slice(0, -3);
        const normalizedTitle = title.toLowerCase();
        const matched = exact
          ? normalizedTitle === normalizedQuery
          : normalizedTitle.includes(normalizedQuery);
        if (matched) {
          results.push({ path: path.relative(VAULT_ROOT, fullPath), title });
        }
      }
    }
  }

  await walk(VAULT_ROOT);
  return results;
}

// --- Outline -----------------------------------------------------------------

// Return all heading lines from a note, preserving # prefix so level is visible.
export async function getNoteOutline(relativePath: string): Promise<string[]> {
  const content = await readNote(relativePath);
  return content.split('\n').filter(line => /^#{1,6}\s/.test(line));
}

// --- Section reading ---------------------------------------------------------

// Read a single heading section from a note (the heading line through the next
// same-or-higher-level heading). Heading match is case-insensitive, without the # prefix.
export async function readNoteSection(relativePath: string, heading: string): Promise<string> {
  const content = await readNote(relativePath);
  const lines = content.split('\n');
  const normalizedTarget = heading.toLowerCase().trim();

  let startIdx = -1;
  let headingLevel = 0;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,6})\s+(.+)/);
    if (match && match[2].trim().toLowerCase() === normalizedTarget) {
      startIdx = i;
      headingLevel = match[1].length;
      break;
    }
  }

  if (startIdx === -1) {
    throw new Error(`Heading "${heading}" not found in ${relativePath}`);
  }

  // Collect until the next heading at the same or higher level
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,6})\s/);
    if (match && match[1].length <= headingLevel) {
      endIdx = i;
      break;
    }
  }

  return lines.slice(startIdx, endIdx).join('\n');
}

// --- Link graph --------------------------------------------------------------

export interface LinkResult {
  title: string;
  path: string | null; // null if the linked note wasn't found in the vault
}

// Build a lowercase-title → relative-path index from a single vault walk (directory reads only).
async function buildTitleIndex(): Promise<Map<string, string>> {
  const index = new Map<string, string>();

  async function walk(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.name.endsWith('.md')) {
        index.set(entry.name.slice(0, -3).toLowerCase(), path.relative(VAULT_ROOT, fullPath));
      }
    }
  }

  await walk(VAULT_ROOT);
  return index;
}

// Return all outgoing [[wikilinks]] from a note with resolved paths.
// One vault walk for the title index, so cost is proportional to vault size regardless
// of how many links the note contains.
export async function getNoteLinks(relativePath: string): Promise<LinkResult[]> {
  const content = await readNote(relativePath);

  // Matches [[Title]], [[Title|alias]], [[Title#heading]], [[Title#heading|alias]]
  const regex = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
  const seen = new Set<string>();
  const titles: string[] = [];

  let match;
  while ((match = regex.exec(content)) !== null) {
    const title = match[1].trim();
    if (!seen.has(title.toLowerCase())) {
      seen.add(title.toLowerCase());
      titles.push(title);
    }
  }

  if (titles.length === 0) return [];

  const index = await buildTitleIndex();
  return titles.map(title => ({ title, path: index.get(title.toLowerCase()) ?? null }));
}

// Return paths of notes that link to the given note (backlinks).
// Uses a content search for [[title pattern, so it may include false positives
// from notes that mention the title in non-link contexts.
export async function getBacklinks(relativePath: string, limit = 20): Promise<string[]> {
  const title = path.basename(relativePath, '.md');
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const results = await searchContent(`\\[\\[${escaped}`, { limit });
  // Exclude the note itself
  return results.map(r => r.path).filter(p => p !== relativePath);
}

// --- Daily notes -------------------------------------------------------------

function formatDailyNotePath(date: Date, template: string): string {
  const year = date.getFullYear();
  const shortYear = String(year).slice(-2);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const monthNumber = String(date.getMonth() + 1);
  const day = String(date.getDate()).padStart(2, '0');
  const dayNumber = String(date.getDate());
  const dayIndex = date.getDay();
  const shortWeekday = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'][dayIndex];
  const shortDayName = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dayIndex];
  const longDayName = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][dayIndex];
  const shortMonthName = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][date.getMonth()];
  const longMonthName = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][date.getMonth()];

  return template
    .replaceAll('{YYYY}', String(year))
    .replaceAll('{YY}', shortYear)
    .replaceAll('{MM}', month)
    .replaceAll('{M}', monthNumber)
    .replaceAll('{DD}', day)
    .replaceAll('{D}', dayNumber)
    .replaceAll('{MMMM}', longMonthName)
    .replaceAll('{MMM}', shortMonthName)
    .replaceAll('{dddd}', longDayName)
    .replaceAll('{ddd}', shortDayName)
    .replaceAll('{dd}', shortWeekday);
}

export function getDailyNoteTemplate(): string {
  return process.env.DAILY_NOTE_PATH_TEMPLATE?.trim() || DEFAULT_DAILY_NOTE_TEMPLATE;
}

// Daily notes use a configurable path template with date tokens like {YYYY}, {MM}, {DD}, {MMM}, {ddd}, and {dddd}.
export function getDailyNotePath(date?: Date): string {
  const d = date ?? new Date();
  return formatDailyNotePath(d, getDailyNoteTemplate());
}
