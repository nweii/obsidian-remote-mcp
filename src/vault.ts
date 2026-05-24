// ABOUTME: Filesystem operations for the configured Obsidian vault - safe path resolution, read/write/search, list folder.
import fs from 'fs/promises';
import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { load as parseYaml, dump as stringifyYaml } from 'js-yaml';
import path from 'path';
import { fileURLToPath } from 'url';
import { withPathLock } from './lock.js';
import { threeWayMerge, summarizeConflicts, MERGE_MAX_LINES } from './merge.js';

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

export function getVaultRoot(): string {
  return VAULT_ROOT;
}

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

// Thrown by resolveSafePath when a path is rejected for security/policy reasons.
// Carries a typed `kind` so callers can match without parsing error text.
export class VaultPolicyError extends Error {
  constructor(public readonly kind: 'escape' | 'mcpignore', message: string) {
    super(message);
    this.name = 'VaultPolicyError';
  }
}

// Ensure path stays within vault root and is not blocked by .mcpignore. Returns absolute path.
export function resolveSafePath(relativePath: string): string {
  const resolved = path.resolve(VAULT_ROOT, relativePath);
  const root = VAULT_ROOT.endsWith(path.sep) ? VAULT_ROOT : VAULT_ROOT + path.sep;
  if (!resolved.startsWith(root) && resolved !== VAULT_ROOT) {
    throw new VaultPolicyError('escape', `Path escapes vault root: ${relativePath}`);
  }
  if (isIgnored(resolved)) {
    throw new VaultPolicyError('mcpignore', `Path is blocked by .mcpignore: ${relativePath}`);
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
  invalidateResolverCache();
}

// --- Concurrent-edit safety: versions, content cache, and three-way merge ----
//
// Two sessions can edit the same note in overlapping requests. `vault_read` hands back a
// content-addressed "version" (a hash) and remembers the text behind it; `updateNote`
// accepts that version back and, if the note changed underneath the caller, three-way
// merges the caller's text against the current file using the remembered base. Edits that
// don't overlap both land; edits that genuinely conflict are rejected instead of silently
// overwriting the other session's work.

// Thrown by updateNote when a concurrent change can't be merged automatically. Typed (like
// VaultPolicyError) so the tool layer can turn it into a friendly isError result.
export class ConcurrentEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConcurrentEditError';
  }
}

// Content-addressed cache of recently seen note bodies: version hash -> exact text. The
// hash IS the version string handed to agents, so identical content always maps to one
// entry. Bounded with simple FIFO eviction — losing an old base just means a stale-base
// update falls back to a reject-and-reread instead of an automatic merge.
const VERSION_CACHE_LIMIT = 200;
const versionCache = new Map<string, string>();

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

// Hash `content`, remember it for later merges, and return the version string.
export function recordVersion(content: string): string {
  const version = hashContent(content);
  if (!versionCache.has(version)) {
    versionCache.set(version, content);
    if (versionCache.size > VERSION_CACHE_LIMIT) {
      const oldest = versionCache.keys().next().value;
      if (oldest !== undefined) versionCache.delete(oldest);
    }
  }
  return version;
}

export interface UpdateResult {
  version: string; // version of the content now on disk
  merged: boolean; // true if a three-way merge combined concurrent changes
}

