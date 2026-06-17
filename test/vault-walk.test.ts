// ABOUTME: Tests that every vault walk goes through the shared walkVaultFiles traversal and so
// honours .mcpignore uniformly — previously searchContent, searchFilename, findByTitle, and the
// link-graph index skipped the ignore check and leaked ignored notes.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import os from 'os';
import path from 'path';

let vault: typeof import('../src/vault.js');
let vaultPath: string;

beforeAll(async () => {
  vaultPath = await mkdtemp(path.join(os.tmpdir(), 'orm-walk-test-'));
  process.env.VAULT_PATH = vaultPath;
  process.env.VAULT_MCP_TEST = '1';

  await writeFile(path.join(vaultPath, 'public.md'), '---\nstatus: open\n---\nshared secret keyword\n', 'utf-8');
  await mkdir(path.join(vaultPath, 'private'), { recursive: true });
  await writeFile(path.join(vaultPath, 'private', 'secret.md'), '---\nstatus: open\n---\nshared secret keyword\n', 'utf-8');
  await writeFile(path.join(vaultPath, '.mcpignore'), 'private\n', 'utf-8');

  // Fresh import so the module resolves this VAULT_PATH and loads this .mcpignore.
  vault = await import(`../src/vault.js?vault-walk-test=${Date.now()}`);
});

afterAll(async () => {
  await rm(vaultPath, { recursive: true, force: true });
});

describe('.mcpignore is honoured uniformly across the shared walk', () => {
  test('searchContent excludes ignored notes', async () => {
    const hits = await vault.searchContent('secret');
    expect(hits.map(h => h.path)).toEqual(['public.md']);
  });

  test('searchFilename excludes ignored notes', async () => {
    const hits = await vault.searchFilename('\\.md$');
    expect(hits).not.toContain('private/secret.md');
    expect(hits).toContain('public.md');
  });

  test('findByTitle excludes ignored notes', async () => {
    const hits = await vault.findByTitle('secret', false);
    expect(hits.map(h => h.path)).toEqual([]);
  });

  test('getNotesByTag (tag scan) excludes ignored notes', async () => {
    await writeFile(path.join(vaultPath, 'public.md'), '---\n---\n#topic body\n', 'utf-8');
    await writeFile(path.join(vaultPath, 'private', 'secret.md'), '---\n---\n#topic body\n', 'utf-8');
    const notes = await vault.getNotesByTag('topic');
    expect(notes).toEqual(['public.md']);
  });
});
