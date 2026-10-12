// ABOUTME: Filesystem operations for the configured Obsidian vault - safe path resolution, read/write/search, list folder.
import fs from 'fs/promises';
import { accessSync, constants, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, statSync, type Stats } from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { withPathLock, withPathsLock } from './lock.js';
import { compileIgnoreRules } from './ignore.js';
import { readOnlyReason } from './access.js';
import {
  splitFrontmatter,
  parseFrontmatter,
  setFrontmatterKey,
  coerceFrontmatterValue,
  frontmatterValueMatches,
  type FrontmatterMatchType,
  FrontmatterParseError,
} from './frontmatter.js';

// --- Errors ------------------------------------------------------------------
//
// Every expected way a vault operation can fail. Each class carries a literal `_tag`, and
// VaultError is the union of them all, so the tool layer maps them with one exhaustive switch:
// a class added to VAULT_ERROR_CLASSES without a case there fails the typecheck. Messages name
// vault-relative paths and caller input only, never note text or host paths, because the audit
// log records them. Anything else a vault function throws is a fault and propagates unchanged.

// Thrown when the vault root itself can't be read. Distinct from VaultPolicyError: that means
// "this path is not allowed", this means "the vault is not there, so no answer can be trusted".
export class VaultUnavailableError extends Error {
  readonly _tag = 'VaultUnavailableError';
  constructor(message: string) {
    super(message);
    this.name = 'VaultUnavailableError';
  }
}

// Thrown by resolveSafePath when a path is rejected for security/policy reasons.
// `kind` says which rule refused it.
export class VaultPolicyError extends Error {
  readonly _tag = 'VaultPolicyError';
  constructor(public readonly kind: 'escape' | 'mcpignore' | 'internal', message: string) {
    super(message);
    this.name = 'VaultPolicyError';
  }
}

// Thrown when a note reference resolves to nothing, or when a file to read, move or trash is
// missing.
export class NotFoundError extends Error {
  readonly _tag = 'NotFoundError';
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

// Thrown when a folder is given where a note or file is expected.
export class IsDirectoryError extends Error {
  readonly _tag = 'IsDirectoryError';
  constructor(message: string) {
    super(message);
    this.name = 'IsDirectoryError';
  }
}

// Thrown by createNote, and by moves onto an occupied destination, when something already
// exists at the target path.
export class NoteExistsError extends Error {
  readonly _tag = 'NoteExistsError';
  constructor(message: string) {
    super(message);
    this.name = 'NoteExistsError';
  }
}

// Thrown by updateNote when the note changed under the caller since its base_version.
export class ConcurrentEditError extends Error {
  readonly _tag = 'ConcurrentEditError';
  constructor(message: string) {
    super(message);
    this.name = 'ConcurrentEditError';
  }
}

// Thrown by readAttachment when the file is larger than the configured cap. Carries the
// actual and max sizes so the tool layer can name the real size in its error.
export class AttachmentTooLargeError extends Error {
  readonly _tag = 'AttachmentTooLargeError';
  constructor(public readonly bytes: number, public readonly maxBytes: number, message: string) {
    super(message);
    this.name = 'AttachmentTooLargeError';
  }
}

// Thrown when a caller's search pattern can't be compiled or is implausibly long, instead of
// letting a raw SyntaxError escape.
export class InvalidSearchPatternError extends Error {
  readonly _tag = 'InvalidSearchPatternError';
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSearchPatternError';
  }
}

// Thrown by readNoteSection and editNoteSection when no heading in the note matches.
export class HeadingNotFoundError extends Error {
  readonly _tag = 'HeadingNotFoundError';
  constructor(heading: string, relativePath: string) {
    super(
      `Heading "${heading}" not found in ${relativePath}. Call vault_outline first and copy the ` +
        `heading text exactly (without the # prefix).`,
    );
    this.name = 'HeadingNotFoundError';
  }
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
  readonly _tag = 'AmbiguousHeadingError';
  readonly heading: string;
  readonly relativePath: string;
  readonly matches: AmbiguousHeadingMatch[];

  constructor(opts: {
    relativePath: string;
    heading: string;
    matches: AmbiguousHeadingMatch[];
  }) {
    // The message carries line numbers only — never the previews. The audit logger records
    // error text verbatim (both the isError result's first content block and the message of
    // any exception thrown out of a handler), so anything placed here lands in
    // logs/tool-calls.jsonl on disk. Previews are note body text; they go to the agent
    // through candidatesText() as a separate content block instead.
    const lines = opts.matches.map(m => m.startIdx + 1).join(', ');
    super(
      `Heading "${opts.heading}" matches ${opts.matches.length} sections in ${opts.relativePath} ` +
        `(lines ${lines}). vault_edit_section can't safely guess which one to edit. Use vault_edit ` +
        `with a find-anchored replace on text unique to the target section, or vault_update for ` +
        `the whole note.`,
    );
    this.name = 'AmbiguousHeadingError';
    this.heading = opts.heading;
    this.relativePath = opts.relativePath;
    this.matches = opts.matches;
  }

  // The candidate list with a one-line body preview per match, for disambiguating by eye.
  // Kept off `message` on purpose — see the constructor.
  candidatesText(): string {
    return this.matches
      .map((m, i) => `  ${i + 1}. line ${m.startIdx + 1} — ${m.preview}`)
      .join('\n');
  }
}

// Thrown when a request can't be carried out as asked: a write to a read-only vault, a move onto
// itself, a folder move whose link rewrites would be ambiguous, or listing a file as a folder.
export class InvalidRequestError extends Error {
  readonly _tag = 'InvalidRequestError';
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRequestError';
  }
}

const VAULT_ERROR_CLASSES = [
  VaultUnavailableError,
  VaultPolicyError,
  NotFoundError,
  IsDirectoryError,
  NoteExistsError,
  ConcurrentEditError,
  AttachmentTooLargeError,
  InvalidSearchPatternError,
  HeadingNotFoundError,
  AmbiguousHeadingError,
  FrontmatterParseError,
  InvalidRequestError,
] as const;

export type VaultError = InstanceType<(typeof VAULT_ERROR_CLASSES)[number]>;

export function isVaultError(e: unknown): e is VaultError {
  return VAULT_ERROR_CLASSES.some((ErrorClass) => e instanceof ErrorClass);
}

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CONTEXT_NOTE_CANDIDATES = ['AGENTS.md', 'CLAUDE.md'] as const;

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

