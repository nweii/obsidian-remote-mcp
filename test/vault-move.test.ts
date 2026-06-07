// ABOUTME: Tests for vault.moveFile — moving across folders, renaming in place, non-markdown
// files, destination collisions, parent-folder creation, .mcpignore on either path, and read-only mode.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'fs/promises';
import os from 'os';
import path from 'path';

let vault: typeof import('../src/vault.js');
let vaultPath: string;

async function seed(rel: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.join(vaultPath, rel)), { recursive: true });
  await writeFile(path.join(vaultPath, rel), content, 'utf-8');
}

async function read(rel: string): Promise<string> {
  return readFile(path.join(vaultPath, rel), 'utf-8');
}

async function exists(rel: string): Promise<boolean> {
  try {
    await stat(path.join(vaultPath, rel));
    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  vaultPath = await mkdtemp(path.join(os.tmpdir(), 'orm-move-test-'));
  process.env.VAULT_PATH = vaultPath;
  process.env.VAULT_MCP_TEST = '1';
  // .mcpignore is loaded once at module import, so write it before importing the vault module.
  await writeFile(path.join(vaultPath, '.mcpignore'), 'Blocked\n', 'utf-8');
  vault = await import(`../src/vault.js?vault-move-test=${Date.now()}`);
});

afterAll(async () => {
  await rm(vaultPath, { recursive: true, force: true });
});

describe('moveFile', () => {
  test('moves a note across folders, creating missing parents', async () => {
    await seed('source.md', 'body\n');
    const result = await vault.moveFile('source.md', 'Archive/2026/source.md');
    expect(result).toEqual({ from: 'source.md', to: 'Archive/2026/source.md' });
    expect(await exists('source.md')).toBe(false);
    expect(await read('Archive/2026/source.md')).toBe('body\n');
  });

  test('renames a note in place', async () => {
    await seed('old-name.md', 'keep\n');
    await vault.moveFile('old-name.md', 'new-name.md');
    expect(await exists('old-name.md')).toBe(false);
    expect(await read('new-name.md')).toBe('keep\n');
  });

  test('moves a non-markdown file the same as a note', async () => {
    await seed('attachments/diagram.canvas', '{"nodes":[]}\n');
    await vault.moveFile('attachments/diagram.canvas', 'Diagrams/diagram.canvas');
    expect(await exists('attachments/diagram.canvas')).toBe(false);
    expect(await read('Diagrams/diagram.canvas')).toBe('{"nodes":[]}\n');
  });

  test('rejects a missing source with a clean vault-relative error', async () => {
    await expect(vault.moveFile('does-not-exist.md', 'anywhere.md')).rejects.toThrow(
      'No file found at "does-not-exist.md".',
    );
  });

  test('rejects a move whose source and destination are the same path', async () => {
    await seed('same.md', 'still here\n');
    await expect(vault.moveFile('same.md', 'same.md')).rejects.toThrow(/same path/);
    expect(await read('same.md')).toBe('still here\n');
  });

  test('refuses to overwrite an existing destination', async () => {
    await seed('mover.md', 'mine\n');
    await seed('target.md', 'theirs\n');
    await expect(vault.moveFile('mover.md', 'target.md')).rejects.toThrow(vault.NoteExistsError);
    expect(await read('mover.md')).toBe('mine\n');
    expect(await read('target.md')).toBe('theirs\n');
  });

  test('blocks a source path under .mcpignore', async () => {
    await seed('Blocked/secret.md', 'hidden\n');
    await expect(vault.moveFile('Blocked/secret.md', 'public.md')).rejects.toThrow(vault.VaultPolicyError);
    expect(await exists('Blocked/secret.md')).toBe(true);
  });

  test('blocks a destination path under .mcpignore', async () => {
    await seed('exposed.md', 'visible\n');
    await expect(vault.moveFile('exposed.md', 'Blocked/exposed.md')).rejects.toThrow(vault.VaultPolicyError);
    expect(await exists('exposed.md')).toBe(true);
  });

  test('respects VAULT_READ_ONLY by refusing to move', async () => {
    await seed('locked.md', 'frozen\n');
    process.env.VAULT_READ_ONLY = 'true';
    try {
      await expect(vault.moveFile('locked.md', 'moved.md')).rejects.toThrow(/read-only/);
      expect(await exists('locked.md')).toBe(true);
      expect(await exists('moved.md')).toBe(false);
    } finally {
      delete process.env.VAULT_READ_ONLY;
    }
  });
});
