// ABOUTME: Tests for planReferenceRewrite/applyReferenceRewrite — every wikilink variant, frontmatter
// string+array values, .canvas rewrite, .base flagging, pure-move vs rename, basename collision, code-block
// exclusion, dry-run writes nothing, write-mode report contents, and .mcpignore exclusion.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'fs/promises';
import os from 'os';
import path from 'path';

let vault: typeof import('../src/vault.js');
let vaultPath: string;

async function seed(rel: string, content: string): Promise<void> {
  const full = path.join(vaultPath, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content, 'utf-8');
}

async function read(rel: string): Promise<string> {
  return readFile(path.join(vaultPath, rel), 'utf-8');
}

// Plan then apply in one step, mirroring the tool's write path: plan against the old location,
// move the file, apply the rewrites. Returns the write-mode result.
async function moveAndRewrite(from: string, to: string) {
  const plan = await vault.planReferenceRewrite(from, to);
  await vault.moveFile(from, to);
  return vault.applyReferenceRewrite(plan);
}

beforeAll(async () => {
  vaultPath = await mkdtemp(path.join(os.tmpdir(), 'orm-rewrite-test-'));
  process.env.VAULT_PATH = vaultPath;
  process.env.VAULT_MCP_TEST = '1';
  // .mcpignore is loaded once at module import, so write it before importing the vault module.
  await writeFile(path.join(vaultPath, '.mcpignore'), 'Private\n', 'utf-8');
  vault = await import(`../src/vault.js?vault-rewrite-test=${Date.now()}`);
  await mkdir(vaultPath, { recursive: true });
});

afterAll(async () => {
  await rm(vaultPath, { recursive: true, force: true });
});

// Each test gets a unique subfolder AND a unique note basename. Basename collisions are vault-wide
// (matched on filename, not path), so a leftover file from one test would otherwise look like a
// collision to the next — the unique basename keeps tests independent. `name` is the moved file's
// title; `dir` is its folder.
let dir: string;
let name: string;
beforeEach(() => {
  const id = Math.random().toString(36).slice(2, 8);
  dir = `t${id}`;
  name = `N${id}`;
});

describe('rename rewrites every wikilink variant', () => {
  test('rewrites a bare link', async () => {
    await seed(`${dir}/${name}.md`, 'x\n');
    await seed(`${dir}/ref.md`, `see [[${name}]] here\n`);
    await moveAndRewrite(`${dir}/${name}.md`, `${dir}/Renamed.md`);
    expect(await read(`${dir}/ref.md`)).toBe('see [[Renamed]] here\n');
  });

  test('preserves the alias when rewriting a piped link', async () => {
    await seed(`${dir}/${name}.md`, 'x\n');
    await seed(`${dir}/ref.md`, `see [[${name}|the note]] here\n`);
    await moveAndRewrite(`${dir}/${name}.md`, `${dir}/Renamed.md`);
    expect(await read(`${dir}/ref.md`)).toBe('see [[Renamed|the note]] here\n');
  });

  test('preserves the heading when rewriting a heading link', async () => {
    await seed(`${dir}/${name}.md`, 'x\n');
    await seed(`${dir}/ref.md`, `see [[${name}#Intro]] here\n`);
    await moveAndRewrite(`${dir}/${name}.md`, `${dir}/Renamed.md`);
    expect(await read(`${dir}/ref.md`)).toBe('see [[Renamed#Intro]] here\n');
  });

  test('preserves the block ref when rewriting a block link', async () => {
    await seed(`${dir}/${name}.md`, 'x\n');
    await seed(`${dir}/ref.md`, `see [[${name}#^abc123]] here\n`);
    await moveAndRewrite(`${dir}/${name}.md`, `${dir}/Renamed.md`);
    expect(await read(`${dir}/ref.md`)).toBe('see [[Renamed#^abc123]] here\n');
  });

  test('preserves heading and alias together', async () => {
    await seed(`${dir}/${name}.md`, 'x\n');
    await seed(`${dir}/ref.md`, `see [[${name}#Intro|start]] here\n`);
    await moveAndRewrite(`${dir}/${name}.md`, `${dir}/Renamed.md`);
    expect(await read(`${dir}/ref.md`)).toBe('see [[Renamed#Intro|start]] here\n');
  });

  test('rewrites an embed', async () => {
    await seed(`${dir}/${name}.md`, 'x\n');
    await seed(`${dir}/ref.md`, `![[${name}]]\n`);
    await moveAndRewrite(`${dir}/${name}.md`, `${dir}/Renamed.md`);
    expect(await read(`${dir}/ref.md`)).toBe('![[Renamed]]\n');
  });

  test('rewrites a path-form link and updates the folder on rename', async () => {
    await seed(`${dir}/Notes/${name}.md`, 'x\n');
    await seed(`${dir}/ref.md`, `see [[${dir}/Notes/${name}]] here\n`);
    await moveAndRewrite(`${dir}/Notes/${name}.md`, `${dir}/Archive/Renamed.md`);
    expect(await read(`${dir}/ref.md`)).toBe(`see [[${dir}/Archive/Renamed]] here\n`);
  });
});

