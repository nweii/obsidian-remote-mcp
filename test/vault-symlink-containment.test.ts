// ABOUTME: Tests that path containment survives symlinks — reads, writes, searches, and the
// .mcpignore policy — and that the ignore list is case-correct on a case-insensitive volume.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'fs/promises';
import { existsSync, realpathSync } from 'fs';
import os from 'os';
import path from 'path';

let vault: typeof import('../src/vault.js');
let vaultPath: string;
let outsidePath: string;


beforeAll(async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'vault-symlink-'));
  vaultPath = path.join(base, 'vault');
  outsidePath = path.join(base, 'outside');
  await mkdir(path.join(vaultPath, 'Private'), { recursive: true });
  await mkdir(path.join(vaultPath, 'Public'), { recursive: true });
  await mkdir(path.join(outsidePath, 'landing'), { recursive: true });

  await writeFile(path.join(vaultPath, 'Private', 'Journal.md'), 'SECRET journal\n');
  await writeFile(path.join(vaultPath, 'Public', 'Open.md'), 'public note\n');
  await writeFile(path.join(outsidePath, 'secret.txt'), 'host secret\n');
  await writeFile(path.join(outsidePath, 'secret.md'), 'host secret note\n');

  // The .mcpignore must exist before the module is imported — patterns load at import time.
  await writeFile(path.join(vaultPath, '.mcpignore'), 'Private\n');

  // A link pointing clean out of the vault, and a directory link to write through.
  await symlink(path.join(outsidePath, 'secret.md'), path.join(vaultPath, 'leak.md'));
  await symlink(outsidePath, path.join(vaultPath, 'Escape'));
  // A link that stays inside the vault but lands in the ignored folder.
  await symlink(path.join(vaultPath, 'Private', 'Journal.md'), path.join(vaultPath, 'Public', 'Shortcut.md'));
  // A link that stays inside the vault and lands somewhere allowed — must keep working.
  await symlink(path.join(vaultPath, 'Public', 'Open.md'), path.join(vaultPath, 'Alias.md'));



  process.env.VAULT_PATH = vaultPath;
  vault = await import(`../src/vault.js?vault-symlink-test=${Date.now()}`);
});

afterAll(async () => {
  await rm(path.dirname(vaultPath), { recursive: true, force: true });
});

describe('symlink containment', () => {
  test('lexical traversal is still rejected', () => {
    expect(() => vault.resolveSafePath('../outside/secret.txt')).toThrow(/escapes vault root/);
  });

  test('a symlinked file pointing outside the vault is rejected', () => {
    expect(() => vault.resolveSafePath('leak.md')).toThrow(/escapes vault root/);
  });

  test('reading through a symlink out of the vault is rejected', async () => {
    await expect(vault.readNote('leak.md')).rejects.toThrow(/escapes vault root/);
  });

  test('a path under a symlinked directory is rejected', () => {
    expect(() => vault.resolveSafePath('Escape/secret.txt')).toThrow(/escapes vault root/);
  });

  test('writing through a symlinked directory is rejected and creates nothing', async () => {
    await expect(vault.writeNote('Escape/landing/planted.md', 'nope')).rejects.toThrow(
      /escapes vault root/,
    );
    expect(existsSync(path.join(outsidePath, 'landing', 'planted.md'))).toBe(false);
  });

  test('an attachment read through a symlink is rejected', async () => {
    await expect(vault.readAttachment('leak.md')).rejects.toThrow(/escapes vault root/);
  });

  test('a symlink into an ignored folder is blocked by .mcpignore', () => {
    expect(() => vault.resolveSafePath('Public/Shortcut.md')).toThrow(/blocked by \.mcpignore/);
  });

  test('a symlink that stays inside the vault still resolves', async () => {
    await expect(vault.readNote('Alias.md')).resolves.toBe('public note\n');
  });

  test('content search does not read through symlinks', async () => {
    const hits = await vault.searchContent('host secret note');
    expect(hits).toEqual([]);
  });

  test('title search does not surface symlinked notes', async () => {
    const hits = await vault.searchFilename('leak');
    expect(hits).toEqual([]);
  });
});

describe('.mcpignore casing', () => {
  // These assertions hold on BOTH volume types on purpose. On a case-insensitive volume
  // (macOS, SMB) the respelled path reaches the same protected file, so blocking it is
  // required. On a case-sensitive volume it reaches nothing, so blocking it costs nothing —
  // and erring toward over-blocking is the right failure direction for this control.
  // NOTE: CI on Linux only exercises the second case; the first is why the fix exists.
  test('the exact-case path stays blocked', () => {
    expect(() => vault.resolveSafePath('Private/Journal.md')).toThrow(/blocked by \.mcpignore/);
  });

  test('a lowercased path is blocked', () => {
    expect(() => vault.resolveSafePath('private/journal.md')).toThrow(/blocked by \.mcpignore/);
  });

  test('an uppercased path is blocked', () => {
    expect(() => vault.resolveSafePath('PRIVATE/Journal.md')).toThrow(/blocked by \.mcpignore/);
  });

  test('a mixed-case path is blocked', () => {
    expect(() => vault.resolveSafePath('pRiVaTe/JoUrNaL.md')).toThrow(/blocked by \.mcpignore/);
  });

  test('reading a differently-cased ignored note is blocked', async () => {
    await expect(vault.readNote('private/journal.md')).rejects.toThrow(/blocked by \.mcpignore/);
  });

  test('an unrelated folder with a similar prefix is not blocked', () => {
    // `Private` must not swallow `PrivateNotes` — the boundary is a path separator.
    expect(() => vault.resolveSafePath('PrivateNotes/Open.md')).not.toThrow();
  });
});

describe('vault root reached through a symlink', () => {
  test('a symlinked vault root does not reject every path', async () => {
    // Docker bind mounts and macOS /var → /private/var mean the configured root is often
    // itself a symlink. Canonicalizing the target without canonicalizing the root would
    // make every legitimate path look like an escape.
    const linked = path.join(path.dirname(vaultPath), 'vault-link');
    await symlink(vaultPath, linked);
    const previous = process.env.VAULT_PATH;
    process.env.VAULT_PATH = linked;
    try {
      const mod = await import(`../src/vault.js?vault-symlink-root=${Date.now()}`);
      expect(mod.resolveSafePath('Public/Open.md')).toContain('Public/Open.md');
      expect(realpathSync(mod.resolveSafePath('Public/Open.md'))).toBe(
        realpathSync(path.join(vaultPath, 'Public', 'Open.md')),
      );
      await expect(mod.readNote('Public/Open.md')).resolves.toBe('public note\n');
    } finally {
      process.env.VAULT_PATH = previous;
    }
  });
});

describe('unchanged behaviour', () => {
  test('an ordinary note still reads', async () => {
    await expect(vault.readNote('Public/Open.md')).resolves.toBe('public note\n');
  });

  test('an ordinary note still writes', async () => {
    await vault.writeNote('Public/Written.md', 'written\n');
    expect(await readFile(path.join(vaultPath, 'Public', 'Written.md'), 'utf-8')).toBe('written\n');
  });

  test('creating a note in a new subfolder still works', async () => {
    await vault.writeNote('Public/Nested/Deep/New.md', 'deep\n');
    expect(await readFile(path.join(vaultPath, 'Public', 'Nested', 'Deep', 'New.md'), 'utf-8')).toBe(
      'deep\n',
    );
  });
});