// Replace a note's full content, merging with any concurrent change when possible.
//
// Without `baseVersion` this is a plain overwrite (preserves the original vault_update
// behavior for callers that didn't read first). With `baseVersion` it runs under a per-path
// lock and:
//   - writes directly if the file is new or unchanged since the caller read it;
//   - otherwise three-way merges the caller's text against the current file using the
//     remembered base, writing the result when the edits don't overlap;
//   - throws ConcurrentEditError when the base is no longer cached, the note is too large to
//     merge safely, or the edits genuinely conflict.
export async function updateNote(
  relativePath: string,
  content: string,
  baseVersion?: string,
): Promise<UpdateResult> {
  assertWritable();
  const absPath = resolveSafePath(relativePath);

  return withPathLock(absPath, async () => {
    let current: string | null;
    try {
      current = await fs.readFile(absPath, 'utf-8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') current = null;
      else throw e;
    }

    if (current === null) {
      // The note doesn't exist. If the caller supplied a base version they read an existing
      // note that has since been deleted — surface that rather than silently recreating it.
      if (baseVersion !== undefined) {
        throw new ConcurrentEditError(
          `"${relativePath}" no longer exists — it was deleted or moved since you read it. If you intend to recreate it, call vault_update again without base_version (or vault_create).`,
        );
      }
      // No base version: plain create.
      await fs.mkdir(path.dirname(absPath), { recursive: true });
      await fs.writeFile(absPath, content, 'utf-8');
      invalidateResolverCache();
      return { version: recordVersion(content), merged: false };
    }

    // Caller opted out of the version check: straight overwrite of the existing note.
    if (baseVersion === undefined) {
      await fs.writeFile(absPath, content, 'utf-8');
      invalidateResolverCache();
      return { version: recordVersion(content), merged: false };
    }

    // The note is byte-identical to what the caller last read: their overwrite is exactly
    // what they intend, so apply it without merging.
    if (hashContent(current) === baseVersion) {
      await fs.writeFile(absPath, content, 'utf-8');
      invalidateResolverCache();
      return { version: recordVersion(content), merged: false };
    }

    // The note changed since the caller read it. We need the exact text they based their
    // edit on to merge safely.
    const base = versionCache.get(baseVersion);
    if (base === undefined) {
      throw new ConcurrentEditError(
        `"${relativePath}" changed since you last read it, and the version you based your edit on (${baseVersion}) is no longer available to merge. Re-read the note and reapply your change to the current text.`,
      );
    }

    // Guard the O(n*m) merge against pathologically large notes (the LCS allocates an n*m
    // matrix). >= so a note at exactly the cap is rejected rather than allocating at the limit.
    const tooLarge = [base, current, content].some(t => t.split('\n').length >= MERGE_MAX_LINES);
    if (tooLarge) {
      throw new ConcurrentEditError(
        `"${relativePath}" changed since you last read it and is too large to merge automatically. Re-read the note and reapply your change to the current text.`,
      );
    }

    const result = threeWayMerge(base, current, content);
    if (!result.clean) {
      throw new ConcurrentEditError(
        `"${relativePath}" was changed by another session in the same place(s) you edited, so it can't be merged automatically without losing work. Re-read the note and reapply your change.\n\n${summarizeConflicts(result.conflicts)}`,
      );
    }

    await fs.writeFile(absPath, result.text, 'utf-8');
    invalidateResolverCache();
    return { version: recordVersion(result.text), merged: true };
  });
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
  const absPath = resolveSafePath(relativePath);
  // Lock the read-modify-write so a concurrent edit to the same note can't interleave
  // between reading the body and writing the updated frontmatter (Race A).
  await withPathLock(absPath, async () => {
    const content = await readNote(relativePath);
    const { body } = splitFrontmatter(content);
    const frontmatter = parseFrontmatter(content) ?? {};
    frontmatter[name] = value;
    await writeNote(relativePath, serializeFrontmatter(frontmatter, body));
  });
}

// Locked like the other writers: O_APPEND is atomic against other appends, but NOT against
// a read-modify-write writer that read the file before this append landed — without the
// lock, that writer would overwrite the appended bytes. Taking the same per-path lock
// serializes appends with updateNote/editNoteSection/etc. so no write is lost.
export async function appendNote(relativePath: string, content: string): Promise<void> {
  assertWritable();
  const absPath = resolveSafePath(relativePath);
  await withPathLock(absPath, async () => {
    await fs.appendFile(absPath, content, 'utf-8');
  });
}

