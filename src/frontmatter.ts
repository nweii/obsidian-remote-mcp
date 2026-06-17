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

export function parseFrontmatter(content: string): Record<string, unknown> | null {
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
