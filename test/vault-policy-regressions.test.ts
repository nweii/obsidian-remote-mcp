// ABOUTME: Regression coverage for symlink policy bypasses and protection of the live ignore file.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'fs';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';

let vault: typeof import('../src/vault.js');
let base: string;
let vaultPath: string;
let outsidePath: string;
let importNumber = 0;
let previousEnv: Record<string, string | undefined>;
const POLICY = '# Policy\n# [[Private]]\nPrivate\n';
const POLICY_PATHS = ['.mcpignore', 'Public/Policy.md', 'AliasRoot/.mcpignore'];

beforeEach(async () => {
  previousEnv = Object.fromEntries(
    ['VAULT_PATH', 'VAULT_READ_ONLY', 'VAULT_CONTEXT_PATH'].map(key => [key, process.env[key]]),
  );
  base = await mkdtemp(path.join(os.tmpdir(), 'vault-policy-regression-'));
  vaultPath = path.join(base, 'vault');
  outsidePath = path.join(base, 'outside');
  await mkdir(path.join(vaultPath, 'Private'), { recursive: true });
  await mkdir(path.join(vaultPath, 'Public'), { recursive: true });
  await mkdir(outsidePath);
  await writeFile(path.join(vaultPath, '.mcpignore'), POLICY);
  await writeFile(path.join(vaultPath, 'Private/Secret.md'), '---\nstatus: secret\n---\nSECRET body #secret\n');
  await writeFile(path.join(vaultPath, 'Public/Open.md'), '---\nstatus: public\n---\npublic body #public\n');
  await writeFile(path.join(vaultPath, '.context.md'), 'hidden context\n');
  await symlink(path.join(vaultPath, 'Public/Open.md'), path.join(vaultPath, 'Private/Alias.md'));
  await symlink(vaultPath, path.join(vaultPath, 'AliasRoot'));
  await symlink(path.join(vaultPath, '.mcpignore'), path.join(vaultPath, 'Public/Policy.md'));
  process.env.VAULT_PATH = vaultPath;
  delete process.env.VAULT_READ_ONLY;
  delete process.env.VAULT_CONTEXT_PATH;
  vault = await import(`../src/vault.js?policy-regression=${++importNumber}`);
});

afterEach(async () => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(base, { recursive: true, force: true });
});

describe('symlink access policy regressions', () => {
  test('an ignored lexical path stays blocked when its symlink target is public', async () => {
    await expect(vault.readNote('Private/Alias.md')).rejects.toBeInstanceOf(vault.VaultPolicyError);
    await expect(vault.updateNote('Private/Alias.md', 'changed\n')).rejects.toBeInstanceOf(vault.VaultPolicyError);
    await expect(vault.trashNote('Private/Alias.md')).rejects.toBeInstanceOf(vault.VaultPolicyError);
    expect((await lstat(path.join(vaultPath, 'Private/Alias.md'))).isSymbolicLink()).toBe(true);
    expect(await readFile(path.join(vaultPath, 'Public/Open.md'), 'utf-8')).toContain('public body');
  });

  test('a root alias used as a search scope cannot expose ignored descendants', async () => {
    expect(await vault.searchContent('SECRET', { folder: 'AliasRoot' })).toEqual([]);
    expect(await vault.searchFrontmatter('status', { value: 'secret', folder: 'AliasRoot' })).toEqual([]);
    expect(await vault.getNotesByTag('secret', { folder: 'AliasRoot' })).toEqual([]);
    expect((await vault.getAllTags({ folder: 'AliasRoot' })).map(tag => tag.tag)).not.toContain('secret');
    expect(await vault.searchContent('public body', { folder: 'AliasRoot' })).toHaveLength(1);
    expect((await vault.listVaultFolder('AliasRoot')).map(entry => entry.name)).not.toContain('Private');
  });

  for (const target of ['new.md', 'missing-parent/new.md']) {
    test(`append through a dangling file symlink to outside/${target} is refused`, async () => {
      await symlink(path.join(outsidePath, target), path.join(vaultPath, 'Dangling.md'));
      expect(() => vault.resolveSafePath('Dangling.md')).toThrow(vault.VaultPolicyError);
      await expect(vault.appendNote('Dangling.md', 'escaped\n')).rejects.toBeInstanceOf(vault.VaultPolicyError);
      expect(existsSync(path.join(outsidePath, target))).toBe(false);
      expect(existsSync(path.join(outsidePath, 'missing-parent'))).toBe(false);
    });
  }

  test('a dangling directory symlink is checked before creating missing parents', async () => {
    await symlink(path.join(outsidePath, 'missing'), path.join(vaultPath, 'EscapeMissing'));
    expect(() => vault.resolveSafePath('EscapeMissing/Nested/New.md')).toThrow(vault.VaultPolicyError);
    await expect(vault.writeNote('EscapeMissing/Nested/New.md', 'escaped\n')).rejects.toBeInstanceOf(vault.VaultPolicyError);
    expect(existsSync(path.join(outsidePath, 'missing'))).toBe(false);
  });

  test('explicit hidden context access remains available', async () => {
    process.env.VAULT_CONTEXT_PATH = '.context.md';
    expect(vault.getContextNotePath()).toBe('.context.md');
    await expect(vault.readNote('.context.md')).resolves.toBe('hidden context\n');
    await vault.appendNote('.context.md', 'still editable\n');
    await expect(vault.readNote('.context.md')).resolves.toBe('hidden context\nstill editable\n');
    expect((await vault.listVaultFolder()).map(entry => entry.name)).not.toContain('.context.md');
  });

  test('trash refuses an external .trash symlink and leaves the source in place', async () => {
    await symlink(outsidePath, path.join(vaultPath, '.trash'));
    await expect(vault.trashNote('Public/Open.md')).rejects.toBeInstanceOf(vault.VaultPolicyError);
    expect(await readFile(path.join(vaultPath, 'Public/Open.md'), 'utf-8')).toContain('public body');
    expect(await readdir(outsidePath)).toEqual([]);
  });

  test('an ignored internal .trash directory still accepts trashed notes', async () => {
    await writeFile(path.join(vaultPath, '.mcpignore'), POLICY + '.trash\n');
    await vault.trashNote('Public/Open.md');
    expect(existsSync(path.join(vaultPath, 'Public/Open.md'))).toBe(false);
    const trashed = await readdir(path.join(vaultPath, '.trash'));
    expect(trashed).toHaveLength(1);
    expect(await readFile(path.join(vaultPath, '.trash', trashed[0]!), 'utf-8')).toContain('public body');
    expect(() => vault.resolveSafePath(path.join('.trash', trashed[0]!))).toThrow(vault.VaultPolicyError);
  });
});