// The vault root is resolved lazily and memoized against the env inputs it reads, rather than
// captured once at import. Resolving on first use — and re-resolving when VAULT_PATH or
// OBSIDIAN_VAULT_ID change — keeps the root honest when the environment is reconfigured after
// import (notably test files that point VAULT_PATH at a temp dir), while still resolving the
// Obsidian-config fallback at most once per distinct environment.
let vaultRootCache: { key: string; root: string } | null = null;

function vaultRootEnvKey(): string {
  return [process.env.VAULT_PATH ?? '', process.env.OBSIDIAN_VAULT_ID ?? ''].join('\n');
}

export function getVaultRoot(): string {
  const key = vaultRootEnvKey();
  if (!vaultRootCache || vaultRootCache.key !== key) {
    vaultRootCache = { key, root: resolveVaultRoot() };
  }
  return vaultRootCache.root;
}

export function getVaultDisplayName(): string {
  const fromEnv = process.env.VAULT_DISPLAY_NAME?.trim();
  return fromEnv || path.basename(getVaultRoot());
}

export function getContextNotePath(): string | null {
  const fromEnv = process.env.VAULT_CONTEXT_PATH?.trim();
  if (fromEnv) return fromEnv;

  for (const candidate of DEFAULT_CONTEXT_NOTE_CANDIDATES) {
    if (pathExists(path.join(getVaultRoot(), candidate))) {
      return candidate;
    }
  }

  return null;
}

// --- .mcpignore --------------------------------------------------------------

// A missing ignore file is allowed only when the vault itself is available.
function assertVaultRootReadable(root: string): void {
  try {
    if (!statSync(root).isDirectory()) throw new Error('Not a directory');
    accessSync(root, constants.R_OK | constants.X_OK);
  } catch {
    throw new VaultUnavailableError('Vault root is not a readable directory. Refusing to serve without a usable vault.');
  }
}

type IgnoreMatcher = ReturnType<typeof compileIgnoreRules>;
let ignoreCache: { root: string; text: string | null; matches: IgnoreMatcher } | null = null;

