// ABOUTME: Unit tests for the pure frontmatter module — split/parse, the byte-preserving single-key
// splice, JSON-frontmatter fallback, value coercion, and value stringify/match. No fs, no VAULT_PATH.
import { describe, expect, test } from 'bun:test';
import {
  splitFrontmatter,
  parseFrontmatter,
  setFrontmatterKey,
  coerceFrontmatterValue,
  frontmatterValueToString,
  frontmatterValueMatches,
} from '../src/frontmatter.js';

describe('split / parse', () => {
  test('splits a frontmatter block from the body', () => {
    expect(splitFrontmatter('---\nstatus: open\n---\nbody\n')).toEqual({ frontmatter: 'status: open', body: 'body\n' });
  });
  test('returns null frontmatter when there is no block', () => {
    expect(splitFrontmatter('# just a body\n').frontmatter).toBeNull();
  });
  test('parseFrontmatter yields a plain object', () => {
    expect(parseFrontmatter('---\nstatus: open\ncount: 3\n---\nx')).toEqual({ status: 'open', count: 3 });
  });
});

describe('setFrontmatterKey splice', () => {
  test('changes the target key and leaves an untouched bare date in its on-disk form', () => {
    const out = setFrontmatterKey('---\ndue: 2026-01-02\nstatus: draft\n---\nbody\n', 'status', 'done');
    expect(out).toContain('due: 2026-01-02'); // not normalized to a full ISO datetime
    expect(out).toContain('status: done');
  });
  test('appends a key that does not exist', () => {
    expect(setFrontmatterKey('---\nstatus: draft\n---\nb', 'owner', 'nathan')).toContain('owner: nathan');
  });
  test('creates a block when the note has none', () => {
    expect(setFrontmatterKey('# No frontmatter\n', 'status', 'draft').startsWith('---\nstatus: draft\n---\n')).toBe(true);
  });
  test('JSON-shaped frontmatter falls back to YAML reserialize', () => {
    const out = setFrontmatterKey('---\n{ "tags": ["a"] }\n---\nb', 'status', 'open');
    const parsed = parseFrontmatter(out);
    expect(parsed).toEqual({ tags: ['a'], status: 'open' });
  });
});

describe('coerceFrontmatterValue', () => {
  test('parses a JSON-stringified array back to an array', () => {
    expect(coerceFrontmatterValue('["a","b"]')).toEqual(['a', 'b']);
  });
  test('leaves a bracket-ish but non-JSON string as a literal', () => {
    expect(coerceFrontmatterValue('[draft]')).toBe('[draft]');
  });
  test('passes non-strings through untouched', () => {
    expect(coerceFrontmatterValue(3)).toBe(3);
  });
});

describe('value stringify / match', () => {
  test('a Date renders as its UTC calendar date', () => {
    expect(frontmatterValueToString(new Date('2026-01-15T00:00:00.000Z'))).toBe('2026-01-15');
  });
  test('exact matches a scalar and a list element', () => {
    expect(frontmatterValueMatches('active', 'exact', 'active')).toBe(true);
    expect(frontmatterValueMatches(['draft', 'idea'], 'exact', 'draft')).toBe(true);
    expect(frontmatterValueMatches(['draft', 'idea'], 'exact', 'nope')).toBe(false);
  });
  test('contains is case-insensitive substring; exists ignores the value', () => {
    expect(frontmatterValueMatches('Archived', 'contains', 'arch')).toBe(true);
    expect(frontmatterValueMatches(undefined, 'exists', undefined)).toBe(true);
  });
});
