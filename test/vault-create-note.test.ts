// ABOUTME: Tests for vault.createNote — the shared "write unless it already exists" guard used by
// vault_create and the clip save-path. Confirms a fresh write lands and an existing note is never clobbered.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, writeFile, rm } from 'fs/promises';
import os from 'os';
import path from 'path';

let vault: typeof import('../src/vault.js');
let vaultPath: string;

async function read(rel: string): Promise<string> {
  return readFile(path.join(vaultPath, rel), 'utf-8');
}

beforeAll(async () => {
  vaultPath = await mkdtemp(path.join(os.tmpdir(), 'orm-create-note-test-'));
  process.env.VAULT_PATH = vaultPath;
  process.env.VAULT_MCP_TEST = '1';
  vault = await import(`../src/vault.js?vault-create-note-test=${Date.now()}`);
});

afterAll(async () => {
  await rm(vaultPath, { recursive: true, force: true });
});

describe('createNote', () => {
  test('writes the note when the path is free', async () => {
    await vault.createNote('Clipped/fresh.md', 'rendered body\n');
    expect(await read('Clipped/fresh.md')).toBe('rendered body\n');
  });

  test('throws NoteExistsError and leaves the existing note untouched', async () => {
    await writeFile(path.join(vaultPath, 'existing.md'), 'original\n', 'utf-8');
    await expect(vault.createNote('existing.md', 'would clobber\n')).rejects.toThrow(vault.NoteExistsError);
    expect(await read('existing.md')).toBe('original\n');
  });
});
