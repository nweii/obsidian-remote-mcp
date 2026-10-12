// ABOUTME: Runs every exported vault operation against every hostile path shape and fails when an
// export is neither covered here nor listed as taking no vault path, so new operations get policy tests.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';

let vault: typeof import('../src/vault.js');
let base: string;
let vaultPath: string;
let outsidePath: string;
let baseline: Map<string, string>;
let previousEnv: Record<string, string | undefined>;

// Protected file names carry NAME and their contents carry BODY. A path operation may echo the
// caller's own path back, so it is checked for BODY only; scans are checked for both.
const NAME = 'ZNAME';
const BODY = 'ZBODY';
const HIDDEN_NOTE = `---\nsecret: ${BODY}\ntags: [${BODY.toLowerCase()}tag]\n---\n# Heading\n${BODY} text [[Open]] [[Movable]] #${BODY.toLowerCase()}tag\n`;

// Existing protected paths, in every shape a caller could spell them.
const HOSTILE_EXISTING = [
  `Private/${NAME}-hidden.md`,               // ignored folder
  `private/${NAME}-hidden.md`,               // case variant of an ignored folder
  `Projects/Alpha/${NAME}-secret.md`,        // ignored note inside an allowed folder
  `Projects/Alpha/../../Private/${NAME}-hidden.md`, // traversal into an ignored folder
  `.obsidian/${NAME}-settings.md`,           // built-in internal folder
  `Sub/.git/${NAME}-config.md`,              // internal folder below the root
  `Alias/${NAME}-hidden.md`,                 // in-vault symlink into an ignored folder
  `Outside/${NAME}-out.md`,                  // in-vault symlink leading outside the vault
  `../${NAME}-escape.md`,                    // lexical escape
  'Dangling.md',                             // dangling symlink
];

// Paths no write may create or change, including the policy file and new names in protected places.
const HOSTILE_WRITE = [
  ...HOSTILE_EXISTING,
  '.mcpignore',
  '.MCPIGNORE',
  '.mcpignore/new.md',
  'Private/new.md',
  '.obsidian/new.md',
  'Alias/new.md',
  'Outside/new.md',
];

async function snapshot(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(abs: string, rel: string): Promise<void> {
    for (const entry of await readdir(abs)) {
      const childAbs = path.join(abs, entry);
      const childRel = path.join(rel, entry);
      const st = await lstat(childAbs);
      if (st.isSymbolicLink()) out.set(childRel, `link:${await readlink(childAbs)}`);
      else if (st.isDirectory()) {
        out.set(childRel, 'dir');
        await walk(childAbs, childRel);
      } else out.set(childRel, createHash('sha256').update(await readFile(childAbs)).digest('hex'));
    }
  }
  await walk(base, '');
  return out;
}

beforeAll(async () => {
  previousEnv = Object.fromEntries(['VAULT_PATH', 'VAULT_READ_ONLY'].map(key => [key, process.env[key]]));
  base = await mkdtemp(path.join(os.tmpdir(), 'vault-policy-matrix-'));
  vaultPath = path.join(base, 'vault');
  outsidePath = path.join(base, 'outside');
  for (const dir of ['Private', 'Projects/Alpha', '.obsidian/plugins/p', 'Sub/.git']) {
    await mkdir(path.join(vaultPath, dir), { recursive: true });
  }
  await mkdir(outsidePath);
  await writeFile(path.join(vaultPath, '.mcpignore'), `Private\nProjects/Alpha/${NAME}-secret.md\n`);
  await writeFile(path.join(vaultPath, 'Open.md'), '# Heading\nopen body\n');
  await writeFile(path.join(vaultPath, 'Movable.md'), '# Heading\nmovable body\n');
  await writeFile(path.join(vaultPath, 'Projects/Alpha/open.md'), '# Heading\nopen body\n');
  for (const rel of [`Private/${NAME}-hidden.md`, `Projects/Alpha/${NAME}-secret.md`, `.obsidian/${NAME}-settings.md`, `Sub/.git/${NAME}-config.md`]) {
    await writeFile(path.join(vaultPath, rel), HIDDEN_NOTE);
  }
  await writeFile(path.join(vaultPath, '.obsidian/plugins/p/data.json'), `{"key":"${BODY}"}\n`);
  await writeFile(path.join(outsidePath, `${NAME}-out.md`), HIDDEN_NOTE);
  await writeFile(path.join(base, `${NAME}-escape.md`), HIDDEN_NOTE);
  await symlink(path.join(vaultPath, 'Private'), path.join(vaultPath, 'Alias'));
  await symlink(outsidePath, path.join(vaultPath, 'Outside'));
  await symlink(path.join(vaultPath, 'missing.md'), path.join(vaultPath, 'Dangling.md'));
  process.env.VAULT_PATH = vaultPath;
  delete process.env.VAULT_READ_ONLY;
  const query = 'policy-matrix';
  vault = await import(`../src/vault.js?${query}`);
  baseline = await snapshot();
});