describe('ignore configuration can be read but cannot be mutated through vault operations', () => {
  test('direct and aliased reads of .mcpignore remain available', async () => {
    for (const relativePath of POLICY_PATHS) {
      await expect(vault.readNote(relativePath)).resolves.toBe(POLICY);
    }
  });

  const mutations: Array<[string, (relativePath: string) => Promise<unknown>]> = [
    ['write', relativePath => vault.writeNote(relativePath, '')],
    ['create', relativePath => vault.createNote(relativePath, '')],
    ['update', relativePath => vault.updateNote(relativePath, '')],
    ['append', relativePath => vault.appendNote(relativePath, 'Public\n')],
    ['prepend', relativePath => vault.prependToNote(relativePath, 'Public\n')],
    ['replace', relativePath => vault.replaceInNote(relativePath, 'Private', 'Public')],
    ['edit section', relativePath => vault.editNoteSection(relativePath, 'Policy', 'replace', 'Public\n')],
    ['set frontmatter', relativePath => vault.setFrontmatterProperty(relativePath, 'changed', true)],
    ['set several frontmatter keys', relativePath => vault.setFrontmatterProperties(relativePath, { changed: true, other: 1 })],
    ['delete', relativePath => vault.deleteNote(relativePath)],
    ['trash', relativePath => vault.trashNote(relativePath)],
    ['move source', relativePath => vault.moveFile(relativePath, 'Public/Moved.md')],
    ['move destination', relativePath => vault.moveFile('Public/Open.md', relativePath)],
  ];

  for (const relativePath of POLICY_PATHS) {
    for (const [operation, mutate] of mutations) {
      test(`${operation} refuses ${relativePath}`, async () => {
        await expect(mutate(relativePath)).rejects.toBeInstanceOf(vault.VaultPolicyError);
        expect(await readFile(path.join(vaultPath, '.mcpignore'), 'utf-8')).toBe(POLICY);
        expect((await lstat(path.join(vaultPath, 'Public/Policy.md'))).isSymbolicLink()).toBe(true);
        expect(existsSync(path.join(vaultPath, 'Public/Open.md'))).toBe(true);
        expect(existsSync(path.join(vaultPath, 'Public/Moved.md'))).toBe(false);
      });
    }
  }

  test('create cannot introduce a missing root .mcpignore', async () => {
    await rm(path.join(vaultPath, '.mcpignore'));
    await expect(vault.createNote('.mcpignore', 'Public\n')).rejects.toBeInstanceOf(vault.VaultPolicyError);
    expect(existsSync(path.join(vaultPath, '.mcpignore'))).toBe(false);
  });

  test('a symlinked .mcpignore protects its canonical target from edits', async () => {
    await mkdir(path.join(vaultPath, 'Config'));
    await writeFile(path.join(vaultPath, 'Config/policy.txt'), POLICY);
    await rm(path.join(vaultPath, '.mcpignore'));
    await symlink(path.join(vaultPath, 'Config/policy.txt'), path.join(vaultPath, '.mcpignore'));
    await expect(vault.readNote('Config/policy.txt')).resolves.toBe(POLICY);
    for (const [, mutate] of mutations) {
      await expect(mutate('Config/policy.txt')).rejects.toBeInstanceOf(vault.VaultPolicyError);
    }
    expect(await readFile(path.join(vaultPath, 'Config/policy.txt'), 'utf-8')).toBe(POLICY);
    expect((await lstat(path.join(vaultPath, '.mcpignore'))).isSymbolicLink()).toBe(true);
  });

  for (const operation of ['trash', 'move'] as const) {
    test(`${operation} refuses a directory containing the canonical policy target`, async () => {
      await mkdir(path.join(vaultPath, 'Config'));
      await writeFile(path.join(vaultPath, 'Config/policy.txt'), POLICY);
      await rm(path.join(vaultPath, '.mcpignore'));
      await symlink(path.join(vaultPath, 'Config/policy.txt'), path.join(vaultPath, '.mcpignore'));
      const mutation = operation === 'trash'
        ? vault.trashNote('Config')
        : vault.moveFile('Config', 'Public/MovedConfig');
      await expect(mutation).rejects.toBeInstanceOf(vault.VaultPolicyError);
      expect(await readFile(path.join(vaultPath, 'Config/policy.txt'), 'utf-8')).toBe(POLICY);
      await expect(vault.readNote('Private/Secret.md')).rejects.toBeInstanceOf(vault.VaultPolicyError);
      expect(existsSync(path.join(vaultPath, 'Public/MovedConfig'))).toBe(false);
    });
  }

  test('append refuses a hardlink to the policy file', async () => {
    await link(path.join(vaultPath, '.mcpignore'), path.join(vaultPath, 'Public/PolicyHardlink.md'));
    await expect(vault.appendNote('Public/PolicyHardlink.md', 'Public\n')).rejects.toBeInstanceOf(vault.VaultPolicyError);
    expect(await readFile(path.join(vaultPath, '.mcpignore'), 'utf-8')).toBe(POLICY);
  });

  test('a dangling policy symlink denies reads instead of becoming an absent policy', async () => {
    await rm(path.join(vaultPath, '.mcpignore'));
    await symlink(path.join(vaultPath, 'Config/missing.txt'), path.join(vaultPath, '.mcpignore'));
    await expect(vault.readNote('Private/Secret.md')).rejects.toThrow();
    await expect(vault.readNote('Public/Open.md')).rejects.toThrow();
    await expect(vault.searchContent('SECRET')).rejects.toThrow();
    expect((await lstat(path.join(vaultPath, '.mcpignore'))).isSymbolicLink()).toBe(true);
  });

  test('batch frontmatter updates reject policy targets without changing the policy', async () => {
    const outcomes = await vault.updateFrontmatterBatch(
      POLICY_PATHS.map(relativePath => ({ path: relativePath, fields: { changed: true } })),
    );
    expect(outcomes).toHaveLength(POLICY_PATHS.length);
    for (const outcome of outcomes) {
      expect(outcome.updated).toBe(false);
      expect(outcome.error).toMatch(/mcpignore|policy/i);
    }
    expect(await readFile(path.join(vaultPath, '.mcpignore'), 'utf-8')).toBe(POLICY);
  });

  test('a supplied reference rewrite plan cannot modify the policy through a note alias', async () => {
    const plan = {
      from: 'Private.md', to: 'Public.md', isRename: true, basenameCollision: false,
      files: [{ path: 'Public/Policy.md', rewrites: [{ before: '[[Private]]', after: '[[Public]]' }] }],
      baseFilesToReview: [], skippedLinks: [],
    };
    try {
      const result = await vault.applyReferenceRewrite(plan);
      expect(result.modified).toEqual([]);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]?.error).toMatch(/mcpignore|policy/i);
    } catch (error) {
      expect(error).toBeInstanceOf(vault.VaultPolicyError);
    }
    expect(await readFile(path.join(vaultPath, '.mcpignore'), 'utf-8')).toBe(POLICY);
  });
});

