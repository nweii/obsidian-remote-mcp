// ABOUTME: Deterministic barriers verify move-with-references plans the current subtree
// under its endpoint locks, preserves unrelated concurrency, and releases locks on failure.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync } from 'fs';
import fsPromises, { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import * as locks from '../src/lock.js';

let vault: typeof import('../src/vault.js');
let vaultPath: string;
let savedEnv: Map<string, string | undefined>;
const envKeys = ['VAULT_PATH', 'VAULT_READ_ONLY', 'VAULT_MCP_TEST'];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

beforeAll(async () => {
  savedEnv = new Map(envKeys.map(key => [key, process.env[key]]));
  vault = await import('../src/vault.js');
});

beforeEach(async () => {
  vaultPath = await mkdtemp(path.join(os.tmpdir(), 'vault-move-race-'));
  process.env.VAULT_PATH = vaultPath;
  process.env.VAULT_MCP_TEST = '1';
  delete process.env.VAULT_READ_ONLY;
  await seed('.mcpignore', '');
});

afterEach(async () => {
  await rm(vaultPath, { recursive: true, force: true });
});

afterAll(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function abs(relativePath: string): string {
  return path.join(vaultPath, relativePath);
}

async function seed(relativePath: string, content: string) {
  await mkdir(path.dirname(abs(relativePath)), { recursive: true });
  await writeFile(abs(relativePath), content);
}

function read(relativePath: string) {
  return readFile(abs(relativePath), 'utf-8');
}

describe('moveWithReferences locking', () => {
  test('plans changed and newly created descendants after an earlier edit releases its lock', async () => {
    await seed('Source/Target.md', 'target\n');
    await seed('Source/Existing.md', 'previously linkless\n');
    const entered = deferred();
    const release = deferred();
    const editing = locks.withPathLock(abs('Source/Existing.md'), async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;

    // Signal after the real lock manager reserves the move endpoints. This observes
    // queueing without assuming a number of event-loop turns or waiting on a timer.
    const queued = deferred();
    const reserve = locks.withPathsLock;
    const reservation = spyOn(locks, 'withPathsLock').mockImplementation((keys, critical) => {
      const result = reserve(keys, critical);
      if (keys.includes(abs('Source')) && keys.includes(abs('Archive/Moved'))) queued.resolve();
      return result;
    });
    let moving: Promise<Awaited<ReturnType<typeof vault.moveWithReferences>>> | undefined;
    try {
      moving = vault.moveWithReferences('Source', 'Archive/Moved');
      // Surface an unexpected early failure rather than waiting forever for queueing.
      await Promise.race([queued.promise, moving.then(() => {
        throw new Error('Move completed before the held descendant lock was released');
      })]);
      reservation.mockRestore();
      expect(existsSync(abs('Source/Existing.md'))).toBe(true);
      expect(existsSync(abs('Archive'))).toBe(false);

      await writeFile(abs('Source/Existing.md'), '[[Source/Target#Heading|alias]]\n');
      await seed('Source/New.md', '![[Source/Target]]\n');
      await vault.writeNote('Unrelated.md', 'concurrent unrelated write\n');
      expect(await read('Unrelated.md')).toBe('concurrent unrelated write\n');
      release.resolve();

      const result = await moving;
      expect(result.failures).toEqual([]);
      expect(result.modified).toContain('Archive/Moved/Existing.md');
      expect(result.modified).toContain('Archive/Moved/New.md');
      expect(await read('Archive/Moved/Existing.md')).toBe('[[Archive/Moved/Target#Heading|alias]]\n');
      expect(await read('Archive/Moved/New.md')).toBe('![[Archive/Moved/Target]]\n');
      expect(await read('Archive/Moved/Target.md')).toBe('target\n');
      expect(existsSync(abs('Source'))).toBe(false);
    } finally {
      reservation.mockRestore();
      release.resolve();
      await editing;
      await moving?.catch(() => {});
    }
  });

  test('unrelated writes complete while reference planning is blocked on a content read', async () => {
    await seed('Source/Target.md', 'target\n');
    await seed('Source/Reference.md', '[[Source/Target]]\n');
    const planning = deferred();
    const release = deferred();
    const originalRead = fsPromises.readFile;
    let intercepted = false;
    const reads = spyOn(fsPromises, 'readFile').mockImplementation(async (file, options) => {
      if (String(file) === abs('Source/Reference.md') && !intercepted) {
        intercepted = true;
        planning.resolve();
        await release.promise;
      }
      return originalRead(file, options);
    });
    const moving = vault.moveWithReferences('Source', 'Archive/Moved');
    try {
      await Promise.race([planning.promise, moving.then(() => {
        throw new Error('Move completed without reaching the planning barrier');
      })]);
      expect(existsSync(abs('Source'))).toBe(true);
      expect(existsSync(abs('Archive'))).toBe(false);
      await vault.writeNote('Elsewhere/Unrelated.md', 'unrelated writes remain concurrent\n');
      expect(await read('Elsewhere/Unrelated.md')).toBe('unrelated writes remain concurrent\n');
      release.resolve();
      const result = await moving;
      expect(result.failures).toEqual([]);
      expect(await read('Archive/Moved/Reference.md')).toBe('[[Archive/Moved/Target]]\n');
    } finally {
      release.resolve();
      await moving.catch(() => {});
      reads.mockRestore();
    }
  });

  test('a planning failure leaves the tree intact and releases both endpoint locks', async () => {
    await seed('Source/Note', 'extensionless file\n');
    await seed('Source/Note.md', 'markdown note\n');
    await seed('Reference.md', '[[Source/Note]]\n');
    await expect(vault.moveWithReferences('Source', 'Archive/Moved')).rejects.toThrow(
      /Cannot safely rewrite folder references/,
    );
    expect(await read('Source/Note')).toBe('extensionless file\n');
    expect(await read('Source/Note.md')).toBe('markdown note\n');
    expect(await read('Reference.md')).toBe('[[Source/Note]]\n');
    expect(existsSync(abs('Archive'))).toBe(false);

    // Both writes require the previously reserved endpoints. They and the retry can
    // only complete if the failed planner released its locks.
    await vault.writeNote('Source/AfterFailure.md', 'source remains writable\n');
    await vault.writeNote('Archive/Moved/Probe.md', 'destination remains writable\n');
    expect(await read('Archive/Moved/Probe.md')).toBe('destination remains writable\n');
    await rm(abs('Archive/Moved'), { recursive: true });
    await rm(abs('Source/Note'));
    const result = await vault.moveWithReferences('Source', 'Archive/Moved');
    expect(result.failures).toEqual([]);
    expect(await read('Archive/Moved/AfterFailure.md')).toBe('source remains writable\n');
    expect(await read('Reference.md')).toBe('[[Archive/Moved/Note]]\n');
    expect(existsSync(abs('Source'))).toBe(false);
  });
});