// Insert content at the very start of a note. Locked so the read and write are atomic.
export async function prependToNote(relativePath: string, content: string): Promise<void> {
  assertWritable();
  const absPath = resolveSafePath(relativePath);
  await withPathLock(absPath, async () => {
    const existing = await fs.readFile(absPath, 'utf-8');
    await fs.writeFile(absPath, content + existing, 'utf-8');
  });
  invalidateResolverCache();
}

// Replace the first occurrence of `find` with `content`. Locked so the read and write are
// atomic; because it reads the current file at write time, concurrent changes elsewhere in
// the note are preserved. If `find` is absent the note is rewritten unchanged.
export async function replaceInNote(relativePath: string, find: string, content: string): Promise<void> {
  assertWritable();
  const absPath = resolveSafePath(relativePath);
  await withPathLock(absPath, async () => {
    const existing = await fs.readFile(absPath, 'utf-8');
    // Function replacer keeps `content` literal — a plain string replacement would interpret
    // $&, $1, $$ etc. in the agent's content as special replacement patterns.
    await fs.writeFile(absPath, existing.replace(find, () => content), 'utf-8');
  });
  invalidateResolverCache();
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
  invalidateResolverCache();
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
export interface VaultFolderEntry {
  name: string;
  path: string;
  kind: 'file' | 'directory';
}

// Folders only, walked from the vault root up to maxDepth levels (1 = top-level only).
// Skips dotfiles and .mcpignore-blocked paths. Returned lines are markdown bullets indented
// by depth so the tree can be inlined into a text response.
//
// Subtrees at each level are read in parallel via Promise.all so wall time is bounded by the
// deepest branch rather than the total folder count.
export async function getFolderTree(maxDepth: number): Promise<string[]> {
  if (maxDepth <= 0) return [];

  async function buildSubtree(absDir: string, depth: number): Promise<string[]> {
    if (depth > maxDepth) return [];
    const entries = await fs.readdir(absDir, { withFileTypes: true });
    const dirs = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => ({ name: e.name, abs: path.join(absDir, e.name) }))
      .filter(e => !isIgnored(e.abs))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

    const childTrees = await Promise.all(dirs.map(d => buildSubtree(d.abs, depth + 1)));

    const out: string[] = [];
    for (let i = 0; i < dirs.length; i++) {
      out.push(`${'  '.repeat(depth - 1)}- ${dirs[i].name}/`);
      out.push(...childTrees[i]);
    }
    return out;
  }

  return buildSubtree(VAULT_ROOT, 1);
}

// Immediate children of a vault folder (non-recursive). Skips dotfiles and .mcpignore-blocked paths.
export async function listVaultFolder(relativeDir = '', limit = 200): Promise<VaultFolderEntry[]> {
  const normalized = relativeDir.trim() === '' ? '.' : relativeDir;
  const absDir = resolveSafePath(normalized);
  const st = await fs.stat(absDir);
  if (!st.isDirectory()) {
    throw new Error(`Not a directory: ${relativeDir || '.'}`);
  }
  const entries = await fs.readdir(absDir, { withFileTypes: true });
  const out: VaultFolderEntry[] = [];
  const max = limit > 0 ? limit : Number.POSITIVE_INFINITY;
  for (const entry of entries) {
    if (out.length >= max) break;
    if (entry.name.startsWith('.')) continue;
    const childAbs = path.join(absDir, entry.name);
    if (isIgnored(childAbs)) continue;
    out.push({
      name: entry.name,
      path: path.relative(VAULT_ROOT, childAbs),
      kind: entry.isDirectory() ? 'directory' : 'file',
    });
  }
  out.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
  return out;
}

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

// Locate a heading section by case-insensitive heading text. Returns the
// startIdx (heading line) and endIdx (first line of the next same-or-higher
// heading, or lines.length). Returns null when the heading is missing.
function findSectionBounds(
  lines: string[],
  heading: string,
): { startIdx: number; endIdx: number } | null {
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

  if (startIdx === -1) return null;

  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,6})\s/);
    if (match && match[1].length <= headingLevel) {
      endIdx = i;
      break;
    }
  }

  return { startIdx, endIdx };
}

