// ABOUTME: Tests the read-only guard on deleteNote and the search-pattern guard — a malformed
// or oversized regex is refused with a typed error instead of escaping as a raw SyntaxError.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import os from 'os';
import path from 'path';

let vault: typeof import('../src/vault.js');
let vaultPath: string;

beforeAll(async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'vault-guards-'));
  vaultPath = path.join(base, 'vault');
  await mkdir(path.join(vaultPath, 'Notes'), { recursive: true });
  await writeFile(path.join(vaultPath, 'Notes', 'One.md'), 'alpha beta\n');
  await writeFile(path.join(vaultPath, 'Notes', 'Two.md'), 'gamma delta\n');

  process.env.VAULT_PATH = vaultPath;
  vault = await import(`../src/vault.js?vault-guards-test=${Date.now()}`);
});

afterEach(() => {
  delete process.env.VAULT_READ_ONLY;
});

afterAll(async () => {
  delete process.env.VAULT_READ_ONLY;
  await rm(path.dirname(vaultPath), { recursive: true, force: true });
});

describe('deleteNote honours read-only mode', () => {
  test('a delete is refused when VAULT_READ_ONLY is set', async () => {
    await vault.writeNote('Notes/Doomed.md', 'bye\n');
    process.env.VAULT_READ_ONLY = 'true';
    await expect(vault.deleteNote('Notes/Doomed.md')).rejects.toThrow(/read-only mode/);
    expect(existsSync(path.join(vaultPath, 'Notes', 'Doomed.md'))).toBe(true);
  });

  test('a delete still works when read-only is off', async () => {
    await vault.deleteNote('Notes/Doomed.md');
    expect(existsSync(path.join(vaultPath, 'Notes', 'Doomed.md'))).toBe(false);
  });
});

describe('search patterns are validated', () => {
  test('a malformed pattern raises a typed error, not a SyntaxError', async () => {
    await expect(vault.searchContent('(unclosed')).rejects.toThrow(
      vault.InvalidSearchPatternError,
    );
  });

  test('the error explains what was wrong', async () => {
    await expect(vault.searchContent('(unclosed')).rejects.toThrow(/Invalid regular expression/);
  });

  test('an over-long pattern is refused', async () => {
    await expect(vault.searchContent('a'.repeat(1001))).rejects.toThrow(/over the 1000-character/);
  });

  test('a pattern at the limit is accepted', async () => {
    await expect(vault.searchContent('a'.repeat(1000))).resolves.toEqual([]);
  });

  test('an ordinary pattern still searches', async () => {
    const hits = await vault.searchContent('gamma');
    expect(hits.map(h => h.path)).toEqual(['Notes/Two.md']);
  });

  test('filename search validates its pattern too', async () => {
    await expect(vault.searchFilename('[bad')).rejects.toThrow(vault.InvalidSearchPatternError);
  });

  test('backlink lookup still works — its pattern is escaped, not caller-supplied', async () => {
    await vault.writeNote('Notes/Link.md', 'see [[One]]\n');
    const backlinks = await vault.getBacklinks('Notes/One.md');
    expect(backlinks).toContain('Notes/Link.md');
  });

  test('a title containing regex metacharacters does not break backlinks', async () => {
    await vault.writeNote('Notes/C++ (draft).md', 'body\n');
    await vault.writeNote('Notes/Refers.md', 'see [[C++ (draft)]]\n');
    const backlinks = await vault.getBacklinks('Notes/C++ (draft).md');
    expect(backlinks).toContain('Notes/Refers.md');
  });
});
