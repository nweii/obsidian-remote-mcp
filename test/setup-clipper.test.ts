// ABOUTME: Exercises clipper setup against copied git sources and the audited root dependencies.
// Builds and renders local HTML without network access, and rejects stale nested dependencies.
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupClipper } from '../scripts/setup-clipper.ts';

const projectRoot = join(import.meta.dir, '..');
const installedModules = join(projectRoot, 'node_modules');
const hasClipper = existsSync(join(installedModules, 'obsidian-clipper', 'src', 'api.ts')) &&
  existsSync(join(installedModules, 'web-clipper-headless', 'scripts', 'build-upstream.ts'));

// Optional dependencies may be intentionally omitted. Always test the missing-source failure,
// while the build/render integration tests run only when the optional sources are installed.
// CI sets REQUIRE_CLIPPER=1 so a missing install fails instead of silently skipping them.
test('optional clipper sources are installed when REQUIRE_CLIPPER=1', () => {
  if (process.env.REQUIRE_CLIPPER === '1') expect(hasClipper).toBe(true);
});

test('clipper setup reports missing optional sources without installing anything', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orm-clipper-missing-'));
  try {
    await expect(setupClipper(root)).rejects.toThrow('Optional clipper sources are missing');
    expect(await readdir(root)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function makeBuildRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orm-clipper-setup-'));
  const modules = join(root, 'node_modules');
  await mkdir(modules);
  for (const name of await readdir(installedModules)) {
    if (name !== 'obsidian-clipper' && name !== 'web-clipper-headless') {
      await symlink(join(installedModules, name), join(modules, name));
    }
  }
  for (const name of ['obsidian-clipper', 'web-clipper-headless']) {
    const target = join(modules, name);
    await mkdir(target);
    await cp(join(installedModules, name, 'package.json'), join(target, 'package.json'));
    await cp(join(installedModules, name, 'src'), join(target, 'src'), { recursive: true });
  }
  const scripts = join(modules, 'web-clipper-headless', 'scripts');
  await mkdir(scripts);
  await cp(join(installedModules, 'web-clipper-headless', 'scripts', 'build-upstream.ts'), join(scripts, 'build-upstream.ts'));
  return root;
}

const hasBuiltClipper = hasClipper && existsSync(join(installedModules, 'obsidian-clipper', 'dist', 'api.mjs'));

// Runs from the project root so the project's own tsconfig and resolution apply, the way the
// server starts in production.
(hasBuiltClipper ? test : test.skip)('the server registers vault_clip_url when the clipper is built', async () => {
  const vaultPath = await mkdtemp(join(tmpdir(), 'orm-clipper-register-'));
  try {
    const child = Bun.spawn({
      cmd: [process.execPath, '-e', `
        const names = [];
        const { registerTools } = await import('./src/tools.ts');
        await registerTools({ registerTool(name) { names.push(name); } });
        console.log(JSON.stringify(names));
      `],
      cwd: projectRoot,
      env: { ...process.env, VAULT_PATH: vaultPath },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(stdout.trim().split('\n').pop()!)).toContain('vault_clip_url');
  } finally {
    await rm(vaultPath, { recursive: true, force: true });
  }
});

(hasClipper ? describe : describe.skip)('clipper setup with locked optional dependencies', () => {
  test('fresh and stale bundles build, patch, and render local HTML with root dependencies', async () => {
    const root = await makeBuildRoot();
    try {
      const bundle = await setupClipper(root);
      expect(existsSync(bundle)).toBe(true);
      // Like upstream's build, Defuddle and dayjs stay imports resolved at runtime, not inlined.
      const built = await readFile(bundle, 'utf8');
      expect(built).toMatch(/from\s*["']defuddle(\/full)?["']/);
      expect(built).toMatch(/from\s*["']dayjs["']/);
      // Setup must refresh embedded dependencies even when a previous bundle exists.
      await writeFile(bundle, 'throw new Error("stale unaudited bundle");');
      expect(await setupClipper(root)).toBe(bundle);
      expect(await readFile(bundle, 'utf8')).not.toContain('stale unaudited bundle');

      // A fresh process exercises the real package exports and avoids sharing DOM polyfills or
      // fetch mocks with other tests. Inject HTML and reject any unexpected network request.
      const child = Bun.spawn({
        cmd: [process.execPath, '-e', `
          globalThis.fetch = async () => { throw new Error('Unexpected network request'); };
          const { render } = await import('web-clipper-headless');
          const { applyFilters } = await import('obsidian-clipper/api');
          const html = '<!DOCTYPE html><html><head><title>Local smoke article</title></head><body><article><h1>Local smoke article</h1><p>A local article with enough useful text to make a readable clip. This input stays entirely on this machine and does not need a remote request.</p><p>The second paragraph confirms that content extraction still returns meaningful markdown.</p></article></body></html>';
          const result = await render({
            url: 'https://example.test/article',
            fetchHtml: async () => html,
            template: {
              schemaVersion: '0.1.0', name: 'Smoke', behavior: 'create',
              noteNameFormat: '{{title}}', noteContentFormat: '{{content}}\\n\\n{{selector:h1|upper}}',
              path: 'Clippings', triggers: [],
              properties: [{ name: 'source', value: '{{url}}', type: 'text' }],
            },
            variableOverrides: { title: 'Override smoke title' },
          });
          console.log('CLIPPER_TEST_RESULT=' + JSON.stringify({ result, filter: applyFilters('local filter', 'upper', 'https://example.test/') }));
        `],
        cwd: root,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      if (exitCode !== 0) throw new Error(`Clipper rendering failed: ${stderr}`);
      const resultLine = stdout.split('\n').find(line => line.startsWith('CLIPPER_TEST_RESULT='));
      if (!resultLine) throw new Error(`Clipper rendering did not return a result: ${stdout}`);
      const { result, filter } = JSON.parse(resultLine.slice('CLIPPER_TEST_RESULT='.length));
      expect(filter).toBe('LOCAL FILTER');
      expect(result.status).toBe('rendered');
      expect(result.filename).toBe('Override smoke title');
      expect(result.frontmatter).toContain('source: "https://example.test/article"');
      expect(result.content).toContain('A local article with enough useful text');
      expect(result.content).toContain('The second paragraph confirms');
      expect(result.content).toContain('LOCAL SMOKE ARTICLE');
      expect(result.fullContent).toBe(result.frontmatter + result.content);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a nested runtime package cannot bypass the audited root dependency', async () => {
    const root = await makeBuildRoot();
    try {
      const shadow = join(root, 'node_modules', 'obsidian-clipper', 'node_modules', 'defuddle');
      await mkdir(shadow, { recursive: true });
      await writeFile(join(shadow, 'package.json'), JSON.stringify({ name: 'defuddle', main: 'index.js' }));
      await writeFile(join(shadow, 'index.js'), 'throw new Error("unsafe nested dependency");');
      await expect(setupClipper(root)).rejects.toThrow('A nested defuddle installation shadows the root lock');
      expect(existsSync(join(root, 'node_modules', 'obsidian-clipper', 'dist', 'api.mjs'))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
