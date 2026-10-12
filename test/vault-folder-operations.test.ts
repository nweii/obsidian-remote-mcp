// ABOUTME: Verifies folder move/trash preflight safety and link rewrites across moved
// descendants, plus a synthetic-vault performance measurement without a timing assertion.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync } from 'fs';
import fsPromises from 'fs/promises';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { withPathLock } from '../src/lock.js';

let vault: typeof import('../src/vault.js');
let fixtureRoot: string;
let vaultPath: string;
let savedEnv: Map<string, string | undefined>;
const envKeys = ['VAULT_PATH', 'VAULT_READ_ONLY', 'VAULT_MCP_TEST'];

beforeAll(async () => {
  savedEnv = new Map(envKeys.map(key => [key, process.env[key]]));
  vault = await import('../src/vault.js');
});

beforeEach(async () => {
  fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'vault-folder-operations-'));
  vaultPath = path.join(fixtureRoot, 'vault');
  await mkdir(vaultPath);
  process.env.VAULT_PATH = vaultPath;
  process.env.VAULT_MCP_TEST = '1';
  delete process.env.VAULT_READ_ONLY;
  await seed('.mcpignore', '');
});

afterEach(async () => {
  delete process.env.VAULT_READ_ONLY;
  await rm(fixtureRoot, { recursive: true, force: true });
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

async function seed(relativePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(abs(relativePath)), { recursive: true });
  await writeFile(abs(relativePath), content);
}

function read(relativePath: string): Promise<string> {
  return readFile(abs(relativePath), 'utf-8');
}

// Capture the complete tree without following symlinks, so rejected operations must
// preserve hidden files, empty directories, policy aliases, and link targets as well.
async function snapshot(directory = vaultPath): Promise<string[]> {
  const entries: string[] = [];
  async function walk(full: string, relative: string) {
    const stat = await lstat(full);
    if (stat.isSymbolicLink()) entries.push(`link ${relative} ${await readlink(full)}`);
    else if (stat.isDirectory()) {
      entries.push(`dir ${relative}`);
      for (const name of (await readdir(full)).sort()) await walk(path.join(full, name), path.join(relative, name));
    } else entries.push(`file ${relative} ${(await readFile(full)).toString('base64')}`);
  }
  await walk(directory, '');
  return entries;
}

async function expectUnchanged(operation: () => Promise<unknown>) {
  const before = await snapshot(fixtureRoot);
  await expect(operation()).rejects.toThrow();
  expect(await snapshot(fixtureRoot)).toEqual(before);
}

async function moveAndRewrite(from: string, to: string) {
  const plan = await vault.planReferenceRewrite(from, to);
  await vault.moveFile(from, to);
  return vault.applyReferenceRewrite(plan);
}

describe('safe folder moves and trash', () => {
  test('moves nested files, hidden descendants, and empty directories together', async () => {
    await seed('Source/Nested/Note.md', 'note\n');
    await seed('Source/.hidden/Guide.md', 'hidden guidance\n');
    await seed('Source/.claude/CLAUDE.md', 'hidden agent context\n');
    await seed('Source/.keep', 'metadata\n');
    await mkdir(abs('Source/Empty'));
    const result = await vault.moveFile('Source', 'Archive/Deep/Destination');
    expect(result).toEqual({ from: 'Source', to: 'Archive/Deep/Destination' });
    expect(existsSync(abs('Source'))).toBe(false);
    expect(await read('Archive/Deep/Destination/Nested/Note.md')).toBe('note\n');
    expect(await read('Archive/Deep/Destination/.hidden/Guide.md')).toBe('hidden guidance\n');
    expect(await read('Archive/Deep/Destination/.claude/CLAUDE.md')).toBe('hidden agent context\n');
    expect(await read('Archive/Deep/Destination/.keep')).toBe('metadata\n');
    expect(await readdir(abs('Archive/Deep/Destination/Empty'))).toEqual([]);
  });

  test('moves an empty folder and can trash an empty folder', async () => {
    await mkdir(abs('Empty'));
    await vault.moveFile('Empty', 'Moved/Empty');
    expect(await readdir(abs('Moved/Empty'))).toEqual([]);
    await vault.trashNote('Moved/Empty');
    expect(existsSync(abs('Moved/Empty'))).toBe(false);
    const trashed = await readdir(abs('.trash'));
    expect(trashed).toHaveLength(1);
    expect(await readdir(abs(`.trash/${trashed[0]}`))).toEqual([]);
  });

  test('trashes a complete allowed tree even when .trash is excluded', async () => {
    await seed('.mcpignore', '.trash\n');
    await seed('Source/Nested/Note.md', 'note\n');
    await seed('Source/.hidden.md', 'hidden\n');
    await mkdir(abs('Source/Empty'));
    await vault.trashNote('Source');
    expect(existsSync(abs('Source'))).toBe(false);
    const trashed = await readdir(abs('.trash'));
    expect(trashed).toHaveLength(1);
    const root = `.trash/${trashed[0]}`;
    expect(await read(`${root}/Nested/Note.md`)).toBe('note\n');
    expect(await read(`${root}/.hidden.md`)).toBe('hidden\n');
    expect(await readdir(abs(`${root}/Empty`))).toEqual([]);
  });

  test('ignored source descendants prevent both move and trash without side effects', async () => {
    await seed('.mcpignore', 'Source/Nested/Secret.md\n');
    await seed('Source/Open.md', 'open\n');
    await seed('Source/Nested/Secret.md', 'secret\n');
    await expectUnchanged(() => vault.moveFile('Source', 'New/Parents/Moved'));
    await expectUnchanged(() => vault.trashNote('Source'));
    await expectUnchanged(() => vault.planReferenceRewrite('Source', 'New/Parents/Moved'));
  });

  test('excluded destination descendants prevent a move before parent creation', async () => {
    await seed('.mcpignore', 'Archive/Moved/Nested/Note.md\n');
    await seed('Source/Nested/Note.md', 'body\n');
    await expectUnchanged(() => vault.moveFile('Source', 'Archive/Moved'));
    await expectUnchanged(() => vault.planReferenceRewrite('Source', 'Archive/Moved'));
  });

  test('internal folders at any depth block moving or trashing their containing tree', async () => {
    for (const internal of ['.obsidian', '.git']) {
      await seed(`Source/Nested/${internal}/settings.json`, 'private settings\n');
      await expectUnchanged(() => vault.moveFile('Source', 'Moved'));
      await expectUnchanged(() => vault.trashNote('Source'));
      await rm(abs(`Source/Nested/${internal}`), { recursive: true });
    }
  });

  test('rejects symlinked source roots and descendants, allowing safe destination-parent aliases', async () => {
    await seed('Source/Note.md', 'source\n');
    await seed('Other/Note.md', 'other\n');
    await symlink(abs('Source'), abs('Alias'));
    await expectUnchanged(() => vault.moveFile('Alias', 'Moved'));
    await expectUnchanged(() => vault.trashNote('Alias'));
    await symlink(abs('Other'), abs('Source/Shortcut'));
    await expectUnchanged(() => vault.moveFile('Source', 'Moved'));
    await expectUnchanged(() => vault.trashNote('Source'));
    await rm(abs('Source/Shortcut'));
    await symlink(abs('Other'), abs('DestinationAlias'));
    await seed('.mcpignore', 'Other/Moved/Note.md\n');
    await expectUnchanged(() => vault.moveFile('Source', 'DestinationAlias/Moved'));
    await seed('.mcpignore', '');
    await vault.moveFile('Source', 'DestinationAlias/Moved');
    expect(await read('Other/Moved/Note.md')).toBe('source\n');
    expect(await read('Other/Note.md')).toBe('other\n');
    expect(existsSync(abs('Source'))).toBe(false);
  });

  test('standalone file symlinks move only when the target remains unchanged', async () => {
    await seed('Same/Note.md', 'target\n');
    await symlink(abs('Same/Note.md'), abs('Absolute.md'));
    await vault.moveFile('Absolute.md', 'Archive/Absolute.md');
    expect(await read('Archive/Absolute.md')).toBe('target\n');
    expect(await readlink(abs('Archive/Absolute.md'))).toBe(abs('Same/Note.md'));
    await symlink('Note.md', abs('Same/Relative.md'));
    await vault.moveFile('Same/Relative.md', 'Same/Renamed.md');
    expect(await read('Same/Renamed.md')).toBe('target\n');
    expect(await readlink(abs('Same/Renamed.md'))).toBe('Note.md');
    await expectUnchanged(() => vault.moveFile('Same/Renamed.md', 'Elsewhere/Relative.md'));
    expect(await read('Same/Note.md')).toBe('target\n');
  });

  test('refuses folder sources through a symlinked parent alias', async () => {
    await seed('Source/Nested/Note.md', 'note\n');
    await symlink(abs('Source'), abs('SourceAlias'));
    await expectUnchanged(() => vault.moveFile('SourceAlias/Nested', 'Moved'));
    await expectUnchanged(() => vault.trashNote('SourceAlias/Nested'));
    await expectUnchanged(() => vault.planReferenceRewrite('SourceAlias/Nested', 'Moved'));
  });

  test('a configured vault-root symlink still permits ordinary folder moves', async () => {
    await seed('Source/Nested/Note.md', 'note\n');
    const rootAlias = path.join(fixtureRoot, 'vault-alias');
    await symlink(vaultPath, rootAlias);
    process.env.VAULT_PATH = rootAlias;
    try {
      await moveAndRewrite('Source', 'Archive/Moved');
      expect(await read('Archive/Moved/Nested/Note.md')).toBe('note\n');
      expect(existsSync(abs('Source'))).toBe(false);
    } finally {
      process.env.VAULT_PATH = vaultPath;
    }
  });

  test('rejects an outside or dangling symlink nested in the moved tree', async () => {
    const outside = path.join(fixtureRoot, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'Secret.md'), 'outside secret\n');
    await seed('Source/Open.md', 'public\n');
    for (const target of [outside, path.join(outside, 'missing')]) {
      await symlink(target, abs('Source/Link'));
      await expectUnchanged(() => vault.moveFile('Source', 'Archive/Moved'));
      await expectUnchanged(() => vault.trashNote('Source'));
      await rm(abs('Source/Link'));
    }
  });

  test('policy files and hardlink aliases cannot be carried in a folder', async () => {
    await seed('Source/Note.md', 'note\n');
    await seed('Source/.mcpignore', 'nested policy text\n');
    // The vault's actual policy has a different inode; carrying the nested file does not
    // mutate it. Protect actual policy aliases even when their names look ordinary.
    await link(abs('.mcpignore'), abs('Source/PolicyAlias.md'));
    await expectUnchanged(() => vault.moveFile('Source', 'Moved'));
    await expectUnchanged(() => vault.trashNote('Source'));
    await expectUnchanged(() => vault.moveFile('', 'RootCopy'));
  });

  test('a symlinked access policy protects its containing source folder', async () => {
    await seed('Source/Policy.txt', '');
    await seed('Source/Note.md', 'note\n');
    await rm(abs('.mcpignore'));
    await symlink(abs('Source/Policy.txt'), abs('.mcpignore'));
    await expectUnchanged(() => vault.moveFile('Source', 'Moved'));
    await expectUnchanged(() => vault.trashNote('Source'));
  });

  test('rejects self, descendant, and overlapping ancestor destinations', async () => {
    await seed('Parent/Source/Nested/Note.md', 'body\n');
    for (const destination of ['Parent/Source', 'Parent/Source/New', 'Parent']) {
      await expectUnchanged(() => vault.moveFile('Parent/Source', destination));
      await expectUnchanged(() => vault.planReferenceRewrite('Parent/Source', destination));
    }
  });

  test('does not replace an existing empty or populated destination folder', async () => {
    await seed('Source/Note.md', 'source\n');
    await mkdir(abs('EmptyTarget'));
    await seed('PopulatedTarget/Keep.md', 'keep\n');
    for (const destination of ['EmptyTarget', 'PopulatedTarget']) {
      await expectUnchanged(() => vault.moveFile('Source', destination));
      await expectUnchanged(() => vault.planReferenceRewrite('Source', destination));
    }
  });

  test('read-only blocks folder writes but permits a complete dry-run plan', async () => {
    await seed('Source/Note.md', 'note\n');
    await seed('Reference.md', '[[Source/Note]]\n');
    process.env.VAULT_READ_ONLY = 'true';
    const before = await snapshot();
    const plan = await vault.planReferenceRewrite('Source', 'Archive/Moved');
    expect(plan.files.length).toBeGreaterThan(0);
    expect(await snapshot()).toEqual(before);
    await expectUnchanged(() => vault.moveFile('Source', 'Archive/Moved'));
    await expectUnchanged(() => vault.trashNote('Source'));
    await expectUnchanged(() => vault.applyReferenceRewrite(plan));
  });

  test('waits for a descendant lock and rejects a protected entry added while waiting', async () => {
    await seed('.mcpignore', 'Source/Secret.md\n');
    await seed('Source/Nested/Note.md', 'note\n');
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const locked = withPathLock(abs('Source/Nested/Note.md'), async () => {
      entered();
      await gate;
    });
    await started;
    const moving = vault.moveFile('Source', 'New/Parents/Moved');
    let settled = false;
    void moving.then(() => { settled = true; }, () => { settled = true; });
    try {
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(settled).toBe(false);
      await writeFile(abs('Source/Secret.md'), 'new protected file\n');
      const beforeRelease = await snapshot();
      release();
      await expect(moving).rejects.toThrow(vault.VaultPolicyError);
      expect(await snapshot()).toEqual(beforeRelease);
    } finally {
      release();
      await locked;
      await moving.catch(() => {});
    }
  });
});

