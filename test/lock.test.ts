// ABOUTME: Unit tests for the per-key async mutex in src/lock.ts — same-key serialization,
// cross-key concurrency, and lock release after a throwing critical section.
import { describe, expect, test } from 'bun:test';
import { withPathLock } from '../src/lock.js';

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