describe('frontmatter wikilinks', () => {
  test('rewrites a wikilink in a string-valued frontmatter property', async () => {
    await seed(`${dir}/${name}.md`, 'x\n');
    await seed(`${dir}/ref.md`, `---\nparent: "[[${name}]]"\n---\nbody\n`);
    await moveAndRewrite(`${dir}/${name}.md`, `${dir}/Renamed.md`);
    expect(await read(`${dir}/ref.md`)).toBe('---\nparent: "[[Renamed]]"\n---\nbody\n');
  });

  test('rewrites a wikilink inside an array-valued frontmatter property', async () => {
    await seed(`${dir}/${name}.md`, 'x\n');
    await seed(`${dir}/ref.md`, `---\nrelated:\n  - "[[${name}]]"\n  - "[[Other]]"\n---\nbody\n`);
    await moveAndRewrite(`${dir}/${name}.md`, `${dir}/Renamed.md`);
    expect(await read(`${dir}/ref.md`)).toBe('---\nrelated:\n  - "[[Renamed]]"\n  - "[[Other]]"\n---\nbody\n');
  });
});

describe('.canvas file-path references', () => {
  test('rewrites a canvas node file path on move', async () => {
    await seed(`${dir}/${name}.md`, 'x\n');
    await seed(`${dir}/board.canvas`, JSON.stringify({ nodes: [{ id: '1', type: 'file', file: `${dir}/${name}.md` }] }, null, '\t') + '\n');
    await moveAndRewrite(`${dir}/${name}.md`, `${dir}/Sub/${name}.md`);
    const canvas = JSON.parse(await read(`${dir}/board.canvas`));
    expect(canvas.nodes[0].file).toBe(`${dir}/Sub/${name}.md`);
  });
});

describe('.base files', () => {
  test('flags a matching .base file for review without modifying it', async () => {
    await seed(`${dir}/${name}.md`, 'x\n');
    const baseText = `filters:\n  and:\n    - file.hasLink("${name}")\n`;
    await seed(`${dir}/db.base`, baseText);
    const result = await moveAndRewrite(`${dir}/${name}.md`, `${dir}/Renamed.md`);
    expect(result.baseFilesToReview).toContain(`${dir}/db.base`);
  });

  test('never modifies a .base file even when it matches', async () => {
    await seed(`${dir}/${name}.md`, 'x\n');
    const baseText = `filters:\n  and:\n    - file.hasLink("${name}")\n`;
    await seed(`${dir}/db.base`, baseText);
    await moveAndRewrite(`${dir}/${name}.md`, `${dir}/Renamed.md`);
    expect(await read(`${dir}/db.base`)).toBe(baseText);
  });
});