describe('folder move reference rewrites', () => {
  test('dry run plans external and moved hidden references without modifying anything', async () => {
    await seed('Source/Note.md', '[[Source/Other]]\n');
    await seed('Source/Other.md', 'other\n');
    await seed('Source/.hidden/Ref.md', '[[Source/Note#Heading|alias]]\n');
    await seed('Reference.md', '![[Source/Other]]\n');
    const before = await snapshot();
    const plan = await vault.planReferenceRewrite('Source', 'Archive/Moved');
    expect(plan.files.length).toBeGreaterThan(0);
    expect(await snapshot()).toEqual(before);
  });

  test('rewrites path links with aliases, anchors, embeds and frontmatter, retaining bare names and code', async () => {
    await seed('Source/Note.md', 'note\n');
    await seed('Source/Nested/Other.md', 'other\n');
    await seed('Source/image.png', 'image bytes');
    const original = '---\nrelated: "[[Source/Note#Heading|frontmatter alias]]"\n' +
      'links: ["[[Source/Nested/Other]]", "![[Source/image.png]]"]\n---\n' +
      '[[Source/Note]] [[Source/Note.md#^block|alias]] ![[Source/image.png|640]]\n' +
      '[[Note]] [[Other]] ![[image.png]] [[Sourceish/Note]]\n' +
      '`[[Source/Note]]`\n```md\n[[Source/Nested/Other]]\n```\n';
    await seed('Reference.md', original);
    const result = await moveAndRewrite('Source', 'Archive/Moved');
    expect(result.failures).toEqual([]);
    expect(await read('Reference.md')).toBe(original
      .replace('[[Source/Note#Heading|frontmatter alias]]', '[[Archive/Moved/Note#Heading|frontmatter alias]]')
      .replace('links: ["[[Source/Nested/Other]]", "![[Source/image.png]]"]',
        'links: ["[[Archive/Moved/Nested/Other]]", "![[Archive/Moved/image.png]]"]')
      .replace('[[Source/Note]] [[Source/Note.md#^block|alias]] ![[Source/image.png|640]]',
        '[[Archive/Moved/Note]] [[Archive/Moved/Note.md#^block|alias]] ![[Archive/Moved/image.png|640]]'));
    expect(result.modified).toContain('Reference.md');
  });

  test('rewrites internal hidden notes and canvases at their new paths', async () => {
    await seed('Source/Note.md', '[[Source/Nested/Other#Heading]]\n');
    await seed('Source/Nested/Other.md', '[[Source/Note|back]]\n');
    await seed('Source/.hidden/Ref.md', '[[Source/Note]]\n');
    await seed('Source/.hidden/Board.canvas', JSON.stringify({ nodes: [{ id: '1', type: 'file', file: 'Source/Note.md', subpath: '#Heading' }] }));
    await seed('External.canvas', JSON.stringify({ nodes: [{ id: '1', type: 'file', file: 'Source/Nested/Other.md' }] }));
    await seed('Source/.hidden/Review.base', 'filter: file.path == "Source/Note.md"\n');
    const result = await moveAndRewrite('Source', 'Archive/Moved');
    expect(result.failures).toEqual([]);
    expect(await read('Archive/Moved/Note.md')).toBe('[[Archive/Moved/Nested/Other#Heading]]\n');
    expect(await read('Archive/Moved/Nested/Other.md')).toBe('[[Archive/Moved/Note|back]]\n');
    expect(await read('Archive/Moved/.hidden/Ref.md')).toBe('[[Archive/Moved/Note]]\n');
    expect(JSON.parse(await read('Archive/Moved/.hidden/Board.canvas')).nodes[0])
      .toEqual({ id: '1', type: 'file', file: 'Archive/Moved/Note.md', subpath: '#Heading' });
    expect(JSON.parse(await read('External.canvas')).nodes[0].file).toBe('Archive/Moved/Nested/Other.md');
    expect(await read('Archive/Moved/.hidden/Review.base')).toBe('filter: file.path == "Source/Note.md"\n');
    expect(result.modified).toContain('Archive/Moved/.hidden/Ref.md');
    expect(result.baseFilesToReview).toContain('Archive/Moved/.hidden/Review.base');
  });

  test('does not cascade mappings when folder names overlap', async () => {
    await seed('A/Note.md', 'note\n');
    await seed('A/Nested/Other.md', 'other\n');
    await seed('AA/Note.md', 'similar prefix\n');
    await seed('Reference.md', '[[A/Note]] [[A/Nested/Other]] [[AA/Note]]\n');
    const result = await moveAndRewrite('A', 'AA/Moved');
    expect(result.failures).toEqual([]);
    expect(await read('Reference.md')).toBe('[[AA/Moved/Note]] [[AA/Moved/Nested/Other]] [[AA/Note]]\n');
  });

  test('refuses ambiguous case-folded or extensionless rewrite mappings before any mutation', async () => {
    for (const names of [['Case.md', 'case.md'], ['Note', 'Note.md']]) {
      await seed(`Source/${names[0]}`, 'first\n');
      await seed(`Source/${names[1]}`, 'second\n');
      const first = await lstat(abs(`Source/${names[0]}`));
      const second = await lstat(abs(`Source/${names[1]}`));
      // A case-insensitive filesystem cannot create the first pair as distinct entries.
      if (first.ino !== second.ino || first.dev !== second.dev) {
        await expectUnchanged(() => vault.planReferenceRewrite('Source', 'Moved'));
      }
      await rm(abs('Source'), { recursive: true });
    }
  });

  test('reads each rewrite candidate once during folder planning', async () => {
    const candidates = ['Source/One.md', 'Source/Two.md', 'Source/.claude/Context.md',
      'Reference.md', 'Board.canvas', 'Review.base'];
    for (const relativePath of candidates) {
      await seed(relativePath, relativePath.endsWith('.canvas') ? '{"nodes":[]}' : '[[Source/One]]\n');
    }
    const reads = spyOn(fsPromises, 'readFile');
    try {
      await vault.planReferenceRewrite('Source', 'Moved');
      for (const relativePath of candidates) {
        expect(reads.mock.calls.filter(([file]) => String(file) === abs(relativePath))).toHaveLength(1);
      }
    } finally {
      reads.mockRestore();
    }
  });

  const benchmark = process.env.VAULT_FOLDER_BENCH === '1' ? test : test.skip;
  benchmark('measures planning and rewriting on a 2200-file synthetic vault', async () => {
    const movedCount = 200;
    const referenceCount = 1000;
    const unrelatedCount = 1000;
    const movedPath = (index: number) => `Moving/Group${Math.floor(index / 20)}/Note${index}`;
    const fixtures: [string, string][] = [];
    for (let i = 0; i < movedCount; i++) fixtures.push([`${movedPath(i)}.md`, `# Note ${i}\nbody\n`]);
    for (let i = 0; i < referenceCount; i++) fixtures.push([`References/Ref${i}.md`, `[[${movedPath(i % movedCount)}#Heading|alias]]\n`]);
    for (let i = 0; i < unrelatedCount; i++) fixtures.push([`Unrelated/Note${i}.md`, 'unrelated text\n']);
    for (let offset = 0; offset < fixtures.length; offset += 50) {
      await Promise.all(fixtures.slice(offset, offset + 50).map(([relativePath, content]) => seed(relativePath, content)));
    }
    const started = performance.now();
    const plan = await vault.planReferenceRewrite('Moving', 'Archive/Moved');
    const planned = performance.now();
    await vault.moveFile('Moving', 'Archive/Moved');
    const moved = performance.now();
    const result = await vault.applyReferenceRewrite(plan);
    const rewritten = performance.now();
    console.log(`[folder benchmark] 2200 files, 200 moved, 1000 references: plan ${(planned - started).toFixed(0)}ms, ` +
      `move ${(moved - planned).toFixed(0)}ms, rewrite ${(rewritten - moved).toFixed(0)}ms`);
    expect(result.failures).toEqual([]);
    expect(result.modified).toHaveLength(referenceCount);
    expect(existsSync(abs('Moving'))).toBe(false);
    expect(await read('References/Ref999.md')).toBe('[[Archive/Moved/Group9/Note199#Heading|alias]]\n');
    expect(await read('Archive/Moved/Group9/Note199.md')).toBe('# Note 199\nbody\n');
    expect(await read('Unrelated/Note999.md')).toBe('unrelated text\n');
  }, 30000);

  for (const count of [1000, 10000]) {
    benchmark(`measures preflight and planning for ${count} flat moved files`, async () => {
      for (let offset = 0; offset < count; offset += 50) {
        await Promise.all(Array.from({ length: Math.min(50, count - offset) }, (_, index) => {
          const number = offset + index;
          return seed(`Moving/Note${number}.md`, `# Note ${number}\nbody\n`);
        }));
      }
      await seed('Reference.md', `[[Moving/Note0]] [[Moving/Note${count - 1}]]\n`);
      const started = performance.now();
      const movement = vault.planFileMove('Moving', 'Archive/Moved');
      const checked = performance.now();
      const reads = spyOn(fsPromises, 'readFile');
      let plan: Awaited<ReturnType<typeof vault.planReferenceRewrite>>;
      let contentReads: number;
      try {
        plan = await vault.planReferenceRewrite('Moving', 'Archive/Moved');
        contentReads = reads.mock.calls.length;
      } finally {
        reads.mockRestore();
      }
      const planned = performance.now();
      console.log(`[folder benchmark] ${count} flat moved files: preflight ${(checked - started).toFixed(0)}ms, ` +
        `planning ${(planned - checked).toFixed(0)}ms, ${contentReads!} content reads`);
      expect(movement.files).toHaveLength(count);
      expect(plan!.files.map(file => file.path)).toContain('Reference.md');
      expect(contentReads!).toBe(count + 1);
      expect(existsSync(abs('Archive'))).toBe(false);
    }, 60000);
  }
});