afterAll(async () => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(base, { recursive: true, force: true });
});

async function outcome(run: () => unknown): Promise<{ result?: unknown; error?: unknown }> {
  try {
    return { result: await run() };
  } catch (error) {
    return { error };
  }
}

function emptyPlan(filePath: string) {
  return {
    from: 'Movable.md', to: 'Moved.md', isRename: true, basenameCollision: false,
    files: [{ path: filePath, rewrites: [] }], baseFilesToReview: [], skippedLinks: [],
  };
}

// Operations that write. Each must refuse every hostile path with a VaultPolicyError.
const WRITE_OPS: Record<string, (p: string) => unknown> = {
  writeNote: p => vault.writeNote(p, 'x'),
  createNote: p => vault.createNote(p, 'x'),
  updateNote: p => vault.updateNote(p, 'x'),
  setFrontmatterProperty: p => vault.setFrontmatterProperty(p, 'k', 'v'),
  setFrontmatterProperties: p => vault.setFrontmatterProperties(p, { k: 'v' }),
  appendNote: p => vault.appendNote(p, 'x'),
  prependToNote: p => vault.prependToNote(p, 'x'),
  replaceInNote: p => vault.replaceInNote(p, 'text', 'x'),
  editNoteSection: p => vault.editNoteSection(p, 'Heading', 'append', 'x'),
  deleteNote: p => vault.deleteNote(p),
  trashNote: p => vault.trashNote(p),
  'moveFile (source)': p => vault.moveFile(p, 'Moved.md'),
  'moveFile (destination)': p => vault.moveFile('Movable.md', p),
  'moveWithReferences (source)': p => vault.moveWithReferences(p, 'Moved.md'),
  'moveWithReferences (destination)': p => vault.moveWithReferences('Movable.md', p),
};

// Operations that read one named path. Each must refuse every hostile existing path.
const READ_OPS: Record<string, (p: string) => unknown> = {
  resolveSafePath: p => vault.resolveSafePath(p),
  readNote: p => vault.readNote(p),
  readAttachment: p => vault.readAttachment(p),
  getFrontmatter: p => vault.getFrontmatter(p),
  getFrontmatterProperty: p => vault.getFrontmatterProperty(p, 'secret'),
  getNoteOutline: p => vault.getNoteOutline(p),
  readNoteSection: p => vault.readNoteSection(p, 'Heading'),
  getNoteLinks: p => vault.getNoteLinks(p),
  getBacklinks: p => vault.getBacklinks(p),
  resolveNoteReference: p => vault.resolveNoteReference(p),
  listVaultFolder: p => vault.listVaultFolder(p),
  'planReferenceRewrite (source)': p => vault.planReferenceRewrite(p, 'Moved.md'),
  'planReferenceRewrite (destination)': p => vault.planReferenceRewrite('Movable.md', p),
  'planFileMove (source)': p => vault.planFileMove(p, 'Moved.md'),
  'planFileMove (destination)': p => vault.planFileMove('Movable.md', p),
};

// Batch operations report per-item failures instead of throwing.
const BATCH_OPS: Record<string, (p: string) => Promise<boolean>> = {
  readNotesBatch: async p => (await vault.readNotesBatch([p], true)).found.length === 0,
  updateFrontmatterBatch: async p => !(await vault.updateFrontmatterBatch([{ path: p, fields: { k: 'v' } }]))[0]!.updated,
  applyReferenceRewrite: async p => {
    const result = await vault.applyReferenceRewrite(emptyPlan(p));
    return result.modified.length === 0 && result.failures.length === 1;
  },
};

