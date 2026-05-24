// ABOUTME: A tiny per-key async mutex. Critical sections sharing a key run one at a time in
// arrival order; different keys never block each other. Used to make each note's
// read-modify-write a single uninterruptible step within this (single) server process.

const noop = (): void => {};

// Tail of the promise chain for each key. A new call links onto the existing tail so it
// only starts after the previous call finishes. The stored tail never rejects (see below),
// so one failing critical section can't break the chain for the next waiter.
const tails = new Map<string, Promise<unknown>>();

// Run `critical` exclusively with respect to other calls using the same `key`.
//
// How it works:
//   - `previous` is the prior call's tail (or an immediately-resolved promise if the key is
//     idle). We chain onto it with `.then(critical, critical)` so `critical` runs once the
//     previous section settles — whether it resolved OR threw. (A failed edit must release
//     the lock, not wedge the note forever.) Both handlers ignore their argument, so it
//     doesn't matter which fires.
//   - `result` carries `critical`'s real outcome and is what the caller awaits.
//   - `tail` is a version of `result` with errors swallowed; it's what we store as the next
//     link, so a rejection here can't reject the following waiter's `previous`.
//   - When `tail` settles we delete the map entry, but only if it's still the current tail
//     (i.e. no later call has linked on). This keeps the map from growing without bound for
//     notes that are written once.
export function withPathLock<T>(key: string, critical: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  const result = previous.then(critical, critical);
  const tail = result.then(noop, noop);
  tails.set(key, tail);
  void tail.then(() => {
    if (tails.get(key) === tail) {
      tails.delete(key);
    }
  });
  return result;
}