describe('Obsidian internal folders', () => {
  test('are blocked by default at any depth, by alias, and in any case', async () => {
    await mkdir(path.join(vaultPath, '.obsidian/plugins/ai'), { recursive: true });
    await writeFile(path.join(vaultPath, '.obsidian/plugins/ai/data.json'), '{"apiKey":"sk-x"}');
    await mkdir(path.join(vaultPath, 'Nested/.git'), { recursive: true });
    await writeFile(path.join(vaultPath, 'Nested/.git/config'), '[core]');
    await symlink(path.join(vaultPath, '.obsidian'), path.join(vaultPath, 'Public/Config'));
    await writeFile(path.join(vaultPath, '.mcpignore'), '');
    for (const p of ['.obsidian/plugins/ai/data.json', '.OBSIDIAN/plugins/ai/data.json',
      'Nested/.git/config', 'Public/Config/plugins/ai/data.json']) {
      expect(() => vault.resolveSafePath(p)).toThrow(vault.VaultPolicyError);
    }
    await expect(vault.writeNote('.obsidian/new.md', 'x')).rejects.toBeInstanceOf(vault.VaultPolicyError);
  });

  test('other hidden paths stay readable by explicit path', async () => {
    expect(await vault.readNote('.context.md')).toBe('hidden context\n');
  });

  test('trashed notes stay readable unless .mcpignore hides .trash', async () => {
    await vault.trashNote('Public/Open.md');
    const trashed = await readdir(path.join(vaultPath, '.trash'));
    expect(trashed).toHaveLength(1);
    expect(await vault.readNote(path.join('.trash', trashed[0]!))).toContain('public body');
  });
});
