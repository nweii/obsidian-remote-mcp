// ABOUTME: Tests for the atomic write path — content round-trips, no .tmp litter is left behind,
// file permissions survive an overwrite, and parallel writes to distinct notes don't collide.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, stat, chmod, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';

let vault: typeof import('../src/vault.js');
let vaultPath: string;

async function read(rel: string): Promise<string> {
  return readFile(path.join(vaultPath, rel), 'utf-8');
}

// Every name in a directory — used to assert no leftover temp files.
async function entries(rel = '.'): Promise<string[]> {
  return readdir(path.join(vaultPath, rel));
}

beforeAll(async () => {
  vaultPath = await mkdtemp(path.join(os.tmpdir(), 'orm-atomic-test-'));
  process.env.VAULT_PATH = vaultPath;
  process.env.VAULT_MCP_TEST = '1';
  vault = await import(`../src/vault.js?vault-atomic-test=${Date.now()}`);
});

afterAll(async () => {
  await rm(vaultPath, { recursive: true, force: true });
});

beforeEach(async () => {
  await writeFile(path.join(vaultPath, 'note.md'), '# Note\n\nbody\n', 'utf-8');
});

describe('atomic writes', () => {
  test('content round-trips through writeNote and updateNote', async () => {
    await vault.writeNote('fresh.md', 'hello\n');
    expect(await read('fresh.md')).toBe('hello\n');

    await vault.updateNote('fresh.md', 'changed\n');
    expect(await read('fresh.md')).toBe('changed\n');
  });

  test('leaves no .tmp files behind after a write', async () => {
    await vault.updateNote('note.md', 'updated body\n');
    await vault.replaceInNote('note.md', 'body', 'text');
    const names = await entries();
    expect(names.filter(n => n.endsWith('.tmp'))).toEqual([]);
  });

  test('preserves the target file mode across an overwrite', async () => {
    await chmod(path.join(vaultPath, 'note.md'), 0o640);
    await vault.updateNote('note.md', 'rewritten\n');
    const mode = (await stat(path.join(vaultPath, 'note.md'))).mode & 0o777;
    expect(mode).toBe(0o640);
  });

  test('parallel writes to distinct notes all land (no temp-name collision)', async () => {
    const writes = Array.from({ length: 25 }, (_, i) => vault.writeNote(`p/n${i}.md`, `n${i}\n`));
    await Promise.all(writes);
    for (let i = 0; i < 25; i++) {
      expect(await read(`p/n${i}.md`)).toBe(`n${i}\n`);
    }
    expect((await entries('p')).filter(n => n.endsWith('.tmp'))).toEqual([]);
  });
});
