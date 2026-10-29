// ABOUTME: Path-aware async locks. Folder operations exclude descendant writes while
// unrelated paths remain concurrent; multi-path acquisition avoids nested-lock deadlocks.
import path from 'path';
import { realpathSync } from 'fs';
import { errnoCode } from './errno.js';

function canonicalKey(key: string): string {
  if (!path.isAbsolute(key)) return key;
  let parent = path.normalize(key);
  const tail: string[] = [];
  for (;;) {
    try { return path.join(realpathSync(parent), ...tail).normalize('NFC').toLowerCase(); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(errnoCode(error) ?? '')) throw error;
      const next = path.dirname(parent);
      if (next === parent) return key;
      tail.unshift(path.basename(parent));
      parent = next;
    }
  }
}

function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep) ||
    b.startsWith(a.endsWith(path.sep) ? a : a + path.sep);
}

const pending = new Set<{ keys: string[]; done: Promise<void> }>();

// Reserve all keys together in arrival order. Only active/queued operations are examined,
// not vault files. Callers must not recursively acquire an overlapping lock.
export function withPathsLock<T>(keys: string[], critical: () => Promise<T>): Promise<T> {
  const normalized = [...new Set(keys.map(canonicalKey))];
  const dependencies = [...pending].flatMap(entry =>
    entry.keys.some(a => normalized.some(b => overlaps(a, b))) ? [entry.done] : []);
  const result = Promise.all(dependencies).then(critical);
  const entry = { keys: normalized, done: result.then(() => {}, () => {}) };
  pending.add(entry);
  void entry.done.then(() => pending.delete(entry));
  return result;
}

export function withPathLock<T>(key: string, critical: () => Promise<T>): Promise<T> {
  return withPathsLock([key], critical);
}
