// ABOUTME: Tests for getAllTags and getNotesByTag — frontmatter array/comma forms,
// inline #tag rules (code blocks, inline code, headings, URL fragments), nested tags,
// case-insensitive aggregation with first-seen casing, folder scoping, and .mcpignore.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile, rm } from 'fs/promises';
import os from 'os';
import path from 'path';

let vault: typeof import('../src/vault.js');
let vaultPath: string;

async function seed(rel: string, content: string): Promise<void> {
  const full = path.join(vaultPath, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content, 'utf-8');
}

// VAULT_PATH is resolved at module-init, and .mcpignore is read once at init —
// so we write the fixtures and .mcpignore before importing the module, and use a
// unique query string to load a fresh instance that doesn't share VAULT_ROOT
// with other test files in the same `bun test` process.
beforeAll(async () => {
  vaultPath = await mkdtemp(path.join(os.tmpdir(), 'orm-tags-test-'));

  await mkdir(vaultPath, { recursive: true });
  await writeFile(path.join(vaultPath, '.mcpignore'), 'Private\n', 'utf-8');

  // Frontmatter array form.
  await seed(
    'array.md',
    ['---', 'tags:', '  - alpha', '  - beta', '---', 'body with no inline tags', ''].join('\n'),
  );

  // Frontmatter comma-string form.
  await seed(
    'comma.md',
    ['---', 'tags: alpha, beta, gamma', '---', 'body', ''].join('\n'),
  );

  // Frontmatter array with leading-# entries that must be stripped so #beta and
  // beta count as the same tag.
  await seed(
    'hashed.md',
    ['---', 'tags:', '  - "#beta"', '---', 'body', ''].join('\n'),
  );

  // Inline tags plus edge cases that must NOT count.
  await seed(
    'inline.md',
    [
      '# Heading should not count',
      'A real #alpha tag and a nested #parent/child tag.',
      'A URL fragment https://example.com#frag must not count.',
      'Inline code `#nope` must not count.',
      '```',
      '#alsonope inside a fenced block',
      '```',
      'Another #alpha here for occurrence counting.',
      '',
    ].join('\n'),
  );

  // A purely numeric tag is not a tag in Obsidian.
  await seed('numeric.md', ['#123 is not a tag but #v2 is.', ''].join('\n'));

  // Folder-scoped fixtures.
  await seed('Sub/scoped.md', ['#scoped tag here.', ''].join('\n'));

  // Case-insensitive aggregation: first-seen casing wins. "Project" appears
  // (alphabetically) before "project" so the Project casing is first-seen.
  await seed('case-a.md', ['#Project work.', ''].join('\n'));
  await seed('case-b.md', ['#project more work.', ''].join('\n'));

  // .mcpignore'd note — its tags must never appear.
  await seed('Private/secret.md', ['#secret hidden.', ''].join('\n'));

  process.env.VAULT_PATH = vaultPath;
  process.env.VAULT_MCP_TEST = '1';
  vault = await import(`../src/vault.js?vault-tags-test=${Date.now()}`);
});

afterAll(async () => {
  await rm(vaultPath, { recursive: true, force: true });
});

describe('getAllTags', () => {
  test('aggregates frontmatter array and comma-string forms', async () => {
    const tags = await vault.getAllTags();
    const byName = new Map(tags.map(t => [t.tag, t]));
    // alpha appears in array.md, comma.md, and twice inline in inline.md → 3 notes.
    expect(byName.get('alpha')?.noteCount).toBe(3);
    // beta: array.md + comma.md + hashed.md (the "#beta" entry, # stripped) → 3 notes.
    expect(byName.get('beta')?.noteCount).toBe(3);
    expect(byName.get('gamma')?.noteCount).toBe(1);
  });

  test('counts occurrences separately from note presence', async () => {
    const tags = await vault.getAllTags();
    const alpha = tags.find(t => t.tag === 'alpha');
    // inline.md carries #alpha twice → 1 note there, 2 occurrences there;
    // total across array.md + comma.md + inline.md(x2) = 4 occurrences, 3 notes.
    expect(alpha?.noteCount).toBe(3);
    expect(alpha?.occurrences).toBe(4);
  });

  test('excludes headings, URL fragments, inline code, and fenced code blocks', async () => {
    const tags = await vault.getAllTags();
    const names = tags.map(t => t.tag);
    expect(names).toContain('parent/child');
    expect(names).not.toContain('frag');
    expect(names).not.toContain('nope');
    expect(names).not.toContain('alsonope');
    // The heading text "Heading" must not be picked up as a tag.
    expect(names).not.toContain('Heading');
  });

  test('a purely numeric tag is not counted; a mixed one is', async () => {
    const tags = await vault.getAllTags();
    const names = tags.map(t => t.tag);
    expect(names).not.toContain('123');
    expect(names).toContain('v2');
  });

  test('aggregates case-insensitively and displays first-seen casing', async () => {
    const tags = await vault.getAllTags();
    const project = tags.filter(t => t.tag.toLowerCase() === 'project');
    expect(project.length).toBe(1);
    expect(project[0].tag).toBe('Project');
    expect(project[0].noteCount).toBe(2);
  });

  test('sorts by note count descending', async () => {
    const tags = await vault.getAllTags();
    for (let i = 1; i < tags.length; i++) {
      expect(tags[i - 1].noteCount).toBeGreaterThanOrEqual(tags[i].noteCount);
    }
  });

  test('respects .mcpignore', async () => {
    const tags = await vault.getAllTags();
    expect(tags.map(t => t.tag)).not.toContain('secret');
  });

  test('folder scope limits the scan', async () => {
    const tags = await vault.getAllTags({ folder: 'Sub' });
    expect(tags.map(t => t.tag)).toEqual(['scoped']);
  });
});

describe('getNotesByTag', () => {
  test('returns note paths carrying the tag', async () => {
    const paths = await vault.getNotesByTag('alpha');
    expect(paths.sort()).toEqual(['array.md', 'comma.md', 'inline.md']);
  });

  test('tolerates a leading # on the query', async () => {
    const paths = await vault.getNotesByTag('#gamma');
    expect(paths).toEqual(['comma.md']);
  });

  test('frontmatter entries written with a leading # match the bare form', async () => {
    const paths = await vault.getNotesByTag('beta');
    expect(paths.sort()).toEqual(['array.md', 'comma.md', 'hashed.md']);
  });

  test('matches case-insensitively', async () => {
    const paths = await vault.getNotesByTag('PROJECT');
    expect(paths.sort()).toEqual(['case-a.md', 'case-b.md']);
  });

  test('nested tags are exact — querying parent does not match parent/child', async () => {
    expect(await vault.getNotesByTag('parent')).toEqual([]);
    expect(await vault.getNotesByTag('parent/child')).toEqual(['inline.md']);
  });

  test('returns empty for an unknown tag', async () => {
    expect(await vault.getNotesByTag('doesnotexist')).toEqual([]);
  });

  test('respects folder scope', async () => {
    expect(await vault.getNotesByTag('scoped', { folder: 'Sub' })).toEqual(['Sub/scoped.md']);
    expect(await vault.getNotesByTag('alpha', { folder: 'Sub' })).toEqual([]);
  });
});