// Read a single heading section from a note (the heading line through the next
// same-or-higher-level heading). Heading match is case-insensitive, without the # prefix.
export async function readNoteSection(relativePath: string, heading: string): Promise<string> {
  const content = await readNote(relativePath);
  const lines = content.split('\n');
  const bounds = findSectionBounds(lines, heading);
  if (!bounds) {
    throw new Error(`Heading "${heading}" not found in ${relativePath}`);
  }
  return lines.slice(bounds.startIdx, bounds.endIdx).join('\n');
}

// --- Section editing ---------------------------------------------------------

// Edit a single heading section in-place. Operations:
//  - replace: replace the section body (keeps the heading line itself)
//  - prepend: insert content right after the heading line, before existing body
//  - append:  insert content at the end of the section, before the next heading
// Body lines are kept verbatim; the caller controls leading/trailing newlines in `content`.
export async function editNoteSection(
  relativePath: string,
  heading: string,
  operation: 'append' | 'prepend' | 'replace',
  content: string,
): Promise<void> {
  assertWritable();
  const absPath = resolveSafePath(relativePath);
  // Lock the read-modify-write so a concurrent edit to the same note can't interleave
  // between reading the section and writing it back (Race A).
  await withPathLock(absPath, async () => {
    const existing = await fs.readFile(absPath, 'utf-8');
    await fs.writeFile(absPath, applySectionEdit(existing, heading, operation, content, relativePath), 'utf-8');
  });
  invalidateResolverCache();
}

// Pure section splice: given the full note text, return it with the named section edited.
// Throws if the heading is missing. Kept separate from I/O so the transform is easy to test
// and so editNoteSection can run it inside a single locked read-write.
function applySectionEdit(
  existing: string,
  heading: string,
  operation: 'append' | 'prepend' | 'replace',
  content: string,
  relativePath: string,
): string {
  const lines = existing.split('\n');
  const bounds = findSectionBounds(lines, heading);
  if (!bounds) {
    throw new Error(`Heading "${heading}" not found in ${relativePath}`);
  }

  const { startIdx, endIdx } = bounds;
  const before = lines.slice(0, startIdx);
  const headingLine = lines[startIdx];
  const body = lines.slice(startIdx + 1, endIdx);
  const after = lines.slice(endIdx);
  const contentLines = content.split('\n');

  // The trailing blank line(s) in `body` are the structural separator between
  // this section and whatever follows (next heading or EOF). Preserve them
  // across all three operations so edits don't collapse the section boundary.
  // Internal spacing between caller content and existing body is the caller's
  // responsibility — they control it via newlines in `content`.
  let trailingBlankCount = 0;
  while (
    trailingBlankCount < body.length &&
    body[body.length - 1 - trailingBlankCount] === ''
  ) {
    trailingBlankCount++;
  }
  const bodyContent = body.slice(0, body.length - trailingBlankCount);
  const trailingBlanks = body.slice(body.length - trailingBlankCount);

  let newBody: string[];
  if (operation === 'replace') {
    newBody = [...contentLines, ...trailingBlanks];
  } else if (operation === 'prepend') {
    newBody = [...contentLines, ...bodyContent, ...trailingBlanks];
  } else {
    newBody = [...bodyContent, ...contentLines, ...trailingBlanks];
  }

  return [...before, headingLine, ...newBody, ...after].join('\n');
}

// --- Note reference resolution -----------------------------------------------

// Accepts either a full vault-relative path (with or without .md) or a bare note
// title and returns the matching vault file. The cached title index here is the
// "title → relpath" view of the vault built from filename walks; it's recomputed
// on a short TTL so bursty agent sessions don't pay per-call walk costs.

export interface ResolvedReference {
  path: string; // vault-relative path with .md
  candidates?: string[]; // present only when multiple titles matched; candidates[0] === path
  matchedVia: 'path' | 'title';
}

const DEFAULT_RESOLVE_INDEX_TTL_MS = 30000;

