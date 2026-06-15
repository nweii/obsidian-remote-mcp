// ABOUTME: Tests for searchFrontmatter — exact/contains/exists matching, real list-element
// membership, title fallback, folder scoping, limit, and skipping notes without the property.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import os from 'os';
import path from 'path';

let vault: typeof import('../src/vault.js');
let vaultPath: string;

async function note(rel: string, frontmatter: string, body = 'body\n'): Promise<void> {
  const abs = path.join(vaultPath, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, `---\n${frontmatter}\n---\n${body}`, 'utf-8');
}

function paths(results: { path: string }[]): string[] {
  return results.map(r => r.path).sort();
}

beforeAll(async () => {
  vaultPath = await mkdtemp(path.join(os.tmpdir(), 'orm-fm-search-test-'));
  process.env.VAULT_PATH = vaultPath;
  process.env.VAULT_MCP_TEST = '1';
  vault = await import(`../src/vault.js?vault-fm-search-test=${Date.now()}`);

  await note('projects/alpha.md', 'title: Alpha Project\nstatus: active\ntags: [draft, idea]');
  await note('projects/beta.md', 'status: archived\ntags: [done]');
  await note('notes/gamma.md', 'status: active\npriority: 3');
  await note('notes/delta.md', 'type: meeting');
  await writeFile(path.join(vaultPath, 'notes', 'plain.md'), 'no frontmatter here\n', 'utf-8');
});

afterAll(async () => {
  await rm(vaultPath, { recursive: true, force: true });
});

describe('searchFrontmatter', () => {
  test('exact match on a scalar property', async () => {
    const r = await vault.searchFrontmatter('status', { value: 'active' });
    expect(paths(r)).toEqual(['notes/gamma.md', 'projects/alpha.md']);
  });

  test('exact match returns nothing when no note has the value', async () => {
    expect(await vault.searchFrontmatter('status', { value: 'nope' })).toEqual([]);
  });

  test('contains is a case-insensitive substring match', async () => {
    const r = await vault.searchFrontmatter('status', { value: 'ARCH', matchType: 'contains' });
    expect(paths(r)).toEqual(['projects/beta.md']);
  });

  test('exists matches any note carrying the property, ignoring value', async () => {
    const r = await vault.searchFrontmatter('priority', { matchType: 'exists' });
    expect(paths(r)).toEqual(['notes/gamma.md']);
  });

  test('exact on a list property matches an element, not the stringified list', async () => {
    const r = await vault.searchFrontmatter('tags', { value: 'draft', matchType: 'exact' });
    expect(paths(r)).toEqual(['projects/alpha.md']);
  });

  test('contains on a list property matches a substring of an element', async () => {
    const r = await vault.searchFrontmatter('tags', { value: 'dea', matchType: 'contains' });
    expect(paths(r)).toEqual(['projects/alpha.md']);
  });

  test('title comes from frontmatter when present, else the filename', async () => {
    const r = await vault.searchFrontmatter('status', { value: 'active' });
    const byPath = Object.fromEntries(r.map(x => [x.path, x.title]));
    expect(byPath['projects/alpha.md']).toBe('Alpha Project');
    expect(byPath['notes/gamma.md']).toBe('gamma');
  });

  test('folder scopes the scan', async () => {
    const r = await vault.searchFrontmatter('status', { value: 'active', folder: 'notes' });
    expect(paths(r)).toEqual(['notes/gamma.md']);
  });

  test('limit caps the number of results', async () => {
    const r = await vault.searchFrontmatter('status', { value: 'active', limit: 1 });
    expect(r.length).toBe(1);
  });
});