describe('pure move vs rename', () => {
  test('a pure move leaves bare links untouched', async () => {
    await seed(`${dir}/${name}.md`, 'x\n');
    await seed(`${dir}/ref.md`, `see [[${name}]] here\n`);
    await moveAndRewrite(`${dir}/${name}.md`, `${dir}/Archive/${name}.md`);
    expect(await read(`${dir}/ref.md`)).toBe(`see [[${name}]] here\n`);
  });

  test('a pure move still rewrites a path-form link to the new folder', async () => {
    await seed(`${dir}/Notes/${name}.md`, 'x\n');
    await seed(`${dir}/ref.md`, `see [[${dir}/Notes/${name}]] here\n`);
    await moveAndRewrite(`${dir}/Notes/${name}.md`, `${dir}/Archive/${name}.md`);
    expect(await read(`${dir}/ref.md`)).toBe(`see [[${dir}/Archive/${name}]] here\n`);
  });
});

describe('basename collision', () => {
  test('reports a skipped bare link when another file shares the old basename', async () => {
    await seed(`${dir}/A/${name}.md`, 'x\n');
    await seed(`${dir}/B/${name}.md`, 'y\n');
    await seed(`${dir}/ref.md`, `see [[${name}]] here\n`);
    const result = await moveAndRewrite(`${dir}/A/${name}.md`, `${dir}/A/Renamed.md`);
    expect(result.skippedLinks.map(s => s.path)).toContain(`${dir}/ref.md`);
  });

  test('leaves an ambiguous bare link unchanged on disk', async () => {
    await seed(`${dir}/A/${name}.md`, 'x\n');
    await seed(`${dir}/B/${name}.md`, 'y\n');
    await seed(`${dir}/ref.md`, `see [[${name}]] here\n`);
    await moveAndRewrite(`${dir}/A/${name}.md`, `${dir}/A/Renamed.md`);
    expect(await read(`${dir}/ref.md`)).toBe(`see [[${name}]] here\n`);
  });

  test('still rewrites an unambiguous path-form link under a basename collision', async () => {
    await seed(`${dir}/A/${name}.md`, 'x\n');
    await seed(`${dir}/B/${name}.md`, 'y\n');
    await seed(`${dir}/ref.md`, `see [[${dir}/A/${name}]] here\n`);
    await moveAndRewrite(`${dir}/A/${name}.md`, `${dir}/A/Renamed.md`);
    expect(await read(`${dir}/ref.md`)).toBe(`see [[${dir}/A/Renamed]] here\n`);
  });
});

describe('code exclusion', () => {
  test('leaves a wikilink inside a fenced code block untouched', async () => {
    await seed(`${dir}/${name}.md`, 'x\n');
    await seed(`${dir}/ref.md`, `\`\`\`\n[[${name}]]\n\`\`\`\n`);
    await moveAndRewrite(`${dir}/${name}.md`, `${dir}/Renamed.md`);
    expect(await read(`${dir}/ref.md`)).toBe(`\`\`\`\n[[${name}]]\n\`\`\`\n`);
  });

  test('leaves a wikilink inside an inline code span untouched', async () => {
    await seed(`${dir}/${name}.md`, 'x\n');
    await seed(`${dir}/ref.md`, `inline \`[[${name}]]\` span\n`);
    await moveAndRewrite(`${dir}/${name}.md`, `${dir}/Renamed.md`);
    expect(await read(`${dir}/ref.md`)).toBe(`inline \`[[${name}]]\` span\n`);
  });
});

describe('non-markdown target with extension', () => {
  // A bare ![[image.png]] resolves by basename anywhere, so a pure folder move leaves it valid —
  // it's the path-form embed that breaks and must be rewritten, mirroring the note path-form rule.
  test('rewrites a path-form embed carrying an explicit extension on move', async () => {
    await seed(`${dir}/${name}.png`, 'binary');
    await seed(`${dir}/ref.md`, `pic ![[${dir}/${name}.png]] here\n`);
    await moveAndRewrite(`${dir}/${name}.png`, `${dir}/Assets/${name}.png`);
    expect(await read(`${dir}/ref.md`)).toBe(`pic ![[${dir}/Assets/${name}.png]] here\n`);
  });

  test('rewrites a bare embed when the attachment is renamed', async () => {
    await seed(`${dir}/${name}.png`, 'binary');
    await seed(`${dir}/ref.md`, `pic ![[${name}.png]] here\n`);
    await moveAndRewrite(`${dir}/${name}.png`, `${dir}/renamed.png`);
    expect(await read(`${dir}/ref.md`)).toBe('pic ![[renamed.png]] here\n');
  });
});

