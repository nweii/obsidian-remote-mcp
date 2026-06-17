// ABOUTME: Filesystem operations for the configured Obsidian vault - safe path resolution, read/write/search, list folder.
import fs from 'fs/promises';
import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { load as parseYaml, dump as stringifyYaml } from 'js-yaml';
import path from 'path';
import { fileURLToPath } from 'url';
import { withPathLock } from './lock.js';
import { isoWeek, isoWeekYear, startOfIsoWeek, startOfMonth, startOfQuarter, startOfYear } from './date.js';

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

// --- Attachments (binary reads) ----------------------------------------------

// Extension → MIME type for attachment reads. Explicit and small on purpose — no
// dependency, and only the types worth exposing over MCP. Image types here are the
// ones that round-trip as an MCP `image` content block; everything else comes back
// as base64 with metadata in a text block.
const ATTACHMENT_MIME_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  zip: 'application/zip',
};

const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

// Default size cap for attachment reads. Base64 inflates the payload by about a third
// and the result lands in model context, so files over this are rejected rather than read.
const DEFAULT_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

function attachmentMaxBytes(): number {
  const raw = Number(process.env.VAULT_ATTACHMENT_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_ATTACHMENT_MAX_BYTES;
}

function mimeTypeFor(relativePath: string): string {
  const ext = path.extname(relativePath).slice(1).toLowerCase();
  return ATTACHMENT_MIME_TYPES[ext] ?? 'application/octet-stream';
}

// Thrown by readAttachment when the file is larger than the configured cap. Carries the
// actual and max sizes so the tool layer can name the real size in its error.
export class AttachmentTooLargeError extends Error {
  constructor(public readonly bytes: number, public readonly maxBytes: number, message: string) {
    super(message);
    this.name = 'AttachmentTooLargeError';
  }
}

export interface AttachmentResult {
  mimeType: string;
  bytes: number;       // size on disk
  isImage: boolean;    // true for the image types that render as an MCP image block
  data?: string;       // base64 payload; omitted when statOnly is true
}

// Read a binary attachment from the vault. Path sandboxing and .mcpignore are enforced via
// resolveSafePath, mirroring note reads. With statOnly, returns size + mime without reading
// the bytes so an agent can check before pulling a large file. Throws AttachmentTooLargeError
// when the file exceeds the cap (skipped for statOnly, which never loads the payload).
export async function readAttachment(
  relativePath: string,
  statOnly = false,
): Promise<AttachmentResult> {
  const absPath = resolveSafePath(relativePath);
  const st = await fs.stat(absPath);
  if (st.isDirectory()) {
    const err = new Error(`"${relativePath}" is a directory, not a file.`) as NodeJS.ErrnoException;
    err.code = 'EISDIR';
    throw err;
  }

  const mimeType = mimeTypeFor(relativePath);
  const isImage = IMAGE_MIME_TYPES.has(mimeType);

  if (statOnly) {
    return { mimeType, bytes: st.size, isImage };
  }

  const max = attachmentMaxBytes();
  if (st.size > max) {
    throw new AttachmentTooLargeError(
      st.size,
      max,
      `Attachment "${relativePath}" is ${st.size} bytes, over the ${max}-byte cap. Use stat_only to inspect it without reading, or raise VAULT_ATTACHMENT_MAX_BYTES.`,
    );
  }

  const buf = await fs.readFile(absPath);
  return { mimeType, bytes: st.size, isImage, data: buf.toString('base64') };
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

// Monotonic counter so two atomic writes starting in the same millisecond still get distinct
// temp names. Combined with the pid, a temp-name collision is effectively impossible.
let atomicWriteCounter = 0;

// The mode bits of an existing file, or null if it doesn't exist. Used to carry a note's
// permissions across an atomic overwrite, which swaps in a fresh inode.
async function fileModeOrNull(absPath: string): Promise<number | null> {
  try {
    const stat = await fs.stat(absPath);
    return stat.mode & 0o777;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

// Write `content` to `absPath` atomically. The bytes go to a temp file in the SAME directory,
// are flushed to disk, then renamed over the target. A rename within a directory is atomic on
// POSIX, so any reader - Obsidian, Obsidian Sync, another tool call - sees either the old bytes
// or the new bytes, never a half-written mix. Writing straight to the target with fs.writeFile
// truncates it first, so a crash or an interleaved read mid-write can expose a zero-length or
// torn file, which Obsidian Sync would then propagate to every device.
//
// The temp file is hidden (leading dot) so Obsidian ignores it and Sync won't propagate it, and
// it carries the original basename plus a unique suffix. The content is fsynced before the
// rename so a power loss can't make the new name point at unflushed bytes. If the target already
// exists its mode is copied onto the temp file first, since replacing the inode would otherwise
// reset the note's permissions. On any failure the temp file is removed so a failed write never
// litters the vault.
async function atomicWriteFile(absPath: string, content: string): Promise<void> {
  const dir = path.dirname(absPath);
  const tmpPath = path.join(
    dir,
    `.${path.basename(absPath)}.${process.pid}.${Date.now()}.${atomicWriteCounter++}.tmp`,
  );
  const handle = await fs.open(tmpPath, 'w');
  try {
    try {
      await handle.writeFile(content, 'utf-8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    // Carry the target's mode onto the temp file before the swap. Best-effort: preserving the
    // note's permissions is a nicety and must never be the thing that blocks the write.
    const targetMode = await fileModeOrNull(absPath);
    if (targetMode !== null) {
      try {
        await fs.chmod(tmpPath, targetMode);
      } catch {
        // Keep the temp file's default mode rather than failing an otherwise-good write.
      }
    }
    await fs.rename(tmpPath, absPath);
  } catch (e) {
    // Any failure after the temp file was opened — write, fsync, chmod, or rename — removes it so
    // a failed write never leaves a stray temp file in the vault.
    await fs.rm(tmpPath, { force: true });
    throw e;
  }
}

export async function writeNote(relativePath: string, content: string): Promise<void> {
  assertWritable();
  const absPath = resolveSafePath(relativePath);
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await atomicWriteFile(absPath, content);
  invalidateResolverCache();
}

// Thrown by createNote when a note already exists at the target path. Typed so the tool layer
// can turn it into a friendly isError result with caller-appropriate guidance.
export class NoteExistsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoteExistsError';
  }
}

// Write a new note, refusing to overwrite one that already exists. Single source of truth for
// the "create, don't clobber" guard shared by vault_create and the clip save-path.
export async function createNote(relativePath: string, content: string): Promise<void> {
  try {
    await readNote(relativePath);
  } catch {
    await writeNote(relativePath, content);
    return;
  }
  throw new NoteExistsError(`File already exists at ${relativePath}`);
}

// --- Concurrent-edit safety: optimistic versioning ---------------------------
//
// Two sessions can edit the same note in overlapping requests. `vault_read` hands back a
// content-addressed "version" (a hash of the note text); `updateNote` accepts that version
// back as `baseVersion`. If the note changed since the caller read it, the update is rejected
// with a ConcurrentEditError ("re-read and retry") instead of silently overwriting the other
// session's work. Omitting `baseVersion` keeps the old last-writer-wins overwrite.

// Thrown by updateNote when the note changed under the caller. Typed (like VaultPolicyError)
// so the tool layer can turn it into a friendly isError result.
export class ConcurrentEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConcurrentEditError';
  }
}

// Content-addressed version string for a note's text. Identical content always hashes to the
// same value, so a caller's version matches iff the on-disk bytes are unchanged.
export function versionOf(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

export interface UpdateResult {
  version: string; // version of the content now on disk
}

// Replace a note's full content. Without `baseVersion` this is a plain overwrite (preserves
// the original vault_update behavior for callers that didn't read first). With `baseVersion`
// it runs under a per-path lock and rejects with ConcurrentEditError if the note was changed
// or deleted since the caller read it, so a concurrent edit is never silently clobbered.
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
      await atomicWriteFile(absPath, content);
      invalidateResolverCache();
      return { version: versionOf(content) };
    }

    // The note changed since the caller read it: reject rather than overwrite the other edit.
    if (baseVersion !== undefined && versionOf(current) !== baseVersion) {
      throw new ConcurrentEditError(
        `"${relativePath}" changed since you last read it, so overwriting it would discard another session's edit. Re-read the note and reapply your change to the current text.`,
      );
    }

    // No base version (opted out), or the note is unchanged since the caller read it.
    await atomicWriteFile(absPath, content);
    invalidateResolverCache();
    return { version: versionOf(content) };
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
  await setFrontmatterProperties(relativePath, { [name]: value });
}

// Set several frontmatter properties on a note in one locked read-modify-write. Each key is
// spliced individually (see setFrontmatterKey), so untouched keys keep their on-disk byte form
// and only the named keys change. Holding the lock across the whole sequence keeps a concurrent
// edit to the same note from interleaving between the read and the write. An empty fields object
// is a no-op, so the file is never rewritten (and never churned through Obsidian Sync) for nothing.
export async function setFrontmatterProperties(
  relativePath: string,
  fields: Record<string, unknown>,
): Promise<void> {
  assertWritable();
  if (Object.keys(fields).length === 0) return;
  const absPath = resolveSafePath(relativePath);
  await withPathLock(absPath, async () => {
    let content = await readNote(relativePath);
    for (const [name, value] of Object.entries(fields)) {
      content = setFrontmatterKey(content, name, coerceFrontmatterValue(value));
    }
    await writeNote(relativePath, content);
  });
}

// --- Batch operations --------------------------------------------------------
//
// Both batch helpers are per-item and non-transactional: one bad entry is reported in the result
// and never aborts the others. They compose the same single-note primitives (resolution, read,
// frontmatter splice, per-path lock) the individual tools use, so batching changes only the
// round-trip count, not the read/write semantics.

export interface BatchReadItem {
  path: string;                          // resolved vault-relative path
  frontmatter: Record<string, unknown> | null;
  version?: string;                      // content hash for base_version; set only when content is included
  content?: string;                      // included only when requested
}

export interface BatchReadFailure {
  reference: string;                     // the input that could not be resolved or read
  error: string;
}

export interface BatchReadResult {
  found: BatchReadItem[];
  missing: BatchReadFailure[];
}

// Read several notes in one call. References resolve like vault_read (path or bare title); each
// failure is collected in `missing` instead of throwing. With includeContent false, bodies are
// omitted so an agent can triage many notes by frontmatter cheaply before opening any.
export async function readNotesBatch(
  references: string[],
  includeContent: boolean,
): Promise<BatchReadResult> {
  const found: BatchReadItem[] = [];
  const missing: BatchReadFailure[] = [];
  for (const reference of references) {
    try {
      const ref = await resolveNoteReference(reference);
      const content = await readNote(ref.path);
      const item: BatchReadItem = {
        path: ref.path,
        frontmatter: parseFrontmatter(content),
      };
      // The version anchors a later vault_update; it only makes sense next to the content the
      // caller would edit, so skip the hash entirely in frontmatter-only triage mode.
      if (includeContent) {
        item.content = content;
        item.version = versionOf(content);
      }
      found.push(item);
    } catch (e) {
      missing.push({ reference, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { found, missing };
}

export interface BatchFrontmatterUpdate {
  path: string;
  fields: Record<string, unknown>;
}

export interface BatchUpdateOutcome {
  path: string;
  updated: boolean;
  error?: string;
}

// Apply frontmatter property updates to several notes. Each note's fields are set in one locked
// read-modify-write via setFrontmatterProperties; a failure on one note is recorded and the rest
// still run. Paths are explicit vault-relative paths, matching vault_set_frontmatter_property.
export async function updateFrontmatterBatch(
  updates: BatchFrontmatterUpdate[],
): Promise<BatchUpdateOutcome[]> {
  const outcomes: BatchUpdateOutcome[] = [];
  for (const update of updates) {
    try {
      await setFrontmatterProperties(update.path, update.fields);
      outcomes.push({ path: update.path, updated: true });
    } catch (e) {
      outcomes.push({ path: update.path, updated: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return outcomes;
}

// If a client serialized an array or object as a JSON string before sending (because
// the MCP tool's input schema didn't pin the shape), parse it back so YAML emits a
// proper sequence/map instead of folding the long quoted string. Plain strings that
// happen to look bracket-ish but aren't valid JSON pass through as literals — a
// property value of `[draft]` is legitimate text.
function coerceFrontmatterValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  const looksLikeJson =
    (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
    (trimmed.startsWith('{') && trimmed.endsWith('}'));
  if (!looksLikeJson) return value;
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed) || (typeof parsed === 'object' && parsed !== null)) {
      return parsed;
    }
  } catch {
    // Not JSON after all — keep as the literal string the caller sent.
  }
  return value;
}

// Textual single-key edit on the frontmatter block. Splices over just the target
// key's lines and leaves every other byte intact — so untouched dates, quoting
// styles, key order, comments, and blank lines all survive a one-property write.
// For JSON-shaped frontmatter (the `---\n{ ... }\n---` form) we fall back to
// parse-and-reserialize, matching Obsidian's own "JSON read, YAML write" behavior
// documented at https://help.obsidian.md/properties#JSON+properties.
function setFrontmatterKey(content: string, key: string, value: unknown): string {
  const { frontmatter, body } = splitFrontmatter(content);
  const rendered = stringifyYaml({ [key]: value }, { lineWidth: 0, noRefs: true })
    .replace(/\n+$/, '');

  if (frontmatter === null) {
    return `---\n${rendered}\n---\n${content}`;
  }

  if (isJsonFrontmatter(frontmatter)) {
    const data = parseFrontmatter(content) ?? {};
    data[key] = value;
    return serializeFrontmatter(data, body);
  }

  const fmLines = frontmatter.split('\n');
  const region = findFrontmatterKeyRegion(fmLines, key);
  const renderedLines = rendered.split('\n');

  let nextLines: string[];
  if (region) {
    nextLines = [
      ...fmLines.slice(0, region.start),
      ...renderedLines,
      ...fmLines.slice(region.end + 1),
    ];
  } else {
    let tail = fmLines.length;
    while (tail > 0 && fmLines[tail - 1] === '') tail--;
    nextLines = [...fmLines.slice(0, tail), ...renderedLines, ...fmLines.slice(tail)];
  }

  return `---\n${nextLines.join('\n')}\n---\n${body}`;
}

function isJsonFrontmatter(frontmatter: string): boolean {
  return frontmatter.trimStart().startsWith('{');
}

// A top-level key line in the frontmatter block has no leading whitespace, isn't
// a comment, and matches `name:` (with the name allowed to contain spaces). The
// key's region extends through any indented continuation lines (list items,
// block scalars, nested maps). Blank lines and comments terminate the region
// without being claimed by it — they belong between keys, not inside one.
function findFrontmatterKeyRegion(
  lines: string[],
  key: string,
): { start: number; end: number } | null {
  for (let i = 0; i < lines.length; i++) {
    if (parseTopLevelKey(lines[i]) !== key) continue;
    let end = i;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^[ \t]/.test(lines[j])) {
        end = j;
        continue;
      }
      break;
    }
    return { start: i, end };
  }
  return null;
}

function parseTopLevelKey(line: string): string | null {
  if (line.length === 0 || /^[\s#]/.test(line)) return null;
  const m = line.match(/^([^:]+?)\s*:(\s|$)/);
  if (!m) return null;
  const raw = m[1];
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  return raw;
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
    await atomicWriteFile(absPath, content + existing);
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
    await atomicWriteFile(absPath, existing.replace(find, () => content));
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

export interface MoveResult {
  from: string; // vault-relative source path
  to: string;   // vault-relative destination path
}

// Move or rename a file within the vault. source and destination are explicit vault-relative
// paths — bare titles are not resolved here, since a move is a mutation and title ambiguity is
// exactly what we don't want at the destination. Works on any file type (notes, canvases, bases,
// attachments); the rename mechanics are identical. Creates missing parent folders and refuses
// to overwrite an existing destination. Honors .mcpignore and read-only mode on both paths via
// resolveSafePath/assertWritable, and serializes through the same per-path locks as other writes.
// Returns the from/to paths so a later link-rewriting pass can act on them.
export async function moveFile(source: string, destination: string): Promise<MoveResult> {
  assertWritable();
  const fromAbs = resolveSafePath(source);
  const toAbs = resolveSafePath(destination);

  // A missing source would surface as a raw ENOENT from fs.rename, whose message embeds
  // absolute filesystem paths. Check up front and fail with the vault-relative path instead.
  if (!pathExists(fromAbs)) {
    throw new Error(`No file found at "${source}".`);
  }

  // Source and destination resolving to the same file is a no-op move; reject it up front
  // rather than deadlocking on the same lock key below or silently doing nothing.
  if (fromAbs === toAbs) {
    throw new Error(`Source and destination are the same path ("${source}").`);
  }

  // Lock both paths so a concurrent write to either can't interleave with the rename. Take them
  // in sorted order so two moves touching the same pair can't deadlock by acquiring in opposite order.
  const [firstLock, secondLock] = [fromAbs, toAbs].sort();
  return withPathLock(firstLock, () =>
    withPathLock(secondLock, async () => {
      if (pathExists(toAbs)) {
        throw new NoteExistsError(`File already exists at ${destination}`);
      }
      await fs.mkdir(path.dirname(toAbs), { recursive: true });
      await fs.rename(fromAbs, toAbs);
      invalidateResolverCache();
      return { from: source, to: destination };
    }),
  );
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

export type FrontmatterMatchType = 'exact' | 'contains' | 'exists';

export interface FrontmatterSearchOptions {
  value?: string;                    // required for 'exact'/'contains'; ignored for 'exists'
  matchType?: FrontmatterMatchType;  // defaults to 'exact'
  folder?: string;                   // scope the scan to a subfolder; defaults to vault root
  limit?: number;                    // max matching notes; default 20, 0 = no limit
}

export interface FrontmatterSearchResult {
  path: string;                          // vault-relative path
  title: string;                         // frontmatter title, else filename without .md
  frontmatter: Record<string, unknown>;  // the note's full parsed frontmatter
}

// Canonical string form of a frontmatter value for matching. js-yaml parses an unquoted ISO-8601
// scalar (e.g. `due: 2026-01-15`) into a Date; `String(Date)` would render the timezone-shifted JS
// locale string ("Wed Jan 14 2026 19:00:00 GMT-0500 ..."), which is unmatchable and can even land
// on the wrong day. Rendering a Date as its UTC calendar date (`YYYY-MM-DD`) reconstructs what the
// user typed, so `exact: 2026-01-15` matches; a datetime matches by its date. This isn't an ISO
// requirement — any other date convention stays a plain string and is matched verbatim by String().
export function frontmatterValueToString(v: unknown): string {
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
}

// Does a note's frontmatter value satisfy the predicate? For a list field the test is applied
// per element (real membership), so `contains: draft` matches `tags: [draft, idea]` and
// `exact: idea` matches it too — unlike a substring test against the stringified list. `exists`
// is decided by the caller (the key being present), so it always passes here.
function frontmatterValueMatches(
  fieldValue: unknown,
  matchType: FrontmatterMatchType,
  value: string | undefined,
): boolean {
  if (matchType === 'exists') return true;
  if (value === undefined) return false;
  const test = (v: unknown): boolean =>
    matchType === 'exact'
      ? frontmatterValueToString(v) === value
      : frontmatterValueToString(v).toLowerCase().includes(value.toLowerCase());
  return Array.isArray(fieldValue) ? fieldValue.some(test) : test(fieldValue);
}

// Find notes whose frontmatter has `field`, optionally constrained by value/matchType. Walks the
// vault (or a folder) once, parsing each note's frontmatter — stateless, no persistent index, so
// it stays consistent with the per-request server. Reuses the scanTags traversal: skips dotfiles,
// honours .mcpignore, reads only .md files. Notes without frontmatter, or without `field`, are
// skipped before the predicate runs.
export async function searchFrontmatter(
  field: string,
  options: FrontmatterSearchOptions = {},
): Promise<FrontmatterSearchResult[]> {
  const { value, matchType = 'exact', folder, limit = 20 } = options;
  const root = folder ? resolveSafePath(folder) : VAULT_ROOT;
  const maxResults = limit > 0 ? limit : Number.POSITIVE_INFINITY;
  const results: FrontmatterSearchResult[] = [];

  async function walk(dir: string) {
    if (results.length >= maxResults) return;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= maxResults) break;
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      if (isIgnored(fullPath)) continue;
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.name.endsWith('.md')) continue;
      let content: string;
      try {
        content = await fs.readFile(fullPath, 'utf-8');
      } catch {
        continue; // skip unreadable files (e.g. permission denied)
      }
      const frontmatter = parseFrontmatter(content);
      if (!frontmatter || !(field in frontmatter)) continue;
      if (!frontmatterValueMatches(frontmatter[field], matchType, value)) continue;
      const rel = path.relative(VAULT_ROOT, fullPath);
      const titleValue = frontmatter.title;
      const title =
        typeof titleValue === 'string' && titleValue.trim() !== ''
          ? titleValue
          : path.basename(rel, '.md');
      results.push({ path: rel, title, frontmatter });
    }
  }

  await walk(root);
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

// Locate every section whose heading matches the target text (case-insensitive).
// Returns each match's startIdx (heading line) and endIdx (first line of the next
// same-or-higher heading, or lines.length). Returns an empty array if no heading
// matches. Callers decide what to do with multiple matches — reads can present all
// of them; writes refuse to guess.
function findAllSectionBounds(
  lines: string[],
  heading: string,
): Array<{ startIdx: number; endIdx: number }> {
  const normalizedTarget = heading.toLowerCase().trim();
  const results: Array<{ startIdx: number; endIdx: number }> = [];

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,6})\s+(.+)/);
    if (!match || match[2].trim().toLowerCase() !== normalizedTarget) continue;
    const headingLevel = match[1].length;

    let endIdx = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j].match(/^(#{1,6})\s/);
      if (next && next[1].length <= headingLevel) {
        endIdx = j;
        break;
      }
    }
    results.push({ startIdx: i, endIdx });
  }

  return results;
}

export type AmbiguousHeadingMatch = {
  startIdx: number;
  preview: string;
};

// Thrown by editNoteSection (and applySectionEdit) when the requested heading
// matches more than one section. Carries enough information for the agent to
// pick a unique anchor and retry via vault_edit. Mirrors the resolveNoteReference
// "surface candidates, don't pick" pattern already used for ambiguous note titles.
export class AmbiguousHeadingError extends Error {
  readonly heading: string;
  readonly relativePath: string;
  readonly matches: AmbiguousHeadingMatch[];

  constructor(opts: {
    relativePath: string;
    heading: string;
    matches: AmbiguousHeadingMatch[];
  }) {
    const candidates = opts.matches
      .map((m, i) => `  ${i + 1}. line ${m.startIdx + 1} — ${m.preview}`)
      .join('\n');
    super(
      `Heading "${opts.heading}" matches ${opts.matches.length} sections in ${opts.relativePath}:\n${candidates}\n` +
        `vault_edit_section can't safely guess which one to edit. Use vault_edit with a find-anchored ` +
        `replace on text unique to the target section, or vault_update for the whole note.`,
    );
    this.name = 'AmbiguousHeadingError';
    this.heading = opts.heading;
    this.relativePath = opts.relativePath;
    this.matches = opts.matches;
  }
}

function previewMatch(lines: string[], startIdx: number, endIdx: number): string {
  const headingLine = lines[startIdx].trim();
  for (let j = startIdx + 1; j < endIdx; j++) {
    const body = lines[j].trim();
    if (body) {
      const snippet = body.length > 80 ? `${body.slice(0, 80)}…` : body;
      return `${headingLine} / ${snippet}`;
    }
  }
  return headingLine;
}

// Read a single heading section from a note (the heading line through the next
// same-or-higher-level heading). Heading match is case-insensitive, without the # prefix.
// If the heading appears more than once in the note, returns every matching section
// joined with `<!-- match N of M (line X) -->` labels — non-destructive, so the agent
// gets to see all the candidates rather than silently being handed the first one.
export async function readNoteSection(relativePath: string, heading: string): Promise<string> {
  const content = await readNote(relativePath);
  const lines = content.split('\n');
  const matches = findAllSectionBounds(lines, heading);
  if (matches.length === 0) {
    throw new Error(`Heading "${heading}" not found in ${relativePath}`);
  }
  if (matches.length === 1) {
    const { startIdx, endIdx } = matches[0];
    return lines.slice(startIdx, endIdx).join('\n');
  }
  return matches
    .map((m, i) => {
      const section = lines.slice(m.startIdx, m.endIdx).join('\n');
      return `<!-- match ${i + 1} of ${matches.length} (line ${m.startIdx + 1}) -->\n${section}`;
    })
    .join('\n\n');
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
    await atomicWriteFile(absPath, applySectionEdit(existing, heading, operation, content, relativePath));
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
  const matches = findAllSectionBounds(lines, heading);
  if (matches.length === 0) {
    throw new Error(`Heading "${heading}" not found in ${relativePath}`);
  }
  if (matches.length > 1) {
    throw new AmbiguousHeadingError({
      relativePath,
      heading,
      matches: matches.map((m) => ({
        startIdx: m.startIdx,
        preview: previewMatch(lines, m.startIdx, m.endIdx),
      })),
    });
  }

  const { startIdx, endIdx } = matches[0];
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

// --- Tags --------------------------------------------------------------------

// A tag and how many notes (and total occurrences) carry it. `tag` is the
// first-seen casing; aggregation is case-insensitive, so two notes writing
// `#Project` and `#project` collapse to one entry under the casing seen first.
export interface TagCount {
  tag: string;
  noteCount: number;
  occurrences: number;
}

// Frontmatter `tags` accepts a YAML array (["a", "b"]) or a comma-delimited
// string ("a, b"). Other shapes (a single bare scalar) are treated as one tag.
// A leading `#` is stripped so `#a` and `a` count the same. Empty entries drop.
function extractFrontmatterTags(frontmatter: Record<string, unknown> | null): string[] {
  const raw = frontmatter?.tags;
  if (raw === undefined || raw === null) return [];
  let parts: string[];
  if (Array.isArray(raw)) {
    parts = raw.map(v => String(v));
  } else if (typeof raw === 'string') {
    parts = raw.split(',');
  } else {
    parts = [String(raw)];
  }
  return parts
    .map(p => p.trim().replace(/^#/, ''))
    .filter(p => p.length > 0);
}

// Strip the regions where a `#` can't start a tag: fenced code blocks (``` or
// ~~~) and inline code spans (backtick runs). Replaced with spaces so column
// positions and line counts are preserved and the inline scanner sees no tags
// inside them.
function blankCodeRegions(body: string): string {
  let out = body.replace(/^(```+|~~~+)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, m =>
    m.replace(/[^\n]/g, ' '),
  );
  out = out.replace(/`+[^`\n]*`+/g, m => m.replace(/[^\n]/g, ' '));
  return out;
}

// Inline `#tag` per Obsidian's rules. A tag is a `#` that is at the start of a
// line or preceded by whitespace (so URL fragments like `example.com#frag` and
// `# headings` don't count — a heading's `#` is followed by a space, never a
// tag char), followed by one or more tag characters. Tag bodies allow letters,
// digits, `_`, `-`, and `/` for nesting; a purely numeric tag (`#123`) is not a
// tag in Obsidian, so at least one non-digit is required.
const INLINE_TAG_REGEX = /(?:^|\s)#([\p{L}\p{N}_\-/]+)/gu;

function extractInlineTags(body: string): string[] {
  const cleaned = blankCodeRegions(body);
  const tags: string[] = [];
  for (const match of cleaned.matchAll(INLINE_TAG_REGEX)) {
    const tag = match[1].replace(/\/+$/, '');
    if (tag.length === 0) continue;
    if (!/[^\d/]/.test(tag)) continue; // all digits/slashes — not a tag
    tags.push(tag);
  }
  return tags;
}

// All tags in one note: frontmatter `tags` plus inline `#tag`. Each distinct
// tag (case-insensitive) is counted once for note-presence and once per raw
// occurrence. Returns the raw (display-cased) tag strings so the caller can
// aggregate first-seen casing across notes.
function collectNoteTags(content: string): string[] {
  const frontmatter = parseFrontmatter(content);
  const { body } = splitFrontmatter(content);
  return [...extractFrontmatterTags(frontmatter), ...extractInlineTags(body)];
}

export interface TagScanOptions {
  folder?: string; // relative path to scope the scan; defaults to vault root
}

// Internal accumulator entry: first-seen display casing, distinct-note count,
// and total occurrences. Keyed by lowercased tag for case-insensitive merge.
interface TagAggregate {
  display: string;
  notePaths: string[];
  occurrences: number;
}

// Single pass over the vault (or a folder), reading each note once and
// aggregating tag counts in memory. Returns the per-tag aggregate keyed by
// lowercased tag. Reuses the searchContent traversal pattern: skips dotfiles,
// honours .mcpignore (via resolveSafePath on the scoped root and isIgnored on
// each entry), and only reads .md files.
async function scanTags(options: TagScanOptions = {}): Promise<Map<string, TagAggregate>> {
  const { folder } = options;
  const root = folder ? resolveSafePath(folder) : VAULT_ROOT;
  const aggregates = new Map<string, TagAggregate>();

  async function walk(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      if (isIgnored(fullPath)) continue;
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.name.endsWith('.md')) continue;
      let content: string;
      try {
        content = await fs.readFile(fullPath, 'utf-8');
      } catch {
        continue; // skip unreadable files (e.g. permission denied)
      }
      const rel = path.relative(VAULT_ROOT, fullPath);
      // Per-note dedupe so one note carrying `#a` twice counts as one note for
      // noteCount but two for occurrences. Keyed by lowercased tag.
      const seenInNote = new Set<string>();
      for (const tag of collectNoteTags(content)) {
        const key = tag.toLowerCase();
        let agg = aggregates.get(key);
        if (!agg) {
          agg = { display: tag, notePaths: [], occurrences: 0 };
          aggregates.set(key, agg);
        }
        agg.occurrences++;
        if (!seenInNote.has(key)) {
          seenInNote.add(key);
          agg.notePaths.push(rel);
        }
      }
    }
  }

  await walk(root);
  return aggregates;
}

// All tags in the vault (or a folder), sorted by note count descending then
// tag name. Counts are case-insensitive; the displayed tag is the first-seen
// casing.
export async function getAllTags(options: TagScanOptions = {}): Promise<TagCount[]> {
  const aggregates = await scanTags(options);
  const counts: TagCount[] = [];
  for (const agg of aggregates.values()) {
    counts.push({ tag: agg.display, noteCount: agg.notePaths.length, occurrences: agg.occurrences });
  }
  counts.sort((a, b) => {
    if (b.noteCount !== a.noteCount) return b.noteCount - a.noteCount;
    return a.tag.localeCompare(b.tag, undefined, { sensitivity: 'base' });
  });
  return counts;
}

// Note paths carrying a specific tag (case-insensitive, exact match — querying
// `parent` does not match `parent/child`). A leading `#` on the query is
// ignored. Paths are returned in walk order (sorted by directory read).
export async function getNotesByTag(tag: string, options: TagScanOptions = {}): Promise<string[]> {
  const key = tag.trim().replace(/^#/, '').toLowerCase();
  const aggregates = await scanTags(options);
  return aggregates.get(key)?.notePaths ?? [];
}

// --- Reference rewriting on move/rename --------------------------------------
//
// When moveFile relocates or renames a file, links pointing at it go stale. This pass scans
// the vault and reports (dry run) or applies (write) the rewrites, matching conservatively:
// it never guesses an ambiguous bare-name link, never touches text inside code, and never
// modifies .base files (it only flags ones that mention the old name/path for manual review).

// One edit to one file: the exact link text before and after the rewrite.
export interface LinkRewrite {
  before: string;
  after: string;
}

// A file with at least one planned/applied rewrite, and the edits it gets.
export interface FileRewrite {
  path: string; // vault-relative
  rewrites: LinkRewrite[];
}

// A bare-name link left untouched because the old basename is ambiguous (shared by another file).
export interface SkippedLink {
  path: string; // vault-relative file containing the link
  link: string; // the link text that was skipped
  reason: string;
}

export interface RewritePlan {
  from: string; // vault-relative source path
  to: string;   // vault-relative destination path
  isRename: boolean; // true when the basename changed (vs. a pure move to a new folder)
  basenameCollision: boolean; // another file shares the old basename, so bare links are ambiguous
  files: FileRewrite[];     // .md and .canvas files with rewrites to make
  baseFilesToReview: string[]; // .base files mentioning the old name/path — never auto-edited
  skippedLinks: SkippedLink[]; // bare-name links left alone due to a basename collision
}

// The result of a write-mode move+rewrite. `modified` lists files actually written; `failures`
// lists files whose rewrite threw mid-pass (the move already succeeded, so these are stale links
// fixable by hand) alongside the others that did get written.
export interface RewriteResult {
  from: string;
  to: string;
  modified: string[];
  baseFilesToReview: string[];
  skippedLinks: SkippedLink[];
  failures: { path: string; error: string }[];
}

// The link "name" as it appears inside [[...]] for a given vault file: the title (no .md) for a
// note, or the full filename (with extension) for anything else (canvas, base, attachment).
function linkNameForFile(relPath: string): string {
  const base = path.basename(relPath);
  return /\.md$/i.test(base) ? base.slice(0, -3) : base;
}

// The link "path target" as it appears inside [[folder/...]] for a given vault file: the
// vault-relative path with the .md extension dropped for notes, kept for everything else.
function linkPathForFile(relPath: string): string {
  return /\.md$/i.test(relPath) ? relPath.slice(0, -3) : relPath;
}

// Parse one wikilink's inner text (between [[ and ]]) into its target, heading, and alias parts.
// Obsidian orders them target#heading|alias; the heading may be a #^block ref. Any part may be
// absent. The pieces other than target survive a rewrite verbatim.
function parseWikilinkParts(inner: string): { target: string; rest: string } {
  const pipe = inner.indexOf('|');
  const hash = inner.indexOf('#');
  let cut = inner.length;
  if (hash !== -1) cut = Math.min(cut, hash);
  if (pipe !== -1) cut = Math.min(cut, pipe);
  return { target: inner.slice(0, cut), rest: inner.slice(cut) };
}

// Does this link target point at the file we moved? Returns how it matched so the rewriter
// knows whether a basename collision makes it ambiguous.
//   - 'path' : an explicit folder/Name target whose path equals the old file's path
//   - 'bare' : a bare Name target whose name equals the old file's name
//   - null   : no match
function classifyLinkTarget(
  target: string,
  oldName: string,
  oldPathTarget: string,
): 'path' | 'bare' | null {
  const trimmed = target.trim();
  if (trimmed === '') return null;
  const normalize = (s: string) => (/\.md$/i.test(s) ? s.slice(0, -3) : s).toLowerCase();
  const isPathForm = trimmed.includes('/');
  if (isPathForm) {
    return normalize(trimmed) === normalize(oldPathTarget) ? 'path' : null;
  }
  return normalize(trimmed) === normalize(oldName) ? 'bare' : null;
}

// Byte ranges of fenced code blocks (``` or ~~~) and inline code spans (`...`) in a markdown
// body. Wikilinks falling inside any of these are left untouched.
function codeRanges(body: string): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  const fence = /^([ \t]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\2[^\n]*$|$)/gm;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(body)) !== null) {
    ranges.push({ start: m.index, end: m.index + m[0].length });
  }
  const inline = /`+[^`\n]*`+/g;
  while ((m = inline.exec(body)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    // Skip inline spans already covered by a fenced block.
    if (ranges.some(r => start >= r.start && start < r.end)) continue;
    ranges.push({ start, end });
  }
  return ranges;
}

function isInsideCode(index: number, ranges: { start: number; end: number }[]): boolean {
  return ranges.some(r => index >= r.start && index < r.end);
}

// Rewrite wikilinks in a chunk of text (a note body or its frontmatter block). `skipCode`
// excludes links inside code regions — true for bodies, false for frontmatter (which has none).
// `allowBare` is false when a basename collision makes bare-name links ambiguous: those are
// collected into `skipped` instead of rewritten. Returns the new text and the list of rewrites.
function rewriteWikilinksInText(
  text: string,
  opts: {
    oldName: string;
    newName: string;
    oldPathTarget: string;
    newPathTarget: string;
    isRename: boolean;
    allowBare: boolean;
    skipCode: boolean;
  },
): { text: string; rewrites: LinkRewrite[]; skipped: string[] } {
  const ranges = opts.skipCode ? codeRanges(text) : [];
  const rewrites: LinkRewrite[] = [];
  const skipped: string[] = [];
  const wikilink = /(!?)\[\[([^\[\]\n]+?)\]\]/g;

  const next = text.replace(wikilink, (whole, bang: string, inner: string, offset: number) => {
    if (opts.skipCode && isInsideCode(offset, ranges)) return whole;
    const { target, rest } = parseWikilinkParts(inner);
    const kind = classifyLinkTarget(target, opts.oldName, opts.oldPathTarget);
    if (!kind) return whole;

    // A pure move keeps the basename, so bare links still resolve — only path-form links move.
    if (kind === 'bare' && !opts.isRename) return whole;

    // Ambiguous bare link under a basename collision: never guess, report it instead.
    if (kind === 'bare' && !opts.allowBare) {
      skipped.push(whole);
      return whole;
    }

    const newTarget = kind === 'path' ? opts.newPathTarget : opts.newName;
    const replacement = `${bang}[[${newTarget}${rest}]]`;
    if (replacement !== whole) rewrites.push({ before: whole, after: replacement });
    return replacement;
  });

  return { text: next, rewrites, skipped };
}

// Plan the rewrites for a .md note: scan body (code-aware) and frontmatter (whole-block) for
// links to the moved file. Returns the rewrites and any skipped bare links; null content means
// no changes.
function planMarkdownRewrites(
  content: string,
  opts: {
    oldName: string;
    newName: string;
    oldPathTarget: string;
    newPathTarget: string;
    isRename: boolean;
    allowBare: boolean;
  },
): { content: string | null; rewrites: LinkRewrite[]; skipped: string[] } {
  const { frontmatter, body } = splitFrontmatter(content);

  const bodyPass = rewriteWikilinksInText(body, { ...opts, skipCode: true });
  let nextFrontmatter = frontmatter;
  let fmRewrites: LinkRewrite[] = [];
  let fmSkipped: string[] = [];
  if (frontmatter !== null) {
    const fmPass = rewriteWikilinksInText(frontmatter, { ...opts, skipCode: false });
    nextFrontmatter = fmPass.text;
    fmRewrites = fmPass.rewrites;
    fmSkipped = fmPass.skipped;
  }

  const rewrites = [...fmRewrites, ...bodyPass.rewrites];
  const skipped = [...fmSkipped, ...bodyPass.skipped];
  if (rewrites.length === 0) {
    return { content: null, rewrites, skipped };
  }

  const nextContent =
    nextFrontmatter !== null ? `---\n${nextFrontmatter}\n---\n${bodyPass.text}` : bodyPass.text;
  return { content: nextContent, rewrites, skipped };
}

// Detect the indentation a JSON file was written with (spaces per level), or null if it's
// minified. Used to re-serialize a .canvas file close to its original shape.
function detectJsonIndent(text: string): number | null {
  const m = text.match(/\n([ \t]+)\S/);
  if (!m) return null;
  const indent = m[1];
  if (indent.includes('\t')) return null; // tab-indented; JSON.stringify(...,'\t') handled separately
  return indent.length;
}

// Plan the rewrites for a .canvas file: its JSON nodes store literal "file" paths that break on
// any move. Rewrite each "file" equal to the old path; preserve indentation and trailing newline
// as closely as practical. Returns null content when nothing matched.
function planCanvasRewrites(
  content: string,
  oldPath: string,
  newPath: string,
): { content: string | null; rewrites: LinkRewrite[] } {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    return { content: null, rewrites: [] };
  }
  const rewrites: LinkRewrite[] = [];
  const oldLower = oldPath.toLowerCase();

  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    if (typeof obj.file === 'string' && obj.file.toLowerCase() === oldLower) {
      rewrites.push({ before: obj.file, after: newPath });
      obj.file = newPath;
    }
    for (const value of Object.values(obj)) visit(value);
  };
  visit(data);

  if (rewrites.length === 0) return { content: null, rewrites };

  const usesTab = /\n\t/.test(content);
  const indent = usesTab ? '\t' : detectJsonIndent(content) ?? 0;
  const trailingNewline = content.endsWith('\n') ? '\n' : '';
  const serialized = JSON.stringify(data, null, indent) + trailingNewline;
  return { content: serialized, rewrites };
}

// True when a .base file's text mentions the old name or old path. Bases reference notes by name
// inside formulas, where a blind string rewrite is too risky — so we only flag, never edit.
function baseMentionsOldFile(content: string, oldName: string, oldPath: string): boolean {
  const lower = content.toLowerCase();
  return lower.includes(oldName.toLowerCase()) || lower.includes(oldPath.toLowerCase());
}

// Walk the vault collecting every scannable .md, .canvas, and .base file (skipping dotfiles and
// .mcpignore-blocked paths), excluding the moved file itself.
async function collectRewriteTargets(excludeRel: string): Promise<string[]> {
  const out: string[] = [];

  async function walk(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      if (isIgnored(fullPath)) continue;
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!/\.(md|canvas|base)$/i.test(entry.name)) continue;
      const rel = path.relative(VAULT_ROOT, fullPath);
      if (rel === excludeRel) continue;
      out.push(rel);
    }
  }

  await walk(VAULT_ROOT);
  return out;
}

// Is the old basename shared by another vault file (any .md, .canvas, or .base)? When true,
// bare-name links are ambiguous and must be skipped rather than guessed.
async function hasBasenameCollision(oldRel: string): Promise<boolean> {
  const oldName = linkNameForFile(oldRel).toLowerCase();
  const targets = await collectRewriteTargets(oldRel);
  return targets.some(rel => linkNameForFile(rel).toLowerCase() === oldName);
}

// Build the full rewrite plan for moving `from` to `to`. Pure read: scans the vault and reports
// what it would change, writing nothing. Both dry-run and the write pass start here.
export async function planReferenceRewrite(from: string, to: string): Promise<RewritePlan> {
  // Honor .mcpignore / escape policy on both endpoints, matching moveFile's preflight.
  const fromAbs = resolveSafePath(from);
  resolveSafePath(to);

  // A typo'd source would otherwise produce a plausible-looking empty plan. Fail the way
  // moveFile does, with the vault-relative path.
  if (!pathExists(fromAbs)) {
    throw new Error(`No file found at "${from}".`);
  }

  const oldName = linkNameForFile(from);
  const newName = linkNameForFile(to);
  const oldPathTarget = linkPathForFile(from);
  const newPathTarget = linkPathForFile(to);
  const isRename = oldName.toLowerCase() !== newName.toLowerCase();
  const basenameCollision = await hasBasenameCollision(from);

  const targets = await collectRewriteTargets(from);
  const files: FileRewrite[] = [];
  const baseFilesToReview: string[] = [];
  const skippedLinks: SkippedLink[] = [];

  for (const rel of targets) {
    if (/\.base$/i.test(rel)) {
      const content = await fs.readFile(resolveSafePath(rel), 'utf-8');
      if (baseMentionsOldFile(content, oldName, from)) baseFilesToReview.push(rel);
      continue;
    }

    const content = await fs.readFile(resolveSafePath(rel), 'utf-8');

    if (/\.canvas$/i.test(rel)) {
      const { content: next, rewrites } = planCanvasRewrites(content, from, to);
      if (next !== null) files.push({ path: rel, rewrites });
      continue;
    }

    const { content: next, rewrites, skipped } = planMarkdownRewrites(content, {
      oldName,
      newName,
      oldPathTarget,
      newPathTarget,
      isRename,
      allowBare: !basenameCollision,
    });
    for (const link of skipped) {
      skippedLinks.push({
        path: rel,
        link,
        reason: `bare name "${oldName}" is shared by another file, so this link is ambiguous`,
      });
    }
    if (next !== null) files.push({ path: rel, rewrites });
  }

  return { from, to, isRename, basenameCollision, files, baseFilesToReview, skippedLinks };
}

// Apply a previously-built plan's rewrites to disk. The caller moves the file first; this writes
// each file's new content under its per-path lock. A file whose write throws is recorded in
// `failures` (its links stay stale, fixable by hand) and the pass continues, so a mid-pass error
// is visible per-file rather than aborting the whole batch.
export async function applyReferenceRewrite(plan: RewritePlan): Promise<RewriteResult> {
  assertWritable();
  const modified: string[] = [];
  const failures: { path: string; error: string }[] = [];

  for (const file of plan.files) {
    const absPath = resolveSafePath(file.path);
    try {
      let written = false;
      await withPathLock(absPath, async () => {
        const content = await fs.readFile(absPath, 'utf-8');
        const next = recomputeFileContent(file.path, content, plan);
        if (next !== null) {
          await atomicWriteFile(absPath, next);
          written = true;
        }
      });
      // The recompute can find nothing to change (e.g. a concurrent edit already removed the
      // link); only files actually written belong in `modified`.
      if (written) modified.push(file.path);
    } catch (e) {
      failures.push({ path: file.path, error: e instanceof Error ? e.message : String(e) });
    }
  }

  invalidateResolverCache();
  return {
    from: plan.from,
    to: plan.to,
    modified,
    baseFilesToReview: plan.baseFilesToReview,
    skippedLinks: plan.skippedLinks,
    failures,
  };
}

// Recompute a single file's rewritten content from its current on-disk text. Re-derives the
// rewrite at write time (under the lock) so a concurrent edit elsewhere in the file is preserved
// rather than clobbered by stale planned text. Returns null when nothing matches now.
function recomputeFileContent(rel: string, content: string, plan: RewritePlan): string | null {
  const oldName = linkNameForFile(plan.from);
  const newName = linkNameForFile(plan.to);
  const oldPathTarget = linkPathForFile(plan.from);
  const newPathTarget = linkPathForFile(plan.to);

  if (/\.canvas$/i.test(rel)) {
    return planCanvasRewrites(content, plan.from, plan.to).content;
  }
  return planMarkdownRewrites(content, {
    oldName,
    newName,
    oldPathTarget,
    newPathTarget,
    isRename: plan.isRename,
    allowBare: !plan.basenameCollision,
  }).content;
}

// --- Periodic notes ----------------------------------------------------------

export type PeriodicCadence = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly';

// The env var that holds each cadence's path template. A cadence with no
// template configured is reported using this name so the user knows what to set.
const PERIODIC_TEMPLATE_ENV_VARS: Record<PeriodicCadence, string> = {
  daily: 'DAILY_NOTE_PATH_TEMPLATE',
  weekly: 'WEEKLY_NOTE_PATH_TEMPLATE',
  monthly: 'MONTHLY_NOTE_PATH_TEMPLATE',
  quarterly: 'QUARTERLY_NOTE_PATH_TEMPLATE',
  yearly: 'YEARLY_NOTE_PATH_TEMPLATE',
};

// Bucket a date into the start of the week, month, quarter, or year that
// contains it. Daily keeps the date itself. The bucketed date is what the
// template's date tokens are formatted from, so any date in a period maps to
// the same note path.
function bucketForCadence(date: Date, cadence: PeriodicCadence): Date {
  if (cadence === 'weekly') return startOfIsoWeek(date);
  if (cadence === 'monthly') return startOfMonth(date);
  if (cadence === 'quarterly') return startOfQuarter(date);
  if (cadence === 'yearly') return startOfYear(date);
  return date;
}

function formatPeriodicNotePath(date: Date, template: string): string {
  const year = date.getFullYear();
  const shortYear = String(year).slice(-2);
  const weekYear = isoWeekYear(date);
  const shortWeekYear = String(weekYear).slice(-2);
  const week = String(isoWeek(date)).padStart(2, '0');
  const quarter = String(Math.floor(date.getMonth() / 3) + 1);
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
    .replaceAll('{GGGG}', String(weekYear))
    .replaceAll('{GG}', shortWeekYear)
    .replaceAll('{WW}', week)
    .replaceAll('{Q}', quarter)
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

// The daily cadence keeps a built-in default; every other cadence is opt-in and
// has no template until its env var is set. Returns null for an unconfigured
// non-daily cadence so callers can report which env var to set.
export function getPeriodicNoteTemplate(cadence: PeriodicCadence): string | null {
  const configured = process.env[PERIODIC_TEMPLATE_ENV_VARS[cadence]]?.trim();
  if (configured) return configured;
  if (cadence === 'daily') return DEFAULT_DAILY_NOTE_TEMPLATE;
  return null;
}

export function getPeriodicNoteTemplateEnvVar(cadence: PeriodicCadence): string {
  return PERIODIC_TEMPLATE_ENV_VARS[cadence];
}

// Periodic notes use a per-cadence path template with date tokens like {YYYY},
// {GGGG}, {WW}, {Q}, {MM}, and {DD}. The date is bucketed into its containing
// period before formatting. Returns null when the cadence has no template.
export function getPeriodicNotePath(cadence: PeriodicCadence, date?: Date): string | null {
  const template = getPeriodicNoteTemplate(cadence);
  if (template === null) return null;
  const bucketed = bucketForCadence(date ?? new Date(), cadence);
  return formatPeriodicNotePath(bucketed, template);
}
