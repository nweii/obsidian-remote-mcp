// ABOUTME: Tests for updateNote's concurrent-edit handling — version match, stale-version and
// deleted-note rejection, plain create/overwrite, the appendNote lock, and replaceInNote.
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
    expect(result.version).toBe(vault.versionOf('replaced\n'));
    expect(await read('week.md')).toBe('replaced\n');
  });

  test('overwrites directly when the note is unchanged since the caller read it', async () => {
    const version = vault.versionOf(BASE); // simulates the version vault_read handed back
    const next = BASE + 'extra\n';
    await vault.updateNote('week.md', next, version);
    expect(await read('week.md')).toBe(next);
  });

  test('rejects and leaves the file untouched when the note changed since the read', async () => {
    const version = vault.versionOf(BASE); // caller read the base

    // Another session edited the note and saved.
    const concurrent = BASE + '- shipped auth\n';
    await writeRaw('week.md', concurrent);

    // Caller, working from the stale base version, tries to overwrite.
    await expect(vault.updateNote('week.md', BASE + '- reviewed PRs\n', version)).rejects.toThrow(vault.ConcurrentEditError);
    expect(await read('week.md')).toBe(concurrent); // the other session's edit is preserved
  });

  test('serializes two concurrent updates from the same base: one wins, the other is rejected', async () => {
    // The headline guarantee. Both callers hold the original version and fire at once. The
    // per-path lock serializes them, so the first writes and the second — now seeing the
    // first's change — is rejected instead of both "succeeding" and silently clobbering.
    // (Without the lock both could read the original concurrently and both overwrite.)
    const version = vault.versionOf(BASE);
    const [first, second] = await Promise.allSettled([
      vault.updateNote('week.md', BASE + 'A\n', version),
      vault.updateNote('week.md', BASE + 'B\n', version),
    ]);

    // Exactly one fulfilled and one rejected — never two writes landing.
    expect([first.status, second.status].sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = (first.status === 'rejected' ? first : second) as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(vault.ConcurrentEditError);

    // The file holds exactly the winner's content, not a clobbered blend.
    expect([BASE + 'A\n', BASE + 'B\n']).toContain(await read('week.md'));
  });

  test('rejects (rather than silently recreating) when the note was deleted since the read', async () => {
    const version = vault.versionOf(BASE);
    await rm(path.join(vaultPath, 'week.md')); // another session deleted it
    await expect(vault.updateNote('week.md', 'mine\n', version)).rejects.toThrow(vault.ConcurrentEditError);
  });

  test('creates a missing note when no base_version is supplied', async () => {
    await rm(path.join(vaultPath, 'week.md'));
    await vault.updateNote('week.md', 'fresh\n');
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