describe('missing source', () => {
  test('planning rejects with a clean vault-relative error instead of an empty plan', async () => {
    await expect(
      vault.planReferenceRewrite(`${dir}/${name}.md`, `${dir}/Renamed.md`),
    ).rejects.toThrow(`No file found at "${dir}/${name}.md".`);
  });
});

describe('write report accuracy', () => {
  test('a file whose link disappeared between plan and apply is not reported as modified', async () => {
    await seed(`${dir}/${name}.md`, 'x\n');
    await seed(`${dir}/ref.md`, `see [[${name}]] here\n`);
    const plan = await vault.planReferenceRewrite(`${dir}/${name}.md`, `${dir}/Renamed.md`);
    await seed(`${dir}/ref.md`, 'link removed by a concurrent edit\n');
    await vault.moveFile(`${dir}/${name}.md`, `${dir}/Renamed.md`);
    const result = await vault.applyReferenceRewrite(plan);
    expect(result.modified).toEqual([]);
    expect(result.failures).toEqual([]);
  });
});

describe('dry run', () => {
  test('returns the plan of files it would rewrite', async () => {
    await seed(`${dir}/${name}.md`, 'x\n');
    await seed(`${dir}/ref.md`, `see [[${name}]] here\n`);
    const plan = await vault.planReferenceRewrite(`${dir}/${name}.md`, `${dir}/Renamed.md`);
    expect(plan.files.map(f => f.path)).toContain(`${dir}/ref.md`);
  });

  test('writes nothing to referencing files', async () => {
    await seed(`${dir}/${name}.md`, 'x\n');
    await seed(`${dir}/ref.md`, `see [[${name}]] here\n`);
    await vault.planReferenceRewrite(`${dir}/${name}.md`, `${dir}/Renamed.md`);
    expect(await read(`${dir}/ref.md`)).toBe(`see [[${name}]] here\n`);
  });

  test('does not move the file', async () => {
    await seed(`${dir}/${name}.md`, 'x\n');
    await vault.planReferenceRewrite(`${dir}/${name}.md`, `${dir}/Renamed.md`);
    expect(await read(`${dir}/${name}.md`)).toBe('x\n');
  });
});

describe('write-mode report', () => {
  test('lists every file whose links were rewritten', async () => {
    await seed(`${dir}/${name}.md`, 'x\n');
    await seed(`${dir}/one.md`, `[[${name}]]\n`);
    await seed(`${dir}/two.md`, `[[${name}]]\n`);
    const result = await moveAndRewrite(`${dir}/${name}.md`, `${dir}/Renamed.md`);
    expect(result.modified.sort()).toEqual([`${dir}/one.md`, `${dir}/two.md`]);
  });
});

describe('.mcpignore exclusion', () => {
  test('does not list an ignored note in the plan', async () => {
    await seed(`${dir}/${name}.md`, 'x\n');
    await seed(`Private/${name}-secret.md`, `see [[${name}]] here\n`);
    const plan = await vault.planReferenceRewrite(`${dir}/${name}.md`, `${dir}/Renamed.md`);
    expect(plan.files.map(f => f.path)).not.toContain(`Private/${name}-secret.md`);
  });

  test('leaves an ignored note untouched in write mode', async () => {
    await seed(`${dir}/${name}.md`, 'x\n');
    await seed(`Private/${name}-secret.md`, `see [[${name}]] here\n`);
    await moveAndRewrite(`${dir}/${name}.md`, `${dir}/Renamed.md`);
    expect(await read(`Private/${name}-secret.md`)).toBe(`see [[${name}]] here\n`);
  });
});
