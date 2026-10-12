// ABOUTME: Unit tests for the per-key async mutex in src/lock.ts — same-key serialization,
// cross-key concurrency, and lock release after a throwing critical section.
import { describe, expect, test } from 'bun:test';
import { withPathLock, withPathsLock } from '../src/lock.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

describe('withPathLock', () => {
  test('serializes critical sections that share a key, in arrival order', async () => {
    const events: string[] = [];
    const firstStarted = deferred();
    const releaseFirst = deferred();

    // First holder starts and then blocks until we let it finish.
    const a = withPathLock('note.md', async () => {
      events.push('a:start');
      firstStarted.resolve();
      await releaseFirst.promise;
      events.push('a:end');
    });

    // Queue a second call for the same key while the first is still running.
    await firstStarted.promise;
    const b = withPathLock('note.md', async () => {
      events.push('b:start');
    });

    // b must not have started while a holds the lock.
    expect(events).toEqual(['a:start']);

    releaseFirst.resolve();
    await Promise.all([a, b]);
    expect(events).toEqual(['a:start', 'a:end', 'b:start']);
  });

  test('does not block across different keys', async () => {
    const events: string[] = [];
    const releaseA = deferred();

    const a = withPathLock('a.md', async () => {
      events.push('a:start');
      await releaseA.promise;
      events.push('a:end');
    });

    // A different key should run immediately even though a.md is still held.
    await withPathLock('b.md', async () => {
      events.push('b:ran');
    });
    expect(events).toContain('b:ran');
    expect(events).not.toContain('a:end');

    releaseA.resolve();
    await a;
  });

  test('a throwing critical section still releases the lock for the next waiter', async () => {
    await expect(
      withPathLock('note.md', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // The next call on the same key must still run rather than wedge forever.
    const ran = await withPathLock('note.md', async () => 'ok');
    expect(ran).toBe('ok');
  });

  test('returns the critical section result to the caller', async () => {
    const value = await withPathLock('note.md', async () => 42);
    expect(value).toBe(42);
  });
});


test('folder locks wait for descendant writes and then block new descendants', async () => {
  const release = deferred();
  const started = deferred();
  const events: string[] = [];
  const edit = withPathLock('/tmp/lock-fixture/Folder/Note.md', async () => {
    events.push('edit'); started.resolve(); await release.promise;
  });
  await started.promise;
  const move = withPathsLock(['/tmp/lock-fixture/Folder', '/tmp/lock-fixture/Archive'], async () => { events.push('move'); });
  const later = withPathLock('/tmp/lock-fixture/Folder/Other.md', async () => { events.push('later'); });
  await withPathLock('/tmp/lock-fixture/FolderSibling/Note.md', async () => { events.push('sibling'); });
  expect(events).toEqual(['edit', 'sibling']);
  release.resolve();
  await Promise.all([edit, move, later]);
  expect(events).toEqual(['edit', 'sibling', 'move', 'later']);
});

test('multi-path reservations and a queued ancestor cannot deadlock', async () => {
  const release = deferred();
  const started = deferred();
  const events: string[] = [];
  const first = withPathsLock(['/tmp/lock-multi/A', '/tmp/lock-multi/B'], async () => {
    started.resolve(); await release.promise; events.push('first');
  });
  await started.promise;
  const ancestor = withPathLock('/tmp/lock-multi', async () => { events.push('ancestor'); });
  const reverse = withPathsLock(['/tmp/lock-multi/B', '/tmp/lock-multi/A'], async () => { events.push('reverse'); });
  release.resolve();
  await Promise.all([first, ancestor, reverse]);
  expect(events).toEqual(['first', 'ancestor', 'reverse']);
});

test('a symlinked parent shares locks with its canonical descendants', async () => {
  const { mkdtemp, mkdir, symlink, rm } = await import('fs/promises');
  const root = await mkdtemp('/tmp/vault-lock-alias-');
  try {
    await mkdir(`${root}/Actual`);
    await symlink(`${root}/Actual`, `${root}/Alias`);
    const release = deferred();
    const started = deferred();
    let childRan = false;
    const folder = withPathLock(`${root}/Alias`, async () => { started.resolve(); await release.promise; });
    await started.promise;
    const child = withPathLock(`${root}/Actual/New.md`, async () => { childRan = true; });
    await Promise.resolve();
    expect(childRan).toBe(false);
    release.resolve();
    await Promise.all([folder, child]);
    expect(childRan).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
