// ABOUTME: Live policy reload invalidates title/link caches, including glob and atomic-replacement edits.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rename, rm, stat, utimes, writeFile } from 'fs/promises';
import path from 'path';
import os from 'os';

let root: string;
let previousRoot: string | undefined;
let vault: typeof import('../src/vault.js');
let sequence = 0;

beforeEach(async () => {
  previousRoot = process.env.VAULT_PATH;
  root = await mkdtemp(path.join(os.tmpdir(), 'vault-live-policy-'));
  process.env.VAULT_PATH = root;
  for (const folder of ['SecretA', 'SecretB']) {
    await mkdir(path.join(root, folder));
    await writeFile(path.join(root, folder, `${folder.replace("Secret", "Note")}.md`), 'private body\n');
  }
  await writeFile(path.join(root, 'Open.md'), '[[NoteA]] [[NoteB]]\n');
  await writeFile(path.join(root, '.mcpignore'), '');
  vault = await import(`../src/vault.js?live-policy=${++sequence}`);
});

afterEach(async () => {
  if (previousRoot === undefined) delete process.env.VAULT_PATH;
  else process.env.VAULT_PATH = previousRoot;
  await rm(root, { recursive: true, force: true });
});

test('adding and removing glob rules refreshes warmed title and link results immediately', async () => {
  expect((await vault.resolveNoteReference('NoteA')).path).toBe('SecretA/NoteA.md');
  expect((await vault.getNoteLinks('Open.md')).map(link => link.path)).toEqual(['SecretA/NoteA.md', 'SecretB/NoteB.md']);
  await writeFile(path.join(root, '.mcpignore'), 'Secret*/\n');
  await expect(vault.resolveNoteReference('NoteA')).rejects.toThrow(/Could not resolve/);
  expect((await vault.getNoteLinks('Open.md')).map(link => link.path)).toEqual([null, null]);
  await expect(vault.readNote('SecretA/NoteA.md')).rejects.toBeInstanceOf(vault.VaultPolicyError);
  await rm(path.join(root, '.mcpignore'));
  expect((await vault.resolveNoteReference('NoteA')).path).toBe('SecretA/NoteA.md');
  expect((await vault.getNoteLinks('Open.md')).map(link => link.path)).toEqual(['SecretA/NoteA.md', 'SecretB/NoteB.md']);
});

test('an atomically replaced policy reloads even when size and mtime are preserved', async () => {
  const policy = path.join(root, '.mcpignore');
  await writeFile(policy, 'SecretA\n');
  const original = await stat(policy);
  expect((await vault.getNoteLinks('Open.md')).map(link => link.path)).toEqual([null, 'SecretB/NoteB.md']);
  const replacement = path.join(root, '.policy-new');
  await writeFile(replacement, 'SecretB\n');
  await utimes(replacement, original.atime, original.mtime);
  await rename(replacement, policy);
  expect((await vault.getNoteLinks('Open.md')).map(link => link.path)).toEqual(['SecretA/NoteA.md', null]);
  await expect(vault.readNote('SecretB/NoteB.md')).rejects.toBeInstanceOf(vault.VaultPolicyError);
});

test('an unreadable policy shape fails closed instead of reusing permissive cached rules', async () => {
  expect((await vault.getNoteLinks('Open.md'))[0]?.path).toBe('SecretA/NoteA.md');
  await rm(path.join(root, '.mcpignore'));
  await mkdir(path.join(root, '.mcpignore'));
  await expect(vault.getNoteLinks('Open.md')).rejects.toThrow();
  await expect(vault.readNote('SecretA/NoteA.md')).rejects.toThrow();
});
