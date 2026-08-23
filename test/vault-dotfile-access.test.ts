// ABOUTME: Tests that dotfiles and dot-directories are refused on direct access, matching the
// enumeration policy the walks already applied, while the server's own .trash writes still work.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile, readdir } from 'fs/promises';
import os from 'os';
import path from 'path';

let vault: typeof import('../src/vault.js');
let vaultPath: string;

beforeAll(async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'vault-dotfile-'));
  vaultPath = path.join(base, 'vault');
  await mkdir(path.join(vaultPath, '.obsidian', 'plugins', 'ai'), { recursive: true });
  await mkdir(path.join(vaultPath, '.trash'), { recursive: true });
  await mkdir(path.join(vaultPath, 'Notes'), { recursive: true });

  await writeFile(path.join(vaultPath, '.obsidian', 'plugins', 'ai', 'data.json'), '{"apiKey":"sk-x"}');
  await writeFile(path.join(vaultPath, '.trash', '1234-Deleted.md'), 'deleted note\n');
  await writeFile(path.join(vaultPath, '.mcpignore'), 'Private\n');
  await writeFile(path.join(vaultPath, 'Notes', 'Open.md'), 'public\n');
  await writeFile(path.join(vaultPath, 'Notes', '.hidden.md'), 'hidden note\n');
  // A plainly-named link into a dot-directory: the canonical path must be checked too.
  await symlink(path.join(vaultPath, '.obsidian', 'app.json'), path.join(vaultPath, 'Config.md'));
  await writeFile(path.join(vaultPath, '.obsidian', 'app.json'), '{}');

  process.env.VAULT_PATH = vaultPath;
  vault = await import(`../src/vault.js?vault-dotfile-test=${Date.now()}`);
});

afterAll(async () => {
  await rm(path.dirname(vaultPath), { recursive: true, force: true });
});

describe('dot-directories are refused on read', () => {
  test('plugin data holding an API key is refused', async () => {
    await expect(vault.readAttachment('.obsidian/plugins/ai/data.json')).rejects.toThrow(
      /not accessible/,
    );
  });

  test('a trashed note is refused', async () => {
    await expect(vault.readNote('.trash/1234-Deleted.md')).rejects.toThrow(/not accessible/);
  });

  test('.mcpignore itself is refused', async () => {
    await expect(vault.readNote('.mcpignore')).rejects.toThrow(/not accessible/);
  });

  test('a dotfile inside an ordinary folder is refused', async () => {
    await expect(vault.readNote('Notes/.hidden.md')).rejects.toThrow(/not accessible/);
  });

  test('a symlink into a dot-directory is refused', () => {
    expect(() => vault.resolveSafePath('Config.md')).toThrow(/not accessible/);
  });
});

describe('dot-directories are refused on write', () => {
  test('overwriting .mcpignore is refused', async () => {
    await expect(vault.writeNote('.mcpignore', '')).rejects.toThrow(/not accessible/);
  });

  test('writing into .obsidian is refused', async () => {
    await expect(vault.writeNote('.obsidian/evil.json', '{}')).rejects.toThrow(/not accessible/);
  });
});

describe('ordinary paths are unaffected', () => {
  test('a normal note still reads', async () => {
    await expect(vault.readNote('Notes/Open.md')).resolves.toBe('public\n');
  });

  test('the vault root still lists', async () => {
    const entries = await vault.listVaultFolder('');
    expect(entries.map(e => e.name)).toContain('Notes');
    expect(entries.map(e => e.name)).not.toContain('.obsidian');
  });

  test('a normal note still writes', async () => {
    await vault.writeNote('Notes/New.md', 'new\n');
    await expect(vault.readNote('Notes/New.md')).resolves.toBe('new\n');
  });

  test('a filename containing a dot elsewhere is fine', async () => {
    await vault.writeNote('Notes/v1.2 plan.md', 'ok\n');
    await expect(vault.readNote('Notes/v1.2 plan.md')).resolves.toBe('ok\n');
  });
});

describe('the server still manages .trash itself', () => {
  test('trashing a note works even though .trash is not addressable', async () => {
    await vault.writeNote('Notes/Doomed.md', 'bye\n');
    await vault.trashNote('Notes/Doomed.md');
    const trashed = await readdir(path.join(vaultPath, '.trash'));
    expect(trashed.some(n => n.endsWith('Doomed.md'))).toBe(true);
    // ...and the trashed copy is not readable back through the tools.
    const name = trashed.find(n => n.endsWith('Doomed.md'))!;
    await expect(vault.readNote(`.trash/${name}`)).rejects.toThrow(/not accessible/);
  });
});
