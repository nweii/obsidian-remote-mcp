// ABOUTME: Tests for updateNote's concurrent-edit handling — version match, three-way merge
// of non-overlapping concurrent edits, conflict/eviction rejection, and read-only mode.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, writeFile, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { withPathLock } from '../src/lock.js';

let vault: typeof import('../src/vault.js');
let vaultPath: string;

async function read(rel: string): Promise<string> {
  return readFile(path.join(vaultPath, rel), 'utf-8');
}

// Write directly to disk, bypassing the vault layer — used to simulate "another session
// changed the file" between a caller's read and their update.
async function writeRaw(rel: string, content: string): Promise<void> {
  await writeFile(path.join(vaultPath, rel), content, 'utf-8');
}

beforeAll(async () => {
  vaultPath = await mkdtemp(path.join(os.tmpdir(), 'orm-concurrency-test-'));
  process.env.VAULT_PATH = vaultPath;
  process.env.VAULT_MCP_TEST = '1';
  vault = await import(`../src/vault.js?vault-concurrency-test=${Date.now()}`);
});

afterAll(async () => {
  await rm(vaultPath, { recursive: true, force: true });
});

// A base note with two independently-editable sections.
const BASE = ['# Week 21', '', '## Mon', '- planned', '', '## Tue', '- planned', ''].join('\n');

beforeEach(async () => {
  await writeRaw('week.md', BASE);
});

describe('updateNote', () => {
  test('overwrites directly when no base version is supplied', async () => {
    const result = await vault.updateNote('week.md', 'replaced\n');
    expect(result.merged).toBe(false);
    expect(await read('week.md')).toBe('replaced\n');
  });

  test('overwrites directly when the note is unchanged since the caller read it', async () => {
    const version = vault.recordVersion(BASE); // simulates the version vault_read handed back
    const next = BASE + 'extra\n';
    const result = await vault.updateNote('week.md', next, version);
    expect(result.merged).toBe(false);
    expect(await read('week.md')).toBe(next);
  });

  test('merges a non-overlapping concurrent edit instead of overwriting it', async () => {
    const version = vault.recordVersion(BASE); // caller read the base

    // Another session edited the Mon section and saved.
    const concurrent = ['# Week 21', '', '## Mon', '- planned', '- shipped auth', '', '## Tue', '- planned', ''].join('\n');
    await writeRaw('week.md', concurrent);

    // Caller, working from the base, edits the Tue section and updates with their stale version.
    const callerEdit = ['# Week 21', '', '## Mon', '- planned', '', '## Tue', '- planned', '- reviewed PRs', ''].join('\n');
    const result = await vault.updateNote('week.md', callerEdit, version);

    expect(result.merged).toBe(true);
    const final = await read('week.md');
    expect(final).toContain('- shipped auth');  // the other session's edit survived
    expect(final).toContain('- reviewed PRs');  // the caller's edit landed
  });

  test('rejects and leaves the file untouched when edits overlap', async () => {
    const version = vault.recordVersion(BASE);

    // Both the other session and the caller change the same line differently.
    const concurrent = BASE.replace('- planned\n\n## Tue', '- OTHER SESSION\n\n## Tue');
    await writeRaw('week.md', concurrent);
    const callerEdit = BASE.replace('- planned\n\n## Tue', '- CALLER\n\n## Tue');

    await expect(vault.updateNote('week.md', callerEdit, version)).rejects.toThrow(vault.ConcurrentEditError);
    expect(await read('week.md')).toBe(concurrent); // not overwritten
  });

  test('rejects when the base version is no longer available to merge', async () => {
    // A concurrent change makes the current hash differ from the (uncached) base version.
    await writeRaw('week.md', BASE + 'changed\n');
    await expect(
      vault.updateNote('week.md', 'mine\n', 'never-recorded00'),
    ).rejects.toThrow(vault.ConcurrentEditError);
    expect(await read('week.md')).toBe(BASE + 'changed\n'); // untouched
  });

  test('rejects (rather than silently recreating) when the note was deleted since the read', async () => {
    const version = vault.recordVersion(BASE);
    await rm(path.join(vaultPath, 'week.md')); // another session deleted it
    await expect(vault.updateNote('week.md', 'mine\n', version)).rejects.toThrow(vault.ConcurrentEditError);
  });

  test('creates a missing note when no base_version is supplied', async () => {
    await rm(path.join(vaultPath, 'week.md'));
    const result = await vault.updateNote('week.md', 'fresh\n');
    expect(result.merged).toBe(false);
    expect(await read('week.md')).toBe('fresh\n');
  });

  test('respects VAULT_READ_ONLY by refusing to write', async () => {
    process.env.VAULT_READ_ONLY = 'true';
    try {
      await expect(vault.updateNote('week.md', 'x\n')).rejects.toThrow(/read-only/);
      expect(await read('week.md')).toBe(BASE);
    } finally {
      delete process.env.VAULT_READ_ONLY;
    }
  });
});

describe('appendNote locking', () => {
  test('waits for an in-progress locked write on the same note', async () => {
    // Hold the per-path lock for week.md, then start an append and confirm it can't proceed
    // until the lock is released — i.e. appendNote participates in the same mutex as the
    // read-modify-write writers (so it can't clobber / be clobbered by them).
    const key = vault.resolveSafePath('week.md');
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const held = withPathLock(key, async () => { await gate; });

    let appended = false;
    const append = vault.appendNote('week.md', 'X\n').then(() => { appended = true; });

    await new Promise(r => setTimeout(r, 10));
    expect(appended).toBe(false); // blocked by the held lock

    release();
    await held;
    await append;
    expect(appended).toBe(true);
    expect(await read('week.md')).toBe(BASE + 'X\n');
  });
});

describe('replaceInNote', () => {
  beforeEach(async () => {
    await writeRaw('repl.md', 'price is HERE today\n');
  });

  test('treats replacement content as literal text, not a regex replacement pattern', async () => {
    // '$&' and '$1' are special in String.prototype.replace's replacement string; the content
    // must be inserted verbatim.
    await vault.replaceInNote('repl.md', 'HERE', '$& and $1 and $$');
    expect(await read('repl.md')).toBe('price is $& and $1 and $$ today\n');
  });
});
