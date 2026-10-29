// ABOUTME: Glob exclusions apply to direct reads/writes, listings, searches, and note resolution.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';

let vault: typeof import('../src/vault.js');
let root: string;
let previousRoot: string | undefined;

beforeAll(async () => {
  previousRoot = process.env.VAULT_PATH;
  root = await mkdtemp(path.join(os.tmpdir(), 'vault-ignore-globs-'));
  process.env.VAULT_PATH = root;
  const notes = ['Notes/Open.md', 'Notes/Secret.private.md', 'RestrictedArea/Deep/Secret.md',
    '.claude/CLAUDE.md', 'Notes/.context/AGENTS.md'];
  for (const note of notes) {
    await mkdir(path.dirname(path.join(root, note)), { recursive: true });
    await writeFile(path.join(root, note), '---\nstatus: draft\ntags: [topic]\n---\nkeyword\n');
  }
  await writeFile(path.join(root, '.mcpignore'), '**/*.private.md\nRestricted*/\n**/.*\n');
  vault = await import(`../src/vault.js?ignore-globs=${Date.now()}`);
});

afterAll(async () => {
  if (previousRoot === undefined) delete process.env.VAULT_PATH;
  else process.env.VAULT_PATH = previousRoot;
  await rm(root, { recursive: true, force: true });
});

test('glob exclusions block direct reads, attachments and scoped listings', async () => {
  for (const note of ['Notes/Secret.private.md', 'RestrictedArea/Deep/Secret.md', '.claude/CLAUDE.md', 'Notes/.context/AGENTS.md']) {
    await expect(vault.readNote(note)).rejects.toThrow(/blocked by \.mcpignore/);
    await expect(vault.readAttachment(note)).rejects.toThrow(/blocked by \.mcpignore/);
  }
  await expect(vault.listVaultFolder('RestrictedArea/Deep')).rejects.toThrow(/blocked by \.mcpignore/);
  await expect(vault.searchContent('keyword', { folder: 'RestrictedArea' })).rejects.toThrow(/blocked by \.mcpignore/);
  expect(await vault.readNote('Notes/Open.md')).toContain('keyword');
});

test('glob exclusions prevent creates, appends and moves without changing disk contents', async () => {
  await expect(vault.writeNote('Notes/New.private.md', 'new')).rejects.toThrow(/blocked by \.mcpignore/);
  await expect(vault.appendNote('Notes/Secret.private.md', 'extra')).rejects.toThrow(/blocked by \.mcpignore/);
  await expect(vault.moveFile('Notes/Open.md', 'RestrictedArea/Moved.md')).rejects.toThrow(/blocked by \.mcpignore/);
  await expect(vault.moveFile('Notes/Secret.private.md', 'Notes/Released.md')).rejects.toThrow(/blocked by \.mcpignore/);
  expect(await readFile(path.join(root, 'Notes/Secret.private.md'), 'utf8')).not.toContain('extra');
  expect(await vault.readNote('Notes/Open.md')).toContain('keyword');
});

test('all discovery paths exclude glob matches', async () => {
  expect((await vault.searchContent('keyword')).map(hit => hit.path)).toEqual(['Notes/Open.md']);
  expect(await vault.searchFilename('\\.md$')).toEqual(['Notes/Open.md']);
  expect((await vault.findByTitle('Secret')).map(hit => hit.path)).toEqual([]);
  expect((await vault.getNotesByTag('topic')).paths).toEqual(['Notes/Open.md']);
  expect((await vault.listVaultFolder('Notes')).map(entry => entry.path)).toEqual(['Notes/Open.md']);
  expect(await vault.getFolderTree(3)).toEqual(['- Notes/']);
  await expect(vault.resolveNoteReference('Secret')).rejects.toThrow(/Could not resolve/);
});

test('hidden context notes remain readable when no rule excludes them', async () => {
  await writeFile(path.join(root, '.mcpignore'), '**/*.private.md\n');
  const allowed = await import(`../src/vault.js?ignore-globs-allow-hidden=${Date.now()}`);
  expect(await allowed.readNote('.claude/CLAUDE.md')).toContain('keyword');
  expect(await allowed.readNote('Notes/.context/AGENTS.md')).toContain('keyword');
});
