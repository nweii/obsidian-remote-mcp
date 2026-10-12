// ABOUTME: Pure frontmatter text operations — split/parse/serialize a YAML (or JSON) frontmatter
// block, splice a single property while preserving on-disk byte form, and match/stringify values.
// No filesystem or vault-root dependency; vault.ts wraps these with I/O, locking, and atomic writes.
import { load as parseYaml, dump as stringifyYaml } from 'js-yaml';

export function splitFrontmatter(content: string): { frontmatter: string | null; body: string } {
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

// Only exact, fixed parser diagnostics are safe to retain. Even YAMLException.reason can quote
// source text (alias names, tags, and tag handles), so unknown/new diagnostics fail closed.
const SAFE_YAML_REASONS = new Set([
  'duplication of %YAML directive',
  'YAML directive accepts exactly one argument',
  'ill-formed argument of the YAML directive',
  'unacceptable YAML version of the document',
  'TAG directive accepts exactly two arguments',
  'ill-formed tag handle (first argument) of the TAG directive',
  'ill-formed tag prefix (second argument) of the TAG directive',
  'expected valid JSON character',
  'the stream contains non-printable characters',
  'cannot merge mappings; the provided source object is unacceptable',
  'nested arrays are not supported inside keys',
  'duplicated mapping key',
  'a line break is expected',
  'unexpected end of the document within a single quoted scalar',
  'unexpected end of the stream within a single quoted scalar',
  'expected hexadecimal character',
  'unknown escape sequence',
  'unexpected end of the document within a double quoted scalar',
  'unexpected end of the stream within a double quoted scalar',
  'missed comma between flow collection entries',
  "expected the node content, but found ','",
  'unexpected end of the stream within a flow collection',
  'repeat of a chomping mode identifier',
  'bad explicit indentation width of a block scalar; it cannot be less than one',
  'repeat of an indentation width identifier',
  'missing indentation for block scalar',
  'tab characters must not be used in indentation',
  'bad indentation of a sequence entry',
  'incomplete explicit mapping pair; a key node is missed; or followed by a non-tabulated empty line',
  'a whitespace character is expected after the key-value separator within a block mapping',
  'can not read an implicit mapping pair; a colon is missed',
  'can not read a block mapping entry; a multiline key may not be an implicit key',
  'bad indentation of a mapping entry',
  'duplication of a tag property',
  'unexpected end of the stream within a verbatim tag',
  'named tag handle cannot contain such characters',
  'tag suffix cannot contain exclamation marks',
  'tag suffix cannot contain flow indicator characters',
  'duplication of an anchor property',
  'name of an anchor node must contain at least one character',
  'name of an alias node must contain at least one character',
  'alias node should not have any properties',
  'directive name must not be less than one character in length',
  'directives end mark is expected',
  'end of the stream or a document separator is expected',
  'null byte is not allowed in input',
]);

const YAML_REASON_CATEGORIES: Array<[string, string]> = [
  ['unidentified alias ', 'unidentified alias'],
  ['unknown tag ', 'unknown tag'],
  ['undeclared tag handle ', 'undeclared tag handle'],
  ['there is a previously declared suffix for ', 'duplicated tag handle'],
  ['tag prefix is malformed: ', 'malformed tag prefix'],
  ['tag name cannot contain such characters: ', 'invalid tag name'],
  ['tag name is malformed: ', 'malformed tag name'],
  ['unacceptable node kind for ', 'unacceptable node kind for explicit tag'],
  ['cannot resolve a node with ', 'cannot resolve a node with explicit tag'],
  ['nesting exceeded maxDepth (', 'maximum YAML nesting depth exceeded'],
  ['merge keys exceeded maxTotalMergeKeys (', 'maximum YAML merge keys exceeded'],
];

function safeYamlReason(reason: string): string {
  if (SAFE_YAML_REASONS.has(reason)) return reason;
  for (const [prefix, category] of YAML_REASON_CATEGORIES) {
    if (reason.startsWith(prefix)) return category;
  }
  return 'could not be parsed';
}

// Thrown instead of js-yaml's own YAMLException. js-yaml builds a message that quotes the
// offending source line and its surrounding context, and the audit logger records the message
// of any exception thrown out of a tool handler verbatim — so an unparseable note would write
// its own frontmatter into logs/tool-calls.jsonl. This carries the reason and line number,
// which is what an agent needs to fix the note, and none of the text.
export class FrontmatterParseError extends Error {
  readonly _tag = 'FrontmatterParseError';
  readonly reason: string;

  constructor(
    reason: string,
    public readonly line?: number,
  ) {
    const safeReason = safeYamlReason(reason);
    super(
      `Invalid YAML frontmatter${line !== undefined ? ` at line ${line}` : ''}: ${safeReason}. ` +
        `Read the note and correct the frontmatter block.`,
    );
    this.name = 'FrontmatterParseError';
    this.reason = safeReason;
  }
}

export function parseFrontmatter(content: string): Record<string, unknown> | null {
  const { frontmatter } = splitFrontmatter(content);
  if (frontmatter === null) return null;
  let parsed: unknown;
  try {
    parsed = parseYaml(frontmatter);
  } catch (e) {
    // Use the position separately from the snippet-bearing message. The error constructor
    // sanitizes reason too: js-yaml includes source-derived names in some diagnostics.
    // js-yaml's line is zero-based within the block, which starts after the opening `---`
    // (note line 1), so +2 gives the note's own one-based line.
    const ex = e as { reason?: string; mark?: { line?: number } };
    throw new FrontmatterParseError(
      ex.reason ?? 'could not be parsed',
      ex.mark?.line !== undefined ? ex.mark.line + 2 : undefined,
    );
  }
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

// If a client serialized an array or object as a JSON string before sending (because
// the MCP tool's input schema didn't pin the shape), parse it back so YAML emits a
// proper sequence/map instead of folding the long quoted string. Plain strings that
// happen to look bracket-ish but aren't valid JSON pass through as literals — a
// property value of `[draft]` is legitimate text.
export function coerceFrontmatterValue(value: unknown): unknown {
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
export function setFrontmatterKey(content: string, key: string, value: unknown): string {
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

export type FrontmatterMatchType = 'exact' | 'contains' | 'exists';

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
export function frontmatterValueMatches(
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
