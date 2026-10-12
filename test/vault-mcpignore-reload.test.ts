// ABOUTME: Tests that .mcpignore is read live rather than frozen at import, and that a missing
// or unmounted vault root fails closed instead of silently disabling the ignore policy.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile, unlink } from 'fs/promises';
import os from 'os';
import path from 'path';

let vault: typeof import('../src/vault.js');
let base: string;
let vaultPath: string;

// mtime has one-second granularity on some filesystems, and the cache key is mtime+size.
// Every rewrite in these tests changes the length too, so the signature always moves.
beforeAll(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), 'vault-ignore-'));
  vaultPath = path.join(base, 'vault');
  await mkdir(path.join(vaultPath, 'Private'), { recursive: true });
  await mkdir(path.join(vaultPath, 'Later'), { recursive: true });
  await writeFile(path.join(vaultPath, 'Private', 'Journal.md'), 'secret\n');
  await writeFile(path.join(vaultPath, 'Later', 'Diary.md'), 'also secret\n');
  await writeFile(path.join(vaultPath, 'Open.md'), 'public\n');
  await writeFile(path.join(vaultPath, '.mcpignore'), 'Private\n');

  process.env.VAULT_PATH = vaultPath;
  vault = await import(`../src/vault.js?vault-ignore-test=${Date.now()}`);
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('.mcpignore is read live', () => {
  test('the initial pattern applies', () => {
    expect(() => vault.resolveSafePath('Private/Journal.md')).toThrow(/blocked by \.mcpignore/);
    expect(() => vault.resolveSafePath('Later/Diary.md')).not.toThrow();
  });

  test('a newly added pattern applies without a restart', async () => {
    await writeFile(path.join(vaultPath, '.mcpignore'), 'Private\nLater\n');
    expect(() => vault.resolveSafePath('Later/Diary.md')).toThrow(/blocked by \.mcpignore/);
  });

  test('a removed pattern stops applying without a restart', async () => {
    await writeFile(path.join(vaultPath, '.mcpignore'), 'Later\n');
    expect(() => vault.resolveSafePath('Private/Journal.md')).not.toThrow();
    expect(() => vault.resolveSafePath('Later/Diary.md')).toThrow(/blocked by \.mcpignore/);
  });

  test('deleting the file removes all blocking, while the vault is still present', async () => {
    await unlink(path.join(vaultPath, '.mcpignore'));
    expect(() => vault.resolveSafePath('Private/Journal.md')).not.toThrow();
    expect(() => vault.resolveSafePath('Later/Diary.md')).not.toThrow();
  });

  test('re-creating the file blocks again', async () => {
    await writeFile(path.join(vaultPath, '.mcpignore'), 'Private\n');
    expect(() => vault.resolveSafePath('Private/Journal.md')).toThrow(/blocked by \.mcpignore/);
  });
});

describe('a missing vault root fails closed', () => {
  test('an absent vault root is refused rather than treated as "nothing ignored"', async () => {
    // The exact shape of the fail-open bug: VAULT_PATH points somewhere that isn't mounted
    // yet. Resolving the root does no I/O, so the old code read no patterns, cached [], and
    // served the whole vault unfiltered for the life of the process.
    const missing = path.join(base, 'not-mounted-yet');
    const previous = process.env.VAULT_PATH;
    process.env.VAULT_PATH = missing;
    try {
      const mod = await import(`../src/vault.js?vault-ignore-missing=${Date.now()}`);
      expect(() => mod.resolveSafePath('anything.md')).toThrow(/not a readable directory/);
      await expect(mod.readNote('anything.md')).rejects.toThrow(/not a readable directory/);
    } finally {
      process.env.VAULT_PATH = previous;
    }
  });

  test('a vault root that is a file, not a directory, is refused', async () => {
    const notADir = path.join(base, 'a-file');
    await writeFile(notADir, 'not a vault\n');
    const previous = process.env.VAULT_PATH;
    process.env.VAULT_PATH = notADir;
    try {
      const mod = await import(`../src/vault.js?vault-ignore-file=${Date.now()}`);
      expect(() => mod.resolveSafePath('anything.md')).toThrow(/not a readable directory/);
    } finally {
      process.env.VAULT_PATH = previous;
    }
  });

  test('the vault becoming available later starts working, without a restart', async () => {
    const late = path.join(base, 'late-mount');
    const previous = process.env.VAULT_PATH;
    process.env.VAULT_PATH = late;
    try {
      const mod = await import(`../src/vault.js?vault-ignore-late=${Date.now()}`);
      expect(() => mod.resolveSafePath('Open.md')).toThrow(/not a readable directory/);
      await mkdir(late, { recursive: true });
      await writeFile(path.join(late, 'Open.md'), 'now here\n');
      expect(() => mod.resolveSafePath('Open.md')).not.toThrow();
      await expect(mod.readNote('Open.md')).resolves.toBe('now here\n');
    } finally {
      process.env.VAULT_PATH = previous;
    }
  });
});