// Keyed on the policy text itself, re-read for every policy snapshot. File metadata cannot prove the
// policy unchanged: an in-place, same-length rewrite within one timestamp tick (coarse on
// SMB/FAT volumes) keeps dev, inode, times and size identical. The file is small, so the read
// costs about a microsecond more than a stat. Failure to read an existing policy must never
// mean "allow everything".
function getIgnoreRules(): IgnoreMatcher {
  const root = getVaultRoot();
  const file = path.join(root, '.mcpignore');
  let text: string | null;
  try {
    text = readFileSync(file, 'utf-8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw e;
    // A dangling policy link is a broken configuration, not an intentionally absent policy.
    try {
      if (lstatSync(file).isSymbolicLink()) {
        throw new VaultUnavailableError('The .mcpignore policy target is unavailable. Restore it before accessing the vault.');
      }
    } catch (linkError) {
      const linkCode = (linkError as NodeJS.ErrnoException).code;
      if (linkCode !== 'ENOENT' && linkCode !== 'ENOTDIR') throw linkError;
    }
    assertVaultRootReadable(root);
    text = null;
  }
  if (ignoreCache?.root === root && ignoreCache.text === text) return ignoreCache.matches;

  const matches = compileIgnoreRules(text ?? '');
  ignoreCache = { root, text, matches };
  invalidateResolverCache();
  return matches;
}

// Whether .mcpignore holds any rule. Tools whose output can't be filtered by path stay off while
// it does. Throws, like every policy read, when an existing policy can't be read.
export function hasIgnoreRules(): boolean {
  getIgnoreRules();
  return (ignoreCache?.text ?? '').split('\n').some(line => {
    const rule = line.trim();
    return rule !== '' && !rule.startsWith('#');
  });
}

// Single-level listings show symlinked entries, so each child is resolved in full, the same
// as direct access; testing only the alias path would miss an ignored canonical target.
function isIgnored(absPath: string): boolean {
  try {
    resolveSafePath(path.relative(getVaultRoot(), absPath));
    return false;
  } catch (e) {
    if (e instanceof VaultPolicyError) return true;
    throw e;
  }
}

// App state rather than user context: Obsidian settings and plugin data (where plugins keep
// API keys), and version history. Excluded at any depth before .mcpignore is consulted, so no
// policy file is needed to protect them. Other hidden folders, .trash included, stay reachable
// by explicit path; vault owners keep context and workflow files in them, and an agent can
// restore what it trashed. A .mcpignore rule hides any of those.
const INTERNAL_FOLDERS = ['.obsidian', '.git'];
const matchesInternalFolder = compileIgnoreRules(INTERNAL_FOLDERS.map(name => `**/${name}`).join('\n'));

// --- Read-only mode ----------------------------------------------------------

// Whether writes are refused for the current request: VAULT_READ_ONLY=true, or a connection
// approved without editing. Read live, so the tool layer (which hides write-only tools) and
// assertWritable (which refuses writes) always agree.
export function isReadOnly(): boolean {
  return readOnlyReason() !== null;
}

// Throws when writes are refused, saying why.
function assertWritable() {
  const reason = readOnlyReason();
  if (reason) throw new InvalidRequestError(reason);
}

// --- Path safety -------------------------------------------------------------

// True when `candidate` is the root itself or sits underneath it. Both arguments must already
// be absolute and normalized; neither is canonicalized here.
function isWithin(root: string, candidate: string): boolean {
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  return candidate === root || candidate.startsWith(rootWithSep);
}

// Re-resolve the root so a late mount or a retargeted root symlink cannot leave stale
// containment state. Missing ancestors are normalized the same way as candidate paths.
function getVaultRealRoot(): string {
  return realpathOrNearestExisting(getVaultRoot());
}

// Canonicalize as much of `absPath` as exists, then re-append the segments that don't.
//
// realpathSync throws ENOENT for a path that isn't there yet, which is the normal case for a
// create. Walking up to the deepest existing ancestor and canonicalizing *that* still resolves
// every symlink standing between the vault root and the new file — which is the part that
// matters, since a symlinked parent directory is how a write escapes the vault.
function realpathOrNearestExisting(absPath: string): string {
  const pending: string[] = [];
  let current = absPath;

  while (true) {
    try {
      const real = realpathSync(current);
      return pending.length === 0 ? real : path.join(real, ...pending.slice().reverse());
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw e;
      // A dangling link exists even though realpath reports ENOENT. Do not treat it as an
      // ordinary new filename: append/mkdir would follow it and create its missing target.
      try {
        if (lstatSync(current).isSymbolicLink()) {
          throw new VaultPolicyError('escape', 'Path contains a dangling symlink; repair or remove the shortcut before accessing it.');
        }
      } catch (statError) {
        const statCode = (statError as NodeJS.ErrnoException).code;
        if (statCode !== 'ENOENT' && statCode !== 'ENOTDIR') throw statError;
      }
      const parent = path.dirname(current);
      // Reached the filesystem root without finding anything that exists. Nothing to
      // canonicalize, so the lexical path is the best answer available.
      if (parent === current) return absPath;
      pending.push(path.basename(current));
      current = parent;
    }
  }
}

// --- Policy snapshot ---------------------------------------------------------

type PolicyVerdict = 'escape' | 'internal' | 'mcpignore' | 'policy-file' | null;

// One reading of the access policy, and the single place its rules are decided. Every path
// check (direct access, bulk walks, folder moves) asks a snapshot, so a rule added here applies
// to all of them. A snapshot belongs to one operation: a walk or a folder move checks thousands
// of entries against the policy as it stood when the operation began, instead of re-reading
// .mcpignore for each one. Callers own their error wording; the snapshot only says which rule
// refused.
interface PolicySnapshot {
  root: string;
  realRoot: string;
  // `lexical` is the absolute path as requested and `canonical` the same entry with symlinks
  // resolved. Both must pass. `ignore: false` skips .mcpignore for the internal trash
  // destination. `write` adds owner-managed policy-file protection; pass the entry's stat when
  // it exists so a hardlink alias is caught.
  check(lexical: string, canonical: string, opts: { ignore: boolean; write: boolean; stat?: Stats | null }): PolicyVerdict;
}

function policySnapshot(): PolicySnapshot {
  const root = getVaultRoot();
  const rules = getIgnoreRules();
  const realRoot = getVaultRealRoot();
  const policy = path.join(root, '.mcpignore');
  // Only writes consult the policy file's own location and inode, so reads skip the cost.
  let policyTarget: { real: string; stat: Stats | null } | null = null;
  const getPolicyTarget = () => {
    if (policyTarget) return policyTarget;
    let stat: Stats | null = null;
    try {
      stat = statSync(policy);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw e;
    }
    policyTarget = { real: realpathOrNearestExisting(policy), stat };
    return policyTarget;
  };
  const key = (value: string) => value.normalize('NFC').toLowerCase();
  const overlaps = (a: string, b: string) => isWithin(key(a), key(b)) || isWithin(key(b), key(a));
  const rel = (from: string, to: string) => path.relative(from, to).split(path.sep).join('/');

  return {
    root,
    realRoot,
    check(lexical, canonical, { ignore, write, stat }) {
      if (!isWithin(root, lexical) || !isWithin(realRoot, canonical)) return 'escape';
      const lexicalRel = rel(root, lexical);
      const canonicalRel = rel(realRoot, canonical);
      if (matchesInternalFolder(lexicalRel) || matchesInternalFolder(canonicalRel)) return 'internal';
      if (ignore && (rules(lexicalRel) || rules(canonicalRel))) return 'mcpignore';
      if (write) {
        // A containing directory counts: moving it would carry the policy away, and a path
        // beneath an absent policy would create it as a directory the loader cannot read.
        // Hardlinks need the inode check because realpath cannot identify those aliases.
        const target = getPolicyTarget();
        if (overlaps(lexical, policy) || overlaps(canonical, target.real) ||
            (stat && target.stat && stat.dev === target.stat.dev && stat.ino === target.stat.ino)) {
          return 'policy-file';
        }
      }
      return null;
    },
  };
}

// Check both the requested path and its canonical target. An allowed target cannot make an
// ignored alias writable, and an allowed alias cannot expose an ignored target. The internal
// trash destination skips .mcpignore only; containment, the internal-folder exclusion, and
// policy-file protection still apply.
function resolveVaultPath(relativePath: string, opts: { ignore: boolean; write: boolean }): string {
  const policy = policySnapshot();
  const resolved = path.resolve(policy.root, relativePath);
  if (!isWithin(policy.root, resolved)) {
    throw new VaultPolicyError('escape', `Path escapes vault root: ${relativePath}`);
  }
  const realResolved = realpathOrNearestExisting(resolved);
  let stat: Stats | null = null;
  if (opts.write) {
    try {
      stat = statSync(resolved);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw e;
    }
  }
  switch (policy.check(resolved, realResolved, { ...opts, stat })) {
    case 'escape':
      throw new VaultPolicyError(
        'escape',
        `Path escapes vault root: ${relativePath} (resolves outside the vault through a symlink)`,
      );
    case 'internal':
      throw new VaultPolicyError(
        'internal',
        `Path is inside an Obsidian internal folder (${INTERNAL_FOLDERS.join(', ')}), which MCP cannot access: ${relativePath}`,
      );
    case 'mcpignore':
      throw new VaultPolicyError('mcpignore', `Path is blocked by .mcpignore: ${relativePath}`);
    case 'policy-file':
      throw new VaultPolicyError('mcpignore', 'The .mcpignore access policy cannot be modified through MCP. Edit it directly as the vault owner.');
  }
  return resolved;
}

export function resolveSafePath(relativePath: string): string {
  return resolveVaultPath(relativePath, { ignore: true, write: false });
}

// The policy is owner-managed. Reading it is allowed unless it is itself ignored, but no
// mutation may change it, including through directory/file aliases or a symlinked policy.
// This check is separate from read-only mode so move dry runs can still validate destinations.
function resolveWritePath(relativePath: string, allowIgnored = false): string {
  return resolveVaultPath(relativePath, { ignore: !allowIgnored, write: true });
}

// fs.stat that reports a missing path as a NotFoundError with the caller's vault-relative message,
// instead of a raw ENOENT whose message carries the absolute host path.
async function statExisting(absPath: string, notFoundMessage: string): Promise<Stats> {
  try {
    return await fs.stat(absPath);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new NotFoundError(notFoundMessage);
    throw e;
  }
}

// The checks every write gets, for callers outside this module that hand a path to something else
// to write (the Obsidian CLI): the read policy plus protection of the policy file.
export function resolveSafeWritePath(relativePath: string): string {
  return resolveWritePath(relativePath);
}

export async function readNote(relativePath: string): Promise<string> {
  return fs.readFile(resolveSafePath(relativePath), 'utf-8');
}

// Resolve a note's actual vault-relative location without reading its body. Both the requested
// path and the canonical target must satisfy vault containment and .mcpignore.
export async function canonicalNotePath(relativePath: string): Promise<string> {
  const target = await fs.realpath(resolveSafePath(relativePath));
  const canonical = path.relative(getVaultRealRoot(), target);
  resolveSafePath(canonical);
  return canonical;
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
  const st = await statExisting(absPath, `Attachment not found: ${relativePath}`);
  if (st.isDirectory()) throw new IsDirectoryError(`"${relativePath}" is a directory, not a file.`);

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
  const absPath = resolveWritePath(relativePath);
  await withPathLock(absPath, async () => {
    resolveWritePath(relativePath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await atomicWriteFile(absPath, content);
  });
  invalidateResolverCache();
}

// Write a new note, refusing to overwrite one that already exists. Single source of truth for
// the "create, don't clobber" guard shared by vault_create and the clip save-path.
export async function createNote(relativePath: string, content: string): Promise<void> {
  assertWritable();
  resolveWritePath(relativePath);
  try {
    await readNote(relativePath);
  } catch {
    await writeNote(relativePath, content);
    return;
  }
  throw new NoteExistsError(
    `File already exists at ${relativePath}. To replace it, use vault_update; to modify part of it, use vault_edit.`,
  );
}

// --- Concurrent-edit safety: optimistic versioning ---------------------------
//
// Two sessions can edit the same note in overlapping requests. `vault_read` hands back a
// content-addressed "version" (a hash of the note text); `updateNote` accepts that version
// back as `baseVersion`. If the note changed since the caller read it, the update is rejected
// with a ConcurrentEditError ("re-read and retry") instead of silently overwriting the other
// session's work. Omitting `baseVersion` keeps the old last-writer-wins overwrite.

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
  const absPath = resolveWritePath(relativePath);

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
  const absPath = resolveWritePath(relativePath);
  await withPathLock(absPath, async () => {
    let content = await readNote(relativePath);
    for (const [name, value] of Object.entries(fields)) {
      content = setFrontmatterKey(content, name, coerceFrontmatterValue(value));
    }
    await atomicWriteFile(resolveWritePath(relativePath), content);
    invalidateResolverCache();
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

// Locked like the other writers: O_APPEND is atomic against other appends, but NOT against
// a read-modify-write writer that read the file before this append landed — without the
// lock, that writer would overwrite the appended bytes. Taking the same per-path lock
// serializes appends with updateNote/editNoteSection/etc. so no write is lost.
export async function appendNote(relativePath: string, content: string): Promise<void> {
  assertWritable();
  const absPath = resolveWritePath(relativePath);
  await withPathLock(absPath, async () => {
    await fs.appendFile(absPath, content, 'utf-8');
  });
}

// Insert content at the very start of a note. Locked so the read and write are atomic.
export async function prependToNote(relativePath: string, content: string): Promise<void> {
  assertWritable();
  const absPath = resolveWritePath(relativePath);
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
  const absPath = resolveWritePath(relativePath);
  await withPathLock(absPath, async () => {
    const existing = await fs.readFile(absPath, 'utf-8');
    // Function replacer keeps `content` literal — a plain string replacement would interpret
    // $&, $1, $$ etc. in the agent's content as special replacement patterns.
    await atomicWriteFile(absPath, existing.replace(find, () => content));
  });
  invalidateResolverCache();
}

export async function deleteNote(relativePath: string): Promise<void> {
  // Every other mutating helper asserts this; deleteNote was the one that didn't. No tool
  // currently reaches it, so VAULT_READ_ONLY was honoured in practice — but wiring up a
  // delete tool later would have silently inherited a read-only bypass.
  assertWritable();
  const absPath = resolveWritePath(relativePath);
  await withPathLock(absPath, async () => {
    await fs.unlink(resolveWritePath(relativePath));
  });
}

// Every descendant carried by a folder rename must be a regular file or directory. A
// standalone file link is handled separately; following directory links hides descendants.
function assertMovableFile(absPath: string, relativePath: string, allowFileSymlink = false): Stats {
  let st: Stats;
  try {
    st = lstatSync(absPath);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new NotFoundError(`No file found at "${relativePath}".`);
    throw e;
  }
  if (st.isSymbolicLink() && allowFileSymlink && statSync(absPath).isFile()) return st;
  if (st.isSymbolicLink() || (!st.isFile() && !st.isDirectory())) {
    throw new VaultPolicyError('escape', `Cannot move or trash symlinks or special files: ${relativePath}`);
  }
  return st;
}

export interface MoveResult {
  from: string; // vault-relative source path
  to: string;   // vault-relative destination path
}

export interface FileMovePlan extends MoveResult {
  isDirectory: boolean;
  files: MoveResult[]; // Every regular descendant, including hidden files and attachments.
}

interface CheckedMovePlan extends FileMovePlan {
  fromAbs: string;
  toAbs: string;
}

function pathEntryExists(absPath: string): boolean {
  try {
    lstatSync(absPath);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw e;
  }
}

// Check the entire tree against one policy snapshot, without per-entry realpath or policy
// reads. Canonical descendants are simple joins once all symlink entries are refused.
function checkFileMove(source: string, destination: string, allowIgnoredDestination = false): CheckedMovePlan {
  const fromAbs = resolveWritePath(source);
  const toAbs = resolveWritePath(destination, allowIgnoredDestination);
  const sourceStat = assertMovableFile(fromAbs, source, true);
  const policy = policySnapshot();
  const { root: vaultRoot, realRoot } = policy;
  const fromReal = realpathSync(fromAbs);
  const toReal = realpathOrNearestExisting(toAbs);
  const key = (value: string) => value.normalize('NFC').toLowerCase();
  if (sourceStat.isDirectory() &&
      key(path.relative(vaultRoot, fromAbs)) !== key(path.relative(realRoot, fromReal))) {
    throw new VaultPolicyError('escape', 'Move the folder through its canonical vault path instead of a parent symlink, so references can be rewritten safely.');
  }
  if (fromAbs === toAbs) throw new InvalidRequestError(`Source and destination are the same path ("${source}").`);
  // Reject either ancestry direction before acquiring hierarchical endpoint locks.
  if (isWithin(key(fromReal), key(toReal)) || isWithin(key(toReal), key(fromReal))) {
    throw new VaultPolicyError('escape', 'Source and destination overlap; choose a destination outside the source folder.');
  }
  if (pathEntryExists(toAbs)) {
    throw new NoteExistsError(
      `A file or folder already exists at ${destination}. Choose a different destination or trash the existing entry first.`,
    );
  }
  const fileSymlink = sourceStat.isSymbolicLink();
  if (fileSymlink) {
    // A standalone file shortcut can be renamed safely if its relative/absolute link text
    // still reaches exactly the same file. Links carried inside a folder remain forbidden.
    const target = path.resolve(path.dirname(toAbs), readlinkSync(fromAbs));
    if (realpathOrNearestExisting(target) !== fromReal) {
      throw new VaultPolicyError('escape', 'Moving this symlink would change its target; move the target file or keep the shortcut in the same folder.');
    }
  }

  const rel = (root: string, candidate: string) => path.relative(root, candidate).split(path.sep).join('/');
  const checkEntry = (lexical: string, canonical: string, st: Stats, ignore: boolean): void => {
    const lexicalRel = rel(vaultRoot, lexical);
    switch (policy.check(lexical, canonical, { ignore, write: true, stat: st })) {
      case 'escape':
        throw new VaultPolicyError('escape', `Folder operation would include a path outside the vault: ${lexicalRel}`);
      case 'internal':
        throw new VaultPolicyError('internal', `Folder operation would include an internal path: ${lexicalRel}`);
      case 'mcpignore':
        throw new VaultPolicyError('mcpignore', `Folder operation would include a path blocked by .mcpignore: ${lexicalRel}`);
      case 'policy-file':
        throw new VaultPolicyError('mcpignore', 'Folder operation would modify the .mcpignore access policy or one of its aliases.');
    }
  };
  const files: MoveResult[] = [];
  const visit = (suffix: string, st: Stats): void => {
    const oldAbs = path.join(fromAbs, suffix);
    const newAbs = path.join(toAbs, suffix);
    checkEntry(oldAbs, path.join(fromReal, suffix), st, true);
    checkEntry(newAbs, fileSymlink ? fromReal : path.join(toReal, suffix), st, !allowIgnoredDestination);
    if (st.isDirectory()) {
      // Include hidden entries: a rename carries them even though ordinary vault walks do not.
      for (const entry of readdirSync(oldAbs, { withFileTypes: true })) {
        const childSuffix = path.join(suffix, entry.name);
        const childAbs = path.join(fromAbs, childSuffix);
        const childStat = assertMovableFile(childAbs, rel(vaultRoot, childAbs));
        visit(childSuffix, childStat);
      }
    } else {
      files.push({ from: rel(vaultRoot, oldAbs), to: rel(vaultRoot, newAbs) });
    }
  };
  visit('', sourceStat);
  return { from: rel(vaultRoot, fromAbs), to: rel(vaultRoot, toAbs),
    isDirectory: sourceStat.isDirectory(), files, fromAbs, toAbs };
}

// Pure preflight shared by dry-run link plans and real moves. An empty folder has no file
// mappings; every directory is nevertheless checked against source and destination policy.
export function planFileMove(source: string, destination: string): FileMovePlan {
  const { fromAbs, toAbs, ...plan } = checkFileMove(source, destination);
  return plan;
}

export async function trashNote(relativePath: string): Promise<void> {
  assertWritable();
  const destination = path.join('.trash', `${Date.now()}-${path.basename(path.resolve(relativePath))}`);
  const fromAbs = resolveWritePath(relativePath);
  const toAbs = resolveWritePath(destination, true);
  await withPathsLock([fromAbs, toAbs], async () => {
    assertWritable();
    const checked = checkFileMove(relativePath, destination, true);
    // No await between the last policy/tree check and rename: another JS operation cannot
    // change the subtree during this section. External filesystem changes remain possible.
    mkdirSync(path.dirname(checked.toAbs), { recursive: true });
    renameSync(checked.fromAbs, checked.toAbs);
    invalidateResolverCache();
  });
}

// Caller holds both endpoint locks. Recheck live policy immediately before committing.
function commitFileMove(source: string, destination: string): MoveResult {
  assertWritable();
  const checked = checkFileMove(source, destination);
  mkdirSync(path.dirname(checked.toAbs), { recursive: true });
  renameSync(checked.fromAbs, checked.toAbs);
  invalidateResolverCache();
  return { from: checked.from, to: checked.to };
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
  const fromAbs = resolveWritePath(source);
  const toAbs = resolveWritePath(destination);
  return withPathsLock([fromAbs, toAbs], async () => commitFileMove(source, destination));
}

// Production move workflow: queued descendant writes finish BEFORE planning starts, then
// the endpoint locks prevent further descendant writes until rename completes. Calling the
// separately exported plan/move helpers in sequence cannot provide this snapshot guarantee.
// Link writes remain per-file and nontransactional, as with existing single-file moves.
export async function moveWithReferences(source: string, destination: string): Promise<RewriteResult> {
  assertWritable();
  const fromAbs = resolveWritePath(source);
  const toAbs = resolveWritePath(destination);
  const plan = await withPathsLock([fromAbs, toAbs], async () => {
    assertWritable();
    const freshPlan = await planReferenceRewrite(source, destination);
    commitFileMove(source, destination);
    return freshPlan;
  });
  return applyReferenceRewrite(plan);
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

// --- Shared vault traversal ---------------------------------------------------
//
// One depth-first walk over the vault's files, used by every search, index, and scan below.
// Centralizing it keeps the access policy — skip dotfiles, honour .mcpignore, default to .md — in
// one place instead of being re-derived (and drifting) across each caller. Callers read file
// content themselves when they need it, and `break` out of the for-await loop to stop early.

interface WalkVaultOptions {
  folder?: string;                          // vault-relative scope; defaults to the whole vault
  includeFile?: (name: string) => boolean;  // which files to yield; defaults to .md only
  sort?: boolean;                           // sort each directory's entries by name for deterministic order
}

interface WalkEntry {
  fullPath: string;  // absolute path on disk
  relPath: string;   // vault-relative path
  name: string;      // basename
}

const isMarkdownFile = (name: string): boolean => name.toLowerCase().endsWith('.md');

// Generous enough for any real search, short enough that the pathological constructions people
// paste from regex-golf threads don't get through.
const MAX_SEARCH_PATTERN_LENGTH = 1000;

// Compile a caller-supplied search pattern.
//
// This bounds two of the three failure modes. An invalid pattern used to throw a raw SyntaxError
// out of the tool handler; it now returns a typed error the agent can act on. An absurdly long
// pattern is refused outright.
//
// It does NOT solve catastrophic backtracking: JavaScript's regex engine has no execution
// timeout, so a short pattern like /(a+)+$/ against the right note still blocks the event loop,
// and this server is single-process. Bounding that properly needs either a linear-time engine
// (RE2) or running the match off-thread with a kill switch — a larger change than this fix, and
// one worth agreeing on upstream first. The exposure is limited to an authenticated caller, so
// the effect is a stall rather than a leak.
export function compileSearchPattern(pattern: string, flags: string): RegExp {
  if (pattern.length > MAX_SEARCH_PATTERN_LENGTH) {
    throw new InvalidSearchPatternError(
      `Search pattern is ${pattern.length} characters, over the ${MAX_SEARCH_PATTERN_LENGTH}-character limit. Use a shorter pattern.`,
    );
  }
  try {
    return new RegExp(pattern, flags);
  } catch (e) {
    throw new InvalidSearchPatternError(
      `Invalid regular expression: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

async function* walkVaultFiles(options: WalkVaultOptions = {}): AsyncGenerator<WalkEntry> {
  const { folder, includeFile = isMarkdownFile, sort = false } = options;
  const root = resolveSafePath(folder || '');
  if (folder && !(await statExisting(root, `Folder not found: ${folder}`)).isDirectory()) {
    throw new InvalidRequestError(`Not a directory: ${folder}`);
  }
  // One policy snapshot for the whole walk. Each entry's canonical path is resolved when it is
  // processed, not derived from its Dirent: a sync client can swap a directory for a symlink
  // between readdir and recursion, and only the live target shows where it now leads.
  const policy = policySnapshot();
  const vaultRoot = policy.root;
  const allowed = (fullPath: string): boolean => {
    let canonical: string;
    try {
      canonical = realpathSync(fullPath);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return false; // Removed mid-walk, or now dangling.
      throw e;
    }
    return policy.check(fullPath, canonical, { ignore: true, write: false }) === null;
  };

  async function* walk(dir: string): AsyncGenerator<WalkEntry> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    if (sort) entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      // Never traverse or yield a symlink. A symlinked `.md` would otherwise be read by every
      // content search, and its bytes could live anywhere on the host — the walk has no cheap
      // way to know. Direct access still follows in-vault links via resolveSafePath, which
      // canonicalizes and re-checks containment; a bulk scan doesn't need that latitude.
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(dir, entry.name);
      if (!allowed(fullPath)) continue;
      if (entry.isDirectory()) {
        yield* walk(fullPath);
        continue;
      }
      if (!includeFile(entry.name)) continue;
      yield { fullPath, relPath: path.relative(vaultRoot, fullPath), name: entry.name };
    }
  }

  yield* walk(root);
}

export async function searchContent(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
  const { caseSensitive = false, folder, limit = 20 } = options;
  const results: SearchResult[] = [];
  const regex = compileSearchPattern(query, caseSensitive ? '' : 'i');
  const maxResults = limit > 0 ? limit : Number.POSITIVE_INFINITY;

  for await (const { fullPath, relPath } of walkVaultFiles({ folder })) {
    if (results.length >= maxResults) break;
    let content: string;
    try {
      content = await fs.readFile(fullPath, 'utf-8');
    } catch {
      continue; // skip unreadable files (e.g. permission denied)
    }
    const matches = content.split('\n').filter(line => regex.test(line));
    if (matches.length > 0) results.push({ path: relPath, matches });
  }
  return results;
}

// Every note path in the vault (or a folder), in sorted walk order. Honours dotfile skipping and
// .mcpignore through walkVaultFiles.
export async function listNotePaths(folder?: string): Promise<string[]> {
  const paths: string[] = [];
  for await (const { relPath } of walkVaultFiles({ folder, sort: true })) paths.push(relPath);
  return paths;
}

export async function searchFilename(pattern: string): Promise<string[]> {
  const results: string[] = [];
  const regex = compileSearchPattern(pattern, 'i');
  // includeFile: () => true so every file is tested against the pattern, not just .md.
  for await (const { relPath, name } of walkVaultFiles({ includeFile: () => true })) {
    if (regex.test(name)) results.push(relPath);
  }
  return results;
}

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

// Find notes whose frontmatter has `field`, optionally constrained by value/matchType. Walks the
// vault (or a folder) once, parsing each note's frontmatter — stateless, no persistent index, so
// it stays consistent with the per-request server. Uses the shared walkVaultFiles traversal (skips
// dotfiles, honours .mcpignore, reads only .md). Notes without frontmatter, or without `field`, are
// skipped before the predicate runs.
export async function searchFrontmatter(
  field: string,
  options: FrontmatterSearchOptions = {},
): Promise<FrontmatterSearchResult[]> {
  const { value, matchType = 'exact', folder, limit = 20 } = options;
  const maxResults = limit > 0 ? limit : Number.POSITIVE_INFINITY;
  const results: FrontmatterSearchResult[] = [];

  for await (const { fullPath, relPath } of walkVaultFiles({ folder })) {
    if (results.length >= maxResults) break;
    let content: string;
    try {
      content = await fs.readFile(fullPath, 'utf-8');
    } catch {
      continue; // skip unreadable files (e.g. permission denied)
    }
    const frontmatter = parseFrontmatter(content);
    if (!frontmatter || !(field in frontmatter)) continue;
    if (!frontmatterValueMatches(frontmatter[field], matchType, value)) continue;
    const titleValue = frontmatter.title;
    const title =
      typeof titleValue === 'string' && titleValue.trim() !== ''
        ? titleValue
        : path.basename(relPath, '.md');
    results.push({ path: relPath, title, frontmatter });
  }
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

  return buildSubtree(resolveSafePath(''), 1);
}

// Immediate children of a vault folder (non-recursive). Skips dotfiles and .mcpignore-blocked paths.
export async function listVaultFolder(relativeDir = '', limit = 200): Promise<VaultFolderEntry[]> {
  const normalized = relativeDir.trim() === '' ? '.' : relativeDir;
  const absDir = resolveSafePath(normalized);
  const st = await statExisting(absDir, `Folder not found: ${relativeDir || '.'}`);
  if (!st.isDirectory()) {
    throw new InvalidRequestError(`Not a directory: ${relativeDir || '.'}`);
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
      path: path.relative(getVaultRoot(), childAbs),
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

  for await (const { relPath, name } of walkVaultFiles()) {
    if (results.length >= maxResults) break;
    const title = name.slice(0, -3);
    const normalizedTitle = title.toLowerCase();
    const matched = exact
      ? normalizedTitle === normalizedQuery
      : normalizedTitle.includes(normalizedQuery);
    if (matched) results.push({ path: relPath, title });
  }
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
    throw new HeadingNotFoundError(heading, relativePath);
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
  const absPath = resolveWritePath(relativePath);
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
    throw new HeadingNotFoundError(heading, relativePath);
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

let titleIndexCache: { map: Map<string, string[]>; builtAt: number; root: string } | null = null;

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
  // sort: true so directory entries are visited in a stable order and "first match wins" is
  // deterministic across filesystems.
  for await (const { relPath, name } of walkVaultFiles({ sort: true })) {
    const key = name.slice(0, -3).toLowerCase();
    const existing = index.get(key);
    if (existing) existing.push(relPath);
    else index.set(key, [relPath]);
  }
  return index;
}

async function getResolverTitleIndex(): Promise<Map<string, string[]>> {
  const ttl = getResolveIndexTtlMs();
  while (true) {
    const root = getVaultRoot();
    const rules = getIgnoreRules(); // Refresh policy before trusting a cached index.
    if (titleIndexCache?.root === root && Date.now() - titleIndexCache.builtAt < ttl) {
      return titleIndexCache.map;
    }
    const map = await buildResolverTitleIndex();
    // An edit during the asynchronous walk must not publish a partly stale index.
    if (getVaultRoot() !== root || getIgnoreRules() !== rules) continue;
    titleIndexCache = { map, builtAt: Date.now(), root };
    return map;
  }
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
    throw new NotFoundError('Empty note reference');
  }

  const hasMdSuffix = /\.md$/i.test(trimmed);

  // Step 1: stat the input as-given. If it's a directory, surface EISDIR with
  // the "use mode list" affordance. Only return it as a path match if it ends
  // in .md — non-.md files (e.g. binaries, plain text) are not notes and must
  // not be returned as if they were.
  const asGivenStat = await statOrNull(trimmed);
  if (asGivenStat) {
    if (asGivenStat.isDirectory()) {
      throw new IsDirectoryError(`"${trimmed}" is a directory, not a note. Call vault_read with mode "list" to browse it.`);
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

  throw new NotFoundError(
    `Could not resolve "${input}" to a note. Try a full vault-relative path or call vault_search_title to discover it.`,
  );
}

// --- Link graph --------------------------------------------------------------

export interface LinkResult {
  title: string;
  path: string | null; // null if the linked note wasn't found in the vault
}

// Return all outgoing [[wikilinks]] from a note with resolved paths. Resolution reuses the cached
// resolver title index — the same index vault_read uses — so a link resolves to the same note a
// bare title would, an ambiguous title picks the deterministic first match, and repeated link
// queries hit the cache instead of re-walking the vault.
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

  const index = await getResolverTitleIndex();
  return titles.map(title => ({ title, path: index.get(title.toLowerCase())?.[0] ?? null }));
}

// Return paths of notes that link to the given note (backlinks).
// Uses a content search for [[title pattern, so it may include false positives
// from notes that mention the title in non-link contexts.
export async function getBacklinks(relativePath: string, limit = 20): Promise<string[]> {
  // The search below only reads allowed notes, but a protected note's backlinks are still
  // refused, the same as every other operation that names a vault path.
  resolveSafePath(relativePath);
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

// All tags on one note — frontmatter `tags` plus inline `#tag` — deduplicated case-insensitively,
// keeping first-seen casing.
export function getNoteTags(content: string): string[] {
  const seen = new Map<string, string>();
  for (const tag of collectNoteTags(content)) {
    const key = tag.toLowerCase();
    if (!seen.has(key)) seen.set(key, tag);
  }
  return [...seen.values()];
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

// Single pass over the vault (or a folder) via the shared walkVaultFiles traversal, reading each
// note once and aggregating tag counts in memory. Returns the per-tag aggregate keyed by lowercased
// tag.
async function scanTags(options: TagScanOptions = {}): Promise<Map<string, TagAggregate>> {
  const { folder } = options;
  const aggregates = new Map<string, TagAggregate>();

  for await (const { fullPath, relPath } of walkVaultFiles({ folder })) {
    let content: string;
    try {
      content = await fs.readFile(fullPath, 'utf-8');
    } catch {
      continue; // skip unreadable files (e.g. permission denied)
    }
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
        agg.notePaths.push(relPath);
      }
    }
  }
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
  isDirectory?: boolean; // absent in older single-file plans
  movedFiles?: MoveResult[]; // every descendant mapping, including hidden files and attachments
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

// One ordinary vault scan, supplemented with the preflight's moved descendants: hidden notes
// inside a moved folder need their links updated even though bulk discovery skips dotfiles.
async function collectRewriteTargets(excludeRel: string | null, movedFiles: MoveResult[] = []): Promise<string[]> {
  const out = new Set<string>();
  for await (const { relPath } of walkVaultFiles({ includeFile: name => /\.(md|canvas|base)$/i.test(name) })) {
    if (relPath !== excludeRel) out.add(relPath);
  }
  for (const file of movedFiles) {
    if (file.from !== excludeRel && /\.(md|canvas|base)$/i.test(file.from)) out.add(file.from);
  }
  return [...out];
}

interface FolderRewriteTargets {
  wikilinks: Map<string, string>;
  canvas: Map<string, string>;
}

// Look up each original target once rather than applying descendant substitutions in sequence.
// This both makes a folder move linear in links and prevents a newly rewritten prefix from
// matching another old descendant. Folder moves preserve basenames, so bare links stay valid.
function folderRewriteTargets(movedFiles: MoveResult[]): FolderRewriteTargets {
  const wikilinks = new Map<string, string>();
  const canvas = new Map<string, string>();
  const owners = new Map<string, string>();
  const add = (map: Map<string, string>, kind: string, target: string, replacement: string, source: string): void => {
    const key = target.toLowerCase();
    const ownerKey = `${kind}:${key}`;
    const existing = owners.get(ownerKey);
    if (existing !== undefined && existing !== source) {
      throw new InvalidRequestError(`Cannot safely rewrite folder references: "${existing}" and "${source}" share the link target "${target}". Disambiguate these filenames or move the folder directly in Obsidian and review links manually.`);
    }
    owners.set(ownerKey, source);
    map.set(key, replacement);
  };
  for (const file of movedFiles) {
    add(canvas, 'canvas', file.from, file.to, file.from);
    add(wikilinks, 'wikilink', file.from, file.to, file.from);
    add(wikilinks, 'wikilink', linkPathForFile(file.from), linkPathForFile(file.to), file.from);
  }
  return { wikilinks, canvas };
}

function planFolderRewrites(
  rel: string,
  content: string,
  targets: FolderRewriteTargets,
): { content: string | null; rewrites: LinkRewrite[] } {
  const rewrites: LinkRewrite[] = [];
  if (/\.canvas$/i.test(rel)) {
    let data: unknown;
    try {
      data = JSON.parse(content);
    } catch {
      return { content: null, rewrites };
    }
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(visit);
      } else if (node && typeof node === 'object') {
        const obj = node as Record<string, unknown>;
        if (typeof obj.file === 'string') {
          const replacement = targets.canvas.get(obj.file.toLowerCase());
          if (replacement !== undefined && replacement !== obj.file) {
            rewrites.push({ before: obj.file, after: replacement });
            obj.file = replacement;
          }
        }
        Object.values(obj).forEach(visit);
      }
    };
    visit(data);
    if (rewrites.length === 0) return { content: null, rewrites };
    const indent = /\n\t/.test(content) ? '\t' : detectJsonIndent(content) ?? 0;
    return {
      content: JSON.stringify(data, null, indent) + (content.endsWith('\n') ? '\n' : ''),
      rewrites,
    };
  }

  const rewrite = (text: string, skipCode: boolean): string => {
    const ranges = skipCode ? codeRanges(text) : [];
    return text.replace(/(!?)\[\[([^\[\]\n]+?)\]\]/g, (whole, bang: string, inner: string, offset: number) => {
      if (skipCode && isInsideCode(offset, ranges)) return whole;
      const { target, rest } = parseWikilinkParts(inner);
      const original = target.trim();
      // Match the existing planner's conservative vault-relative paths. Relative ./ and ../
      // links have note-local semantics and are not treated as vault-root paths.
      if (!original.includes('/')) return whole;
      const replacement = targets.wikilinks.get(original.toLowerCase());
      if (replacement === undefined) return whole;
      const next = `${bang}[[${replacement}${rest}]]`;
      if (next !== whole) rewrites.push({ before: whole, after: next });
      return next;
    });
  };
  const { frontmatter, body } = splitFrontmatter(content);
  const nextFrontmatter = frontmatter !== null ? rewrite(frontmatter, false) : null;
  const nextBody = rewrite(body, true);
  return {
    content: rewrites.length === 0 ? null :
      nextFrontmatter !== null ? `---\n${nextFrontmatter}\n---\n${nextBody}` : nextBody,
    rewrites,
  };
}

// Build the full rewrite plan for moving `from` to `to`. Pure read: scans the vault and reports
// what it would change, writing nothing. Both dry-run and the write pass start here.
export async function planReferenceRewrite(from: string, to: string): Promise<RewritePlan> {
  // Share recursive folder/file policy preflight with the actual move. Its file mappings
  // also supply hidden rewrite targets, without another recursive scan for each descendant.
  const move = planFileMove(from, to);
  from = move.from;
  to = move.to;

  const oldName = linkNameForFile(from);
  const newName = linkNameForFile(to);
  const oldPathTarget = linkPathForFile(from);
  const newPathTarget = linkPathForFile(to);
  const isRename = !move.isDirectory && oldName.toLowerCase() !== newName.toLowerCase();
  const targets = await collectRewriteTargets(move.isDirectory ? null : from, move.isDirectory ? move.files : []);
  const basenameCollision = !move.isDirectory && targets.some(rel => linkNameForFile(rel).toLowerCase() === oldName.toLowerCase());
  const folderTargets = move.isDirectory ? folderRewriteTargets(move.files) : null;
  const files: FileRewrite[] = [];
  const baseFilesToReview: string[] = [];
  const skippedLinks: SkippedLink[] = [];

  for (const rel of targets) {
    const content = await fs.readFile(resolveSafePath(rel), 'utf-8');
    if (/\.base$/i.test(rel)) {
      if (baseMentionsOldFile(content, oldName, from)) baseFilesToReview.push(rel);
      continue;
    }

    if (folderTargets) {
      const { content: next, rewrites } = planFolderRewrites(rel, content, folderTargets);
      if (next !== null) files.push({ path: rel, rewrites });
      continue;
    }

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

  return { from, to, isDirectory: move.isDirectory, movedFiles: move.files, isRename, basenameCollision, files, baseFilesToReview, skippedLinks };
}

// Apply a previously-built plan's rewrites to disk. The caller moves the file first; this writes
// each file's new content under its per-path lock. A file whose write throws is recorded in
// `failures` (its links stay stale, fixable by hand) and the pass continues, so a mid-pass error
// is visible per-file rather than aborting the whole batch.
export async function applyReferenceRewrite(plan: RewritePlan): Promise<RewriteResult> {
  assertWritable();
  const modified: string[] = [];
  const failures: { path: string; error: string }[] = [];
  const movedPaths = new Map((plan.movedFiles ?? []).map(file => [file.from, file.to]));
  const folderTargets = plan.isDirectory ? folderRewriteTargets(plan.movedFiles ?? []) : null;
  const currentPath = (rel: string): string => plan.isDirectory ? movedPaths.get(rel) ?? rel : rel;

  for (const file of plan.files) {
    const rel = currentPath(file.path);
    try {
      const absPath = resolveWritePath(rel);
      let written = false;
      await withPathLock(absPath, async () => {
        // A queued rewrite must re-check policy after it acquires the lock, since ignore rules
        // and symlink targets can change while it waits.
        const liveAbsPath = resolveWritePath(rel);
        const content = await fs.readFile(liveAbsPath, 'utf-8');
        const next = recomputeFileContent(rel, content, plan, folderTargets);
        if (next !== null) {
          await atomicWriteFile(liveAbsPath, next);
          written = true;
        }
      });
      // The recompute can find nothing to change (e.g. a concurrent edit already removed the
      // link); only files actually written belong in `modified`.
      if (written) modified.push(rel);
    } catch (e) {
      failures.push({ path: rel, error: e instanceof Error ? e.message : String(e) });
    }
  }

  invalidateResolverCache();
  return {
    from: plan.from,
    to: plan.to,
    modified,
    baseFilesToReview: plan.baseFilesToReview.map(currentPath),
    skippedLinks: plan.skippedLinks,
    failures,
  };
}

// Recompute a single file's rewritten content from its current on-disk text. Re-derives the
// rewrite at write time (under the lock) so a concurrent edit elsewhere in the file is preserved
// rather than clobbered by stale planned text. Returns null when nothing matches now.
function recomputeFileContent(
  rel: string,
  content: string,
  plan: RewritePlan,
  folderTargets: FolderRewriteTargets | null = null,
): string | null {
  if (plan.isDirectory) {
    return planFolderRewrites(rel, content, folderTargets ?? folderRewriteTargets(plan.movedFiles ?? [])).content;
  }
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