let titleIndexCache: { map: Map<string, string[]>; builtAt: number } | null = null;

function getResolveIndexTtlMs(): number {
  const raw = Number(process.env.RESOLVE_INDEX_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RESOLVE_INDEX_TTL_MS;
}

export function invalidateResolverCache(): void {
  titleIndexCache = null;
}

// Filename-only walk that collects every basename's relpath. Entries are sorted
// before recursion so "first match wins" is deterministic across filesystems.
async function buildResolverTitleIndex(): Promise<Map<string, string[]>> {
  const index = new Map<string, string[]>();

  async function walk(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      if (isIgnored(fullPath)) continue;
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (/\.md$/i.test(entry.name)) {
        const key = entry.name.slice(0, -3).toLowerCase();
        const rel = path.relative(VAULT_ROOT, fullPath);
        const existing = index.get(key);
        if (existing) existing.push(rel);
        else index.set(key, [rel]);
      }
    }
  }

  await walk(VAULT_ROOT);
  return index;
}

async function getResolverTitleIndex(): Promise<Map<string, string[]>> {
  const ttl = getResolveIndexTtlMs();
  if (titleIndexCache && Date.now() - titleIndexCache.builtAt < ttl) {
    return titleIndexCache.map;
  }
  const map = await buildResolverTitleIndex();
  titleIndexCache = { map, builtAt: Date.now() };
  return map;
}

// resolveSafePath throws a typed VaultPolicyError for path-escape or .mcpignore
// violations; those must propagate unchanged. Only ENOENT/ENOTDIR from a
// follow-up stat fall through to subsequent resolution steps.
async function statOrNull(relativePath: string): Promise<import('fs').Stats | null> {
  try {
    const abs = resolveSafePath(relativePath);
    return await fs.stat(abs);
  } catch (e) {
    if (e instanceof VaultPolicyError) throw e;
    const err = e as NodeJS.ErrnoException;
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return null;
    throw e;
  }
}

export async function resolveNoteReference(input: string): Promise<ResolvedReference> {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (trimmed === '') {
    throw new Error('Empty note reference');
  }

  const hasMdSuffix = /\.md$/i.test(trimmed);

  // Step 1: stat the input as-given. If it's a directory, surface EISDIR with
  // the "use mode list" affordance. Only return it as a path match if it ends
  // in .md — non-.md files (e.g. binaries, plain text) are not notes and must
  // not be returned as if they were.
  const asGivenStat = await statOrNull(trimmed);
  if (asGivenStat) {
    if (asGivenStat.isDirectory()) {
      const err = new Error(`"${trimmed}" is a directory, not a note.`) as NodeJS.ErrnoException;
      err.code = 'EISDIR';
      throw err;
    }
    if (asGivenStat.isFile() && hasMdSuffix) {
      return { path: trimmed, matchedVia: 'path' };
    }
  }

  // Step 2: append .md and try again. Handles the common "user passed a relpath
  // without the .md suffix" case.
  if (!hasMdSuffix) {
    const normalized = `${trimmed}.md`;
    const stat = await statOrNull(normalized);
    if (stat?.isFile()) {
      return { path: normalized, matchedVia: 'path' };
    }
  }

  // Step 3: title lookup. Only meaningful when the input has no path separator —
  // titles don't contain slashes, so "Notes/Foo" can never match a title key.
  if (!trimmed.includes('/')) {
    const key = (hasMdSuffix ? trimmed.slice(0, -3) : trimmed).toLowerCase();
    const index = await getResolverTitleIndex();
    const matches = index.get(key);
    if (matches && matches.length > 0) {
      if (matches.length === 1) {
        return { path: matches[0]!, matchedVia: 'title' };
      }
      return { path: matches[0]!, candidates: matches.slice(), matchedVia: 'title' };
    }
  }

  throw new Error(
    `Could not resolve "${input}" to a note. Try a full vault-relative path or call vault_search_title to discover it.`,
  );
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
