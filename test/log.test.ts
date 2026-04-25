// ABOUTME: Unit tests for log.ts — argument summarization and field redaction.
import { describe, expect, test } from 'bun:test';
import { summarizeArgs } from '../src/log.js';

describe('summarizeArgs', () => {
  test('passes through short strings, numbers, booleans, null', () => {
    expect(summarizeArgs({ path: '02-Notes/foo.md', limit: 50, exact: true, x: null })).toEqual({
      path: '02-Notes/foo.md',
      limit: 50,
      exact: true,
      x: null,
    });
  });

  test('truncates long strings to length marker', () => {
    const long = 'a'.repeat(200);
    const result = summarizeArgs({ query: long }) as Record<string, string>;
    expect(result.query).toBe('<str:200chars>');
  });

  test('redacts content field regardless of length', () => {
    const result = summarizeArgs({ path: 'foo.md', content: 'short body' }) as Record<string, string>;
    expect(result.path).toBe('foo.md');
    expect(result.content).toBe('<redacted:10chars>');
  });

  test('redacts value field (frontmatter)', () => {
    const result = summarizeArgs({ path: 'foo.md', name: 'tags', value: 'private-tag' }) as Record<string, string>;
    expect(result.name).toBe('tags');
    expect(result.value).toBe('<redacted:11chars>');
  });

  test('redacts template and find fields', () => {
    const result = summarizeArgs({ template: '# Day', find: 'old text', operation: 'replace' }) as Record<string, string>;
    expect(result.template).toBe('<redacted:5chars>');
    expect(result.find).toBe('<redacted:8chars>');
    expect(result.operation).toBe('replace');
  });

  test('redacts non-string values too (numbers, objects, arrays)', () => {
    const result = summarizeArgs({ value: { complex: 'object' } }) as Record<string, string>;
    expect(result.value).toBe('<redacted:object>');
  });

  test('handles arrays', () => {
    const result = summarizeArgs([{ content: 'a' }, { path: 'b.md' }]) as Array<Record<string, string>>;
    expect(result[0].content).toBe('<redacted:1chars>');
    expect(result[1].path).toBe('b.md');
  });
});
