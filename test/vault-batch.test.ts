// ABOUTME: Tests for batch operations — readNotesBatch (found/missing, content toggle, title
// resolution) and updateFrontmatterBatch / setFrontmatterProperties (multi-key splice, per-item
// failures, on-disk form preserved, empty-fields no-op).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'fs/promises';
import os from 'os';
import path from 'path';

let vault: typeof import('../src/vault.js');
let vaultPath: string;

async function note(rel: string, body: string): Promise<void> {
  const abs = path.join(vaultPath, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, body, 'utf-8');
}

async function read(rel: string): Promise<string> {
  return readFile(path.join(vaultPath, rel), 'utf-8');
}

beforeEach(async () => {
  vaultPath = await mkdtemp(path.join(os.tmpdir(), 'orm-batch-test-'));
  process.env.VAULT_PATH = vaultPath;
  process.env.VAULT_MCP_TEST = '1';
  vault = await import(`../src/vault.js?vault-batch-test=${Date.now()}-${Math.random()}`);
});

afterEach(async () => {
  await rm(vaultPath, { recursive: true, force: true });
});

describe('readNotesBatch', () => {
  test('returns found items with content, version, and frontmatter; collects missing', async () => {
    await note('a.md', '---\nstatus: active\n---\nAlpha body\n');
    await note('b.md', '---\nstatus: done\n---\nBeta body\n');

    const { found, missing } = await vault.readNotesBatch(['a.md', 'b.md', 'ghost.md'], true);

    expect(found.map(f => f.path).sort()).toEqual(['a.md', 'b.md']);
    const a = found.find(f => f.path === 'a.md')!;
    expect(a.content).toContain('Alpha body');
    expect(a.frontmatter).toEqual({ status: 'active' });
    expect(a.version).toBe(vault.versionOf(await read('a.md')));
    expect(missing.map(m => m.reference)).toEqual(['ghost.md']);
  });

  test('omits bodies when includeContent is false but keeps frontmatter + version', async () => {
    await note('a.md', '---\nstatus: active\n---\nAlpha body\n');
    const { found } = await vault.readNotesBatch(['a.md'], false);
    expect(found[0].content).toBeUndefined();
    expect(found[0].frontmatter).toEqual({ status: 'active' });
    expect(found[0].version).toBeTruthy();
  });

  test('resolves a bare note title like vault_read', async () => {
    await note('notes/Foo.md', '# Foo\n');
    const { found } = await vault.readNotesBatch(['Foo'], true);
    expect(found.map(f => f.path)).toEqual(['notes/Foo.md']);
  });
});

describe('updateFrontmatterBatch', () => {
  test('updates several notes; a missing note fails without stopping the rest', async () => {
    await note('a.md', '---\nstatus: active\n---\nbody\n');
    await note('b.md', '---\nstatus: active\n---\nbody\n');

    const outcomes = await vault.updateFrontmatterBatch([
      { path: 'a.md', fields: { status: 'done', owner: 'nathan' } },
      { path: 'b.md', fields: { status: 'done' } },
      { path: 'ghost.md', fields: { status: 'done' } },
    ]);

    expect(outcomes.find(o => o.path === 'a.md')!.updated).toBe(true);
    expect(outcomes.find(o => o.path === 'b.md')!.updated).toBe(true);
    expect(outcomes.find(o => o.path === 'ghost.md')!.updated).toBe(false);

    expect(await read('a.md')).toContain('status: done');
    expect(await read('a.md')).toContain('owner: nathan');
    expect(await read('b.md')).toContain('status: done');
  });

  test('leaves untouched keys in their on-disk form (bare date is not normalized)', async () => {
    await note('a.md', '---\ndue: 2026-01-02\nstatus: active\n---\nbody\n');
    await vault.updateFrontmatterBatch([{ path: 'a.md', fields: { status: 'done' } }]);
    const after = await read('a.md');
    expect(after).toContain('due: 2026-01-02'); // not turned into a full ISO datetime
    expect(after).toContain('status: done');
  });
});

describe('setFrontmatterProperties', () => {
  test('applies multiple keys in one write', async () => {
    await note('a.md', '---\nstatus: active\n---\nbody\n');
    await vault.setFrontmatterProperties('a.md', { status: 'done', priority: 1 });
    const after = await read('a.md');
    expect(after).toContain('status: done');
    expect(after).toContain('priority: 1');
  });

  test('empty fields is a no-op — file is left byte-for-byte unchanged', async () => {
    const original = '---\nstatus: active\n---\nbody\n';
    await note('a.md', original);
    await vault.setFrontmatterProperties('a.md', {});
    expect(await read('a.md')).toBe(original);
  });

  test('single-key setFrontmatterProperty still works through the shared path', async () => {
    await note('a.md', '---\nstatus: active\n---\nbody\n');
    await vault.setFrontmatterProperty('a.md', 'status', 'done');
    expect(await read('a.md')).toContain('status: done');
  });
});