// Operations that walk the vault. Their results must never name or quote a protected note.
const SCAN_OPS: Record<string, () => unknown> = {
  searchContent: () => vault.searchContent(BODY),
  searchFilename: () => vault.searchFilename(NAME),
  searchFrontmatter: () => vault.searchFrontmatter('secret', { matchType: 'exists' }),
  getFolderTree: () => vault.getFolderTree(8),
  'listVaultFolder (root)': () => vault.listVaultFolder(''),
  'listVaultFolder (mixed folder)': () => vault.listVaultFolder('Projects/Alpha'),
  findByTitle: () => vault.findByTitle(NAME),
  getAllTags: () => vault.getAllTags(),
  getNotesByTag: () => vault.getNotesByTag(`${BODY.toLowerCase()}tag`),
  'getBacklinks (allowed note)': () => vault.getBacklinks('Open.md'),
  'resolveNoteReference (title)': () => vault.resolveNoteReference(`${NAME}-hidden`),
  'planReferenceRewrite (allowed note)': () => vault.planReferenceRewrite('Open.md', 'Moved.md'),
};

// Operations on a folder holding a note that a location-specific rule hides.
const FOLDER_OPS: Record<string, () => unknown> = {
  trashNote: () => vault.trashNote('Projects/Alpha'),
  moveFile: () => vault.moveFile('Projects/Alpha', 'Public/Alpha'),
  moveWithReferences: () => vault.moveWithReferences('Projects/Alpha', 'Public/Alpha'),
  planFileMove: () => vault.planFileMove('Projects/Alpha', 'Public/Alpha'),
  planReferenceRewrite: () => vault.planReferenceRewrite('Projects/Alpha', 'Public/Alpha'),
};

// Exports that take no caller-supplied vault path, so no hostile path can reach them.
const NO_PATH_EXPORTS = [
  'getVaultRoot', 'getVaultDisplayName', 'getContextNotePath', 'isReadOnly', 'versionOf',
  'invalidateResolverCache', 'getPeriodicNoteTemplate', 'getPeriodicNoteTemplateEnvVar',
  'getPeriodicNotePath',
];

function leaks(value: unknown, tokens: string[]): boolean {
  const text = value instanceof Error ? value.message : JSON.stringify(value ?? null);
  return tokens.some(token => text.toLowerCase().includes(token.toLowerCase()));
}

test('every exported vault function is covered by the matrix or takes no vault path', () => {
  const covered = new Set(
    [WRITE_OPS, READ_OPS, BATCH_OPS, SCAN_OPS, FOLDER_OPS].flatMap(ops => Object.keys(ops).map(name => name.split(' ')[0]!)),
  );
  const uncovered = Object.entries(vault)
    .filter(([, value]) => typeof value === 'function' && !/^class\b/.test(Function.prototype.toString.call(value)))
    .map(([name]) => name)
    .filter(name => !covered.has(name) && !NO_PATH_EXPORTS.includes(name));
  expect(uncovered).toEqual([]);
});

describe('writes refuse hostile paths', () => {
  for (const [name, run] of Object.entries(WRITE_OPS)) {
    test.each(HOSTILE_WRITE)(`${name}: %s`, async hostile => {
      const { error } = await outcome(() => run(hostile));
      expect(error).toBeInstanceOf(vault.VaultPolicyError);
      expect(leaks(error, [BODY])).toBe(false);
      expect(await snapshot()).toEqual(baseline);
    });
  }
});

describe('reads refuse hostile paths', () => {
  for (const [name, run] of Object.entries(READ_OPS)) {
    test.each(HOSTILE_EXISTING)(`${name}: %s`, async hostile => {
      const { result, error } = await outcome(() => run(hostile));
      expect(result).toBeUndefined();
      expect(error).toBeInstanceOf(vault.VaultPolicyError);
      expect(leaks(error, [BODY])).toBe(false);
      expect(await snapshot()).toEqual(baseline);
    });
  }
});

describe('batch operations report hostile paths as failures', () => {
  for (const [name, run] of Object.entries(BATCH_OPS)) {
    test.each(HOSTILE_WRITE)(`${name}: %s`, async hostile => {
      expect(await run(hostile)).toBe(true);
      expect(await snapshot()).toEqual(baseline);
    });
  }
});

describe('scans never surface protected notes', () => {
  test.each(Object.entries(SCAN_OPS))('%s', async (_, run) => {
    const { result, error } = await outcome(run);
    expect(leaks(result, [NAME, BODY])).toBe(false);
    expect(leaks(error, [BODY])).toBe(false);
    expect(await snapshot()).toEqual(baseline);
  });
});

describe('folder operations refuse a folder holding a hidden note', () => {
  test.each(Object.entries(FOLDER_OPS))('%s', async (_, run) => {
    const { result } = await outcome(run);
    expect(result).toBeUndefined();
    expect(await snapshot()).toEqual(baseline);
  });
});
