// ABOUTME: Tests for resolveNoteReference — title/path resolution, caching, invalidation,
// determinism, and policy-error passthrough.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile, rm } from 'fs/promises';
import os from 'os';
import path from 'path';

let vault: typeof import('../src/vault.js');
let vaultPath: string;

async function seed(rel: string, content = '# placeholder\n'): Promise<void> {
  const full = path.join(vaultPath, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content, 'utf-8');
}

// VAULT_ROOT in vault.ts is resolved at module-init time. We always set
// VAULT_PATH first so vault.js never falls back to the user's real Obsidian
// config, and use a unique query string to load a fresh module instance —
// otherwise we'd share VAULT_ROOT with server.test.ts in the same `bun test`
// process and one of us would always see the other's tmpdir.
beforeAll(async () => {
  vaultPath = await mkdtemp(path.join(os.tmpdir(), 'orm-resolve-test-'));
  process.env.VAULT_PATH = vaultPath;
  process.env.VAULT_MCP_TEST = '1';
  vault = await import(`../src/vault.js?vault-resolve-test=${Date.now()}`);

  // The prior test file's afterAll may have torn down its tmpdir; recreate.
  await mkdir(vaultPath, { recursive: true });

  await seed('vault-resolve-AGENTS.md');
  await seed('vault-resolve-Notes/Foo.md');
  await seed('vault-resolve-Archive/Foo.md');
  await seed('vault-resolve-Projects/Unique.md');
  await mkdir(path.join(vaultPath, 'vault-resolve-DailyDir'), { recursive: true });

  // Long TTL keeps cache-hit tests deterministic; invalidation tests call
  // invalidateResolverCache() explicitly.
  process.env.RESOLVE_INDEX_TTL_MS = '600000';
});

afterAll(async () => {
  delete process.env.RESOLVE_INDEX_TTL_MS;
  await rm(vaultPath, { recursive: true, force: true });
});

beforeEach(() => {
  vault.invalidateResolverCache();
});

describe('resolveNoteReference — explicit paths', () => {
  test('returns path as-given when it ends in .md and exists', async () => {
    const ref = await vault.resolveNoteReference('vault-resolve-AGENTS.md');
    expect(ref.path).toBe('vault-resolve-AGENTS.md');
    expect(ref.matchedVia).toBe('path');
    expect(ref.candidates).toBeUndefined();
  });

  test('appends .md when missing and the file exists', async () => {
    const ref = await vault.resolveNoteReference('vault-resolve-Notes/Foo');
    expect(ref.path).toBe(path.join('vault-resolve-Notes', 'Foo.md'));
    expect(ref.matchedVia).toBe('path');
  });

  test('strips trailing slash before resolving', async () => {
    const ref = await vault.resolveNoteReference('vault-resolve-Notes/Foo/');
    expect(ref.path).toBe(path.join('vault-resolve-Notes', 'Foo.md'));
    expect(ref.matchedVia).toBe('path');
  });
});

describe('resolveNoteReference — title lookup', () => {
  test('bare title with one match resolves to its relpath', async () => {
    const ref = await vault.resolveNoteReference('Unique');
    expect(ref.path).toBe(path.join('vault-resolve-Projects', 'Unique.md'));
    expect(ref.matchedVia).toBe('title');
    expect(ref.candidates).toBeUndefined();
  });

  test('case-insensitive title match', async () => {
    const ref = await vault.resolveNoteReference('unique');
    expect(ref.path).toBe(path.join('vault-resolve-Projects', 'Unique.md'));
  });

  test('bare title with collisions returns first match plus full candidates', async () => {
    const ref = await vault.resolveNoteReference('Foo');
    expect(ref.candidates).toBeDefined();
    expect(ref.candidates!.length).toBe(2);
    expect(ref.candidates).toContain(path.join('vault-resolve-Archive', 'Foo.md'));
    expect(ref.candidates).toContain(path.join('vault-resolve-Notes', 'Foo.md'));
    expect(ref.candidates![0]).toBe(ref.path);
    // Deterministic order: 'vault-resolve-Archive' sorts before 'vault-resolve-Notes'
    expect(ref.path).toBe(path.join('vault-resolve-Archive', 'Foo.md'));
  });

  test('input with path separator does not fall back to title match', async () => {
    await expect(vault.resolveNoteReference('Nowhere/Foo')).rejects.toThrow(/Could not resolve/);
  });
});

describe('resolveNoteReference — error semantics', () => {
  test('directory input throws EISDIR', async () => {
    try {
      await vault.resolveNoteReference('vault-resolve-DailyDir');
      throw new Error('expected EISDIR');
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      expect(err.code).toBe('EISDIR');
    }
  });

  test('miss throws with a clear suggestion', async () => {
    await expect(vault.resolveNoteReference('vault-resolve-nonesuch')).rejects.toThrow(
      /Could not resolve.*vault_search_title/,
    );
  });

  test('path escape attempts propagate as policy errors', async () => {
    await expect(vault.resolveNoteReference('../escape')).rejects.toThrow(/Path escapes vault root/);
  });

  test('empty input throws', async () => {
    await expect(vault.resolveNoteReference('   ')).rejects.toThrow(/Empty note reference/);
  });
});

describe('resolveNoteReference — caching', () => {
  test('cache hit: a note created out-of-band after the first resolve is not visible until invalidation', async () => {
    // Prime the cache via a title miss on a known absent title.
    await expect(vault.resolveNoteReference('ResolverLatecomer')).rejects.toThrow(/Could not resolve/);

    // Create the file directly via fs (bypassing writeNote so cache stays intact).
    await seed('vault-resolve-Notes/ResolverLatecomer.md');

    try {
      // Cache still reflects pre-create state — still a miss.
      await expect(vault.resolveNoteReference('ResolverLatecomer')).rejects.toThrow(/Could not resolve/);

      // After invalidation, the new note is findable.
      vault.invalidateResolverCache();
      const ref = await vault.resolveNoteReference('ResolverLatecomer');
      expect(ref.path).toBe(path.join('vault-resolve-Notes', 'ResolverLatecomer.md'));
    } finally {
      await rm(path.join(vaultPath, 'vault-resolve-Notes', 'ResolverLatecomer.md'), { force: true });
    }
  });

  test('writeNote invalidates the cache', async () => {
    // Prime cache with a miss
    await expect(vault.resolveNoteReference('ResolverFreshViaWrite')).rejects.toThrow(
      /Could not resolve/,
    );

    try {
      await vault.writeNote('vault-resolve-Notes/ResolverFreshViaWrite.md', '# fresh\n');
      const ref = await vault.resolveNoteReference('ResolverFreshViaWrite');
      expect(ref.path).toBe(path.join('vault-resolve-Notes', 'ResolverFreshViaWrite.md'));
    } finally {
      await rm(path.join(vaultPath, 'vault-resolve-Notes', 'ResolverFreshViaWrite.md'), { force: true });
    }
  });

  test('trashNote invalidates the cache', async () => {
    await vault.writeNote('vault-resolve-Notes/ResolverToTrash.md', '# bye\n');
    try {
      const before = await vault.resolveNoteReference('ResolverToTrash');
      expect(before.matchedVia).toBe('title');

      await vault.trashNote('vault-resolve-Notes/ResolverToTrash.md');
      await expect(vault.resolveNoteReference('ResolverToTrash')).rejects.toThrow(
        /Could not resolve/,
      );
    } finally {
      // Clean up the .trash entry left behind
      await rm(path.join(vaultPath, '.trash'), { recursive: true, force: true });
    }
  });
});
