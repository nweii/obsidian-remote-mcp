// ABOUTME: Builds the locked Obsidian clipper API from the root dependency tree, then applies
// web-clipper-headless's compatibility patches. Never runs a nested dependency install.
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export async function setupClipper(projectRoot = resolve(import.meta.dir, '..')): Promise<string> {
  const upstreamRoot = join(projectRoot, 'node_modules', 'obsidian-clipper');
  const headlessRoot = join(projectRoot, 'node_modules', 'web-clipper-headless');
  const entrypoint = join(upstreamRoot, 'src', 'api.ts');
  const patcher = join(headlessRoot, 'scripts', 'build-upstream.ts');
  if (!existsSync(entrypoint) || !existsSync(patcher)) {
    throw new Error('Optional clipper sources are missing. Run bun install at the project root first.');
  }

  // Old setup commands could leave a separately installed upstream or runtime dependency under
  // these git packages. Refuse those shadows so the runtime uses the same audited root packages
  // as the build. Bundled bare imports are also resolved explicitly from the project root below.
  const nestedUpstream = join(headlessRoot, 'node_modules', 'obsidian-clipper');
  if (existsSync(nestedUpstream) && realpathSync(nestedUpstream) !== realpathSync(upstreamRoot)) {
    throw new Error('A nested obsidian-clipper installation shadows the root lock. Remove the nested installation and run bun install at the project root.');
  }
  for (const specifier of ['defuddle', 'defuddle/full', 'dayjs', 'linkedom']) {
    const rootModule = realpathSync(Bun.resolveSync(specifier, projectRoot));
    for (const packageRoot of [upstreamRoot, headlessRoot]) {
      if (realpathSync(Bun.resolveSync(specifier, packageRoot)) !== rootModule) {
        throw new Error(`A nested ${specifier} installation shadows the root lock. Remove the nested installation and run bun install at the project root.`);
      }
    }
  }

  // Mirror upstream scripts/build-api.mjs: ESM, external Defuddle/dayjs, DEBUG_MODE disabled,
  // and the browser extension stub. Bun's browser target serves the environment-neutral API.
  const external = ['defuddle', 'defuddle/full', 'dayjs'];
  const result = await Bun.build({
    entrypoints: [entrypoint],
    target: 'browser',
    format: 'esm',
    external,
    define: { DEBUG_MODE: 'false' },
    plugins: [{
      name: 'clipper-root-dependencies',
      setup(build) {
        // A plugin's resolved path overrides `external`, so externals must be returned as such
        // here or Bun embeds them.
        build.onResolve({ filter: /^[^./]/ }, ({ path }) => {
          if (external.some(name => path === name || path.startsWith(`${name}/`))) {
            return { path, external: true };
          }
          return {
            path: path === 'webextension-polyfill'
              ? join(upstreamRoot, 'src', 'utils', 'cli-stubs.ts')
              : Bun.resolveSync(path, projectRoot),
          };
        });
      },
    }],
  });
  if (!result.success) {
    throw new AggregateError(result.logs, 'Failed to build the locked Obsidian clipper API');
  }
  if (result.outputs.length !== 1) {
    throw new Error('Expected one Obsidian clipper API bundle');
  }

  // Rebuild on every run: an existing bundle may embed dependencies from an older root lock.
  const apiBundle = join(upstreamRoot, 'dist', 'api.mjs');
  await mkdir(join(upstreamRoot, 'dist'), { recursive: true });
  await writeFile(apiBundle, await result.outputs[0].text());

  // The existing patcher exits before its install/build branches when this bundle exists.
  const patched = spawnSync(process.execPath, [patcher], { cwd: headlessRoot, stdio: 'inherit' });
  if (patched.error) throw patched.error;
  if (patched.status !== 0) throw new Error(`Clipper compatibility patches failed (${patched.status ?? patched.signal})`);
  return apiBundle;
}

if (import.meta.main) {
  console.log(`[setup:clipper] Ready: ${await setupClipper()}`);
}
