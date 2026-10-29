// ABOUTME: The opt-in Obsidian CLI tools against a fake binary: availability and registration gates,
// argv construction, output cleanup, guards, re-probing after failure, and backlinks routed through
// Obsidian with fallback to the server's index.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { fakeCalls, installFakeObsidian } from './fake-obsidian.js';
import * as cli from '../src/cli.js';
import { runAsCaller } from 'mcp-server-kit';

const ENV_KEYS = [
  'VAULT_PATH', 'VAULT_READ_ONLY', 'OBSIDIAN_CLI_ENABLED', 'OBSIDIAN_CLI_PATH', 'OBSIDIAN_CLI_VAULT',
  'OBSIDIAN_CLI_COMMANDS', 'OBSIDIAN_CLI_MCPIGNORE_ACK', 'FAKE_OBSIDIAN_VAULT', 'FAKE_OBSIDIAN_DOWN',
  'FAKE_OBSIDIAN_FAIL', 'FAKE_OBSIDIAN_BACKLINKS', 'FAKE_OBSIDIAN_LOG', 'MCP_CLIENT_ID', 'MCP_BASE_URL',
  'MCP_STATIC_BEARER_TOKEN', 'MCP_STATIC_BEARER_SCOPES', 'APPROVAL_OPEN',
];
let saved: Record<string, string | undefined>;
let base: string;
let vaultPath: string;
let logFile: string;
let bin: string;

beforeAll(async () => {
  saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  base = await mkdtemp(path.join(os.tmpdir(), 'cli-test-'));
  vaultPath = path.join(base, 'Vault');
  await mkdir(path.join(vaultPath, 'Private'), { recursive: true });
  await mkdir(path.join(vaultPath, '.obsidian'), { recursive: true });
  await writeFile(path.join(vaultPath, 'Open.md'), '# Open\n');
  await writeFile(path.join(vaultPath, 'Linker.md'), '[[Open]]\n');
  await writeFile(path.join(vaultPath, 'Private/Secret.md'), '[[Open]]\n');
  bin = await installFakeObsidian(base);
});

beforeEach(async () => {
  for (const k of ENV_KEYS) delete process.env[k];
  await rm(path.join(vaultPath, '.mcpignore'), { force: true });
  logFile = path.join(base, `calls-${Math.random().toString(36).slice(2)}.log`);
  Object.assign(process.env, {
    VAULT_PATH: vaultPath,
    OBSIDIAN_CLI_ENABLED: 'true',
    OBSIDIAN_CLI_PATH: bin,
    FAKE_OBSIDIAN_VAULT: vaultPath,
    FAKE_OBSIDIAN_LOG: logFile,
  });
  cli.resetCliAvailability();
});

afterEach(() => cli.resetCliAvailability());

afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(base, { recursive: true, force: true });
});

async function refused(request: cli.CliRequest): Promise<string> {
  const outcome = await cli.runCli(request);
  expect(outcome.ok).toBe(false);
  expect(await fakeCalls(logFile)).toEqual([]);
  return outcome.ok ? '' : outcome.error;
}

describe('availability', () => {
  test('is off unless opted in', async () => {
    delete process.env.OBSIDIAN_CLI_ENABLED;
    expect((await cli.cliToolsAvailability()).ok).toBe(false);
  });

  test('passes when the CLI reaches the server vault', async () => {
    expect(await cli.cliToolsAvailability()).toEqual({ ok: true });
  });

  test('fails when the binary is missing', async () => {
    process.env.OBSIDIAN_CLI_PATH = path.join(base, 'missing');
    expect((await cli.cliToolsAvailability()).ok).toBe(false);
  });

  test('fails when the CLI reaches a different vault', async () => {
    process.env.FAKE_OBSIDIAN_VAULT = base;
    const result = await cli.cliToolsAvailability();
    expect(result.ok).toBe(false);
  });

  test('fails when the app is unreachable', async () => {
    process.env.FAKE_OBSIDIAN_DOWN = '1';
    expect((await cli.cliToolsAvailability()).ok).toBe(false);
  });

  test('is withheld while .mcpignore has rules, unless acknowledged', async () => {
    await writeFile(path.join(vaultPath, '.mcpignore'), '# comment only\n/\n./\n/# anchored comment\n');
    expect((await cli.cliToolsAvailability()).ok).toBe(true);
    await writeFile(path.join(vaultPath, '.mcpignore'), 'Private\n');
    const withheld = await cli.cliToolsAvailability();
    expect(withheld.ok).toBe(false);
    expect(withheld.ok ? '' : withheld.reason).toContain('OBSIDIAN_CLI_MCPIGNORE_ACK');
    process.env.OBSIDIAN_CLI_MCPIGNORE_ACK = 'true';
    expect((await cli.cliToolsAvailability()).ok).toBe(true);
  });
});

describe('finding the binary', () => {
  let onPath: string;
  let standard: string;
  const originalPath = process.env.PATH;
  afterEach(() => { process.env.PATH = originalPath; });

  beforeAll(async () => {
    onPath = path.join(base, 'path-bin');
    standard = path.join(base, 'standard-bin');
    await mkdir(onPath, { recursive: true });
    await mkdir(standard, { recursive: true });
    await installFakeObsidian(onPath);
    await installFakeObsidian(standard);
  });

  const standardPaths = () => ({ darwin: [path.join(standard, 'obsidian')] });

  test('OBSIDIAN_CLI_PATH wins over PATH and the standard location', () => {
    process.env.PATH = onPath;
    expect(cli.findCliBinary('darwin', standardPaths())).toBe(bin);
  });

  test('a PATH hit wins over the standard location', () => {
    delete process.env.OBSIDIAN_CLI_PATH;
    process.env.PATH = onPath;
    expect(cli.findCliBinary('darwin', standardPaths())).toBe(path.join(onPath, 'obsidian'));
  });

  test('falls back to the standard macOS location when PATH lacks the binary', () => {
    delete process.env.OBSIDIAN_CLI_PATH;
    process.env.PATH = path.join(base, 'empty');
    expect(cli.findCliBinary('darwin', standardPaths())).toBe(path.join(standard, 'obsidian'));
    expect(cli.findCliBinary('darwin', { darwin: [path.join(base, 'missing')] })).toBeNull();
  });

  test('does not try the fallback off macOS', () => {
    delete process.env.OBSIDIAN_CLI_PATH;
    process.env.PATH = path.join(base, 'empty');
    expect(cli.findCliBinary('linux', standardPaths())).toBeNull();
  });

  test('nothing is found when PATH and the fallback list both lack the binary', () => {
    delete process.env.OBSIDIAN_CLI_PATH;
    process.env.PATH = path.join(base, 'empty');
    // An empty fallback list keeps this independent of what the host has installed.
    expect(cli.findCliBinary('darwin', { darwin: [] })).toBeNull();
  });

  // Runs only where the host has no CLI at its standard location, since that install would be found.
  test.skipIf(cli.findCliBinary() !== null)(
    'a missing binary is reported with how to set OBSIDIAN_CLI_PATH', async () => {
      delete process.env.OBSIDIAN_CLI_PATH;
      process.env.PATH = path.join(base, 'empty');
      const result = await cli.cliToolsAvailability();
      expect(result.ok ? '' : result.reason).toContain('set OBSIDIAN_CLI_PATH');
    });
});

describe('startup log', () => {
  async function logged(run: () => Promise<void>): Promise<string[]> {
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.join(' ')); };
    try {
      await run();
    } finally {
      console.error = original;
    }
    return lines;
  }

  test('says once whether the CLI tools are offered, and why not', async () => {
    process.env.OBSIDIAN_CLI_PATH = path.join(base, 'missing');
    const first = await logged(() => cli.logCliAvailability());
    expect(first).toHaveLength(1);
    expect(first[0]).toContain('vault_cli not offered');
    expect(await logged(() => cli.logCliAvailability())).toEqual([]);
  });

  test('stays quiet when the CLI tools are not enabled', async () => {
    delete process.env.OBSIDIAN_CLI_ENABLED;
    expect(await logged(() => cli.logCliAvailability())).toEqual([]);
  });
});

describe('running commands', () => {
  test('pins the vault, passes params and flags as argv, strips startup noise', async () => {
    const outcome = await cli.runCli({ command: 'search', params: { query: 'two words; rm -rf /' }, flags: ['counts'] });
    expect(outcome).toEqual({
      ok: true,
      output: JSON.stringify({ vault: 'vault=Vault', command: 'search', rest: ['query=two words; rm -rf /', 'counts'] }),
    });
  });

  test('OBSIDIAN_CLI_VAULT names the vault passed to the CLI', async () => {
    process.env.OBSIDIAN_CLI_VAULT = 'Notes';
    await cli.runCli({ command: 'search', params: { query: 'x' } });
    expect((await fakeCalls(logFile))[0]![0]).toBe('vault=Notes');
  });

  test('resolves file= through the server and passes the exact path', async () => {
    await cli.runCli({ command: 'read', params: { file: 'Open' } });
    expect((await fakeCalls(logFile))[0]).toEqual(['vault=Vault', 'read', 'path=Open.md']);
  });

  test('keeps file= for commands where it is an exact path, after the path policy', async () => {
    await writeFile(path.join(vaultPath, '.mcpignore'), 'Private\n');
    process.env.OBSIDIAN_CLI_MCPIGNORE_ACK = 'true';
    expect(await refused({ command: 'bookmark', params: { file: 'Private/Secret.md' } })).toBe('Not found: Private/Secret.md');
    expect(await refused({ command: 'bookmark', params: { file: 'Assets/missing.png' } })).toBe('Not found: Assets/missing.png');
    await mkdir(path.join(vaultPath, 'Assets'), { recursive: true });
    await writeFile(path.join(vaultPath, 'Assets', 'image.png'), '');
    await cli.runCli({ command: 'bookmark', params: { file: 'Assets/image.png' } });
    expect((await fakeCalls(logFile))[0]).toEqual(['vault=Vault', 'bookmark', 'file=Assets/image.png']);
  });

  test('keeps file= for an existing non-Markdown file, and refuses a protected one', async () => {
    await mkdir(path.join(vaultPath, 'Bases'), { recursive: true });
    await writeFile(path.join(vaultPath, 'Bases', 'Projects.base'), 'views: []\n');
    await writeFile(path.join(vaultPath, 'Private', 'Hidden.base'), 'views: []\n');
    await writeFile(path.join(vaultPath, '.mcpignore'), 'Private\n');
    process.env.OBSIDIAN_CLI_MCPIGNORE_ACK = 'true';
    expect(await refused({ command: 'base:query', params: { file: 'Private/Hidden.base' } })).toBe('Not found: Private/Hidden.base');
    expect(await refused({ command: 'base:query', params: { file: 'Hidden.base' } })).toBe('Not found: Hidden.base');
    await cli.runCli({ command: 'base:query', params: { file: 'Bases/Projects.base' } });
    expect((await fakeCalls(logFile))[0]).toEqual(['vault=Vault', 'base:query', 'file=Bases/Projects.base']);
  });

  test('a command failure re-probes, then reports the command error', async () => {
    process.env.FAKE_OBSIDIAN_FAIL = '1';
    const outcome = await cli.runCli({ command: 'search', params: { query: 'x' } });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain('exited with code 2');
      expect(outcome.output).toContain('something went wrong');
    }
  });

  test('an app that went away is reported as unavailable, and comes back', async () => {
    expect((await cli.runCli({ command: 'search', params: { query: 'x' } })).ok).toBe(true);
    process.env.FAKE_OBSIDIAN_DOWN = '1';
    const outcome = await cli.runCli({ command: 'search', params: { query: 'x' } });
    expect(outcome.ok ? '' : outcome.error).toContain('Obsidian CLI is unavailable');
    delete process.env.FAKE_OBSIDIAN_DOWN;
    cli.resetCliAvailability();
    expect((await cli.runCli({ command: 'search', params: { query: 'x' } })).ok).toBe(true);
  });
});

describe('guards', () => {
  test.each(['eval', 'dev:console', 'dev:cdp', 'devtools', 'restart', 'reload', 'plugin:install', 'plugin:enable',
    'plugins:restrict', 'theme:install', 'snippet:enable', 'vault', 'vaults'])('always blocks %s', async command => {
    expect(await refused({ command })).toContain('blocked');
  });

  test('rejects malformed command names, keys and flags', async () => {
    await refused({ command: 'search --help' });
    await refused({ command: 'Search' });
    await refused({ command: 'search', params: { 'Query': 'x' } });
    await refused({ command: 'search', params: { 'pane_type': 'x' } });
    await refused({ command: 'search', params: { 'query x': 'x' } });
    await refused({ command: 'search', flags: ['--copy'] });
    await refused({ command: 'search', flags: ['vault=Other'] });
    await refused({ command: 'search', flags: ['counts extra'] });
  });

  test('accepts camelCase keys, except a differently cased key the guards read', async () => {
    for (const key of ['pATH', 'fOLDER', 'vAULT', 'fILE']) {
      expect(await refused({ command: 'read', params: { [key]: '../x' } })).toContain('lowercase');
    }
    const outcome = await cli.runCli({ command: 'daily', params: { paneType: 'tab' } });
    expect(outcome).toEqual({ ok: true, output: JSON.stringify({ vault: 'vault=Vault', command: 'daily', rest: ['paneType=tab'] }) });
  });

  test('rejects a vault key or flag', async () => {
    expect(await refused({ command: 'search', params: { vault: 'Other' } })).toContain('vault');
    await refused({ command: 'search', flags: ['vault'] });
  });

  test('rejects a name that carries a path', async () => {
    await refused({ command: 'create', params: { name: '../Private/x' } });
  });

  test('command palette is off without an allowlist', async () => {
    expect(await refused({ command: 'command', params: { id: 'app:go-back' } })).toContain('OBSIDIAN_CLI_COMMANDS');
  });

  test('command palette runs only listed IDs', async () => {
    process.env.OBSIDIAN_CLI_COMMANDS = 'app:go-back, editor:toggle-bold';
    expect((await cli.runCli({ command: 'command', params: { id: 'editor:toggle-bold' } })).ok).toBe(true);
    await rm(logFile, { force: true });
    await refused({ command: 'command', params: { id: 'app:delete-file' } });
  });

  test('* allows palette IDs except destructive ones, which must be listed', async () => {
    process.env.OBSIDIAN_CLI_COMMANDS = '*';
    expect((await cli.runCli({ command: 'command', params: { id: 'app:go-back' } })).ok).toBe(true);
    await rm(logFile, { force: true });
    for (const id of ['app:delete-file', 'file-explorer:remove', 'sync:purge-history', 'workspace:close-trash']) {
      await refused({ command: 'command', params: { id } });
    }
    process.env.OBSIDIAN_CLI_COMMANDS = '*,app:delete-file';
    expect((await cli.runCli({ command: 'command', params: { id: 'app:delete-file' } })).ok).toBe(true);
  });

  test('read-only mode runs only known-read commands', async () => {
    process.env.VAULT_READ_ONLY = 'true';
    process.env.OBSIDIAN_CLI_COMMANDS = '*';
    expect((await cli.runCli({ command: 'search', params: { query: 'x' } })).ok).toBe(true);
    await rm(logFile, { force: true });
    expect(await refused({ command: 'create', params: { path: 'New.md' } })).toContain('read-only');
    await refused({ command: 'some-future-command' });
    await refused({ command: 'command', params: { id: 'app:go-back' } });
  });

  test('outside read-only mode unknown commands that are not blocked run', async () => {
    expect((await cli.runCli({ command: 'some-future-command' })).ok).toBe(true);
  });

  test('a blocked path looks like a missing one', async () => {
    await writeFile(path.join(vaultPath, '.mcpignore'), 'Private\n');
    process.env.OBSIDIAN_CLI_MCPIGNORE_ACK = 'true';
    const blocked = await refused({ command: 'read', params: { path: 'Private/Secret.md' } });
    const missing = await refused({ command: 'read', params: { file: 'Nope' } });
    expect(blocked).toBe('Not found: Private/Secret.md');
    expect(missing).toBe('Not found: Nope');
  });

  test('a missing path= that makes the command fail answers like a blocked one', async () => {
    process.env.FAKE_OBSIDIAN_FAIL = '1';
    expect(await cli.runCli({ command: 'read', params: { path: 'Nope.md' } })).toEqual({ ok: false, error: 'Not found: Nope.md' });
  });

  test('a command that may write refuses a folder in path=', async () => {
    expect(await refused({ command: 'delete', params: { path: 'Private' } })).toContain('folder');
    expect((await cli.runCli({ command: 'files', params: { folder: 'Private' } })).ok).toBe(true);
  });

  test('the vault root works as a folder for read commands only', async () => {
    expect((await cli.runCli({ command: 'files', params: { folder: '/' } })).ok).toBe(true);
    await rm(logFile, { force: true });
    await refused({ command: 'delete', params: { path: '/' } });
  });

  test('stays off while .mcpignore has rules and no acknowledgment', async () => {
    await writeFile(path.join(vaultPath, '.mcpignore'), 'Private\n');
    await refused({ command: 'search', params: { query: 'x' } });
  });
});

describe('per connection', () => {
  const caller = (scopes: string[]) => ({ clientId: 'c', kind: 'dynamic' as const, scopes });

  test('a connection without app control is refused before Obsidian runs', async () => {
    const error = await runAsCaller(caller(['vault:write']), () => refused({ command: 'search', params: { query: 'x' } }));
    expect(error).toContain('Control the Obsidian app');
    const help = await runAsCaller(caller(['vault:write']), () => cli.cliHelp());
    expect(help.ok).toBe(false);
  });

  test('a connection with app control but without editing runs only known-read commands', async () => {
    const error = await runAsCaller(caller(['vault:cli']), () => refused({ command: 'create', params: { path: 'New.md' } }));
    expect(error).toContain('Edit notes');
    const search = await runAsCaller(caller(['vault:cli']), () => cli.runCli({ command: 'search', params: { query: 'x' } }));
    expect(search.ok).toBe(true);
  });
});

describe('help', () => {
  test('lists commands from obsidian help without blocked ones', async () => {
    const outcome = await cli.cliHelp();
    expect(outcome.ok).toBe(true);
    const text = outcome.ok ? outcome.output : '';
    expect(text).toContain('read');
    expect(text).toContain('path=<path>');
    expect(text).toContain('search');
    for (const blocked of ['eval', 'dev:console', 'devtools', 'plugin:install', 'plugins:restrict', 'theme:install', 'snippet:enable', 'restart', 'reload']) {
      expect(text).not.toMatch(new RegExp(`^${blocked}\\b`, 'm'));
    }
    expect(text).not.toMatch(/^command\b/m);
    expect(text).not.toContain('Loading updated app package');
  });

  test('lists command when palette IDs are allowed', async () => {
    process.env.OBSIDIAN_CLI_COMMANDS = 'app:go-back';
    const outcome = await cli.cliHelp();
    expect(outcome.ok ? outcome.output : '').toMatch(/^command\b/m);
  });

  test('read-only mode lists only known-read commands', async () => {
    process.env.VAULT_READ_ONLY = 'true';
    const text = await cli.cliHelp().then(o => (o.ok ? o.output : ''));
    expect(text).toMatch(/^read\b/m);
    expect(text).not.toMatch(/^create\b/m);
  });

  test('help for one blocked command is refused', async () => {
    expect((await cli.cliHelp('eval')).ok).toBe(false);
  });
});

describe('backlinks', () => {
  test('come from Obsidian when available, filtered by the path policy', async () => {
    await writeFile(path.join(vaultPath, '.mcpignore'), 'Private\n');
    process.env.FAKE_OBSIDIAN_BACKLINKS = JSON.stringify([
      { file: 'Linker.md' }, { file: 'Private/Secret.md' }, { file: '.obsidian/x.md' }, { file: 'Open.md' },
    ]);
    expect(await cli.resolveBacklinks('Open.md', 20)).toEqual({ paths: ['Linker.md'], source: 'obsidian' });
    expect((await fakeCalls(logFile))[0]).toEqual(['vault=Vault', 'backlinks', 'path=Open.md', 'format=json']);
  });

  test('respect the limit', async () => {
    process.env.FAKE_OBSIDIAN_BACKLINKS = JSON.stringify(['A.md', 'B.md', 'C.md']);
    expect((await cli.resolveBacklinks('Open.md', 2)).paths).toEqual(['A.md', 'B.md']);
  });

  test('come from the server index when the CLI is off', async () => {
    delete process.env.OBSIDIAN_CLI_ENABLED;
    const result = await cli.resolveBacklinks('Open.md', 20);
    expect(result.source).toBe('server');
    expect(result.paths).toContain('Linker.md');
  });

  test('fall back to the server index when the call fails or returns junk', async () => {
    process.env.FAKE_OBSIDIAN_FAIL = '1';
    expect((await cli.resolveBacklinks('Open.md', 20)).source).toBe('server');
    delete process.env.FAKE_OBSIDIAN_FAIL;
    process.env.FAKE_OBSIDIAN_BACKLINKS = 'not json';
    expect((await cli.resolveBacklinks('Open.md', 20)).source).toBe('server');
  });

  test('refuse a protected note before asking Obsidian', async () => {
    await writeFile(path.join(vaultPath, '.mcpignore'), 'Private\n');
    await expect(cli.resolveBacklinks('Private/Secret.md', 20)).rejects.toThrow();
    expect(await fakeCalls(logFile)).toEqual([]);
  });
});

describe('over MCP', () => {
  const BEARER = 'cli-test-bearer';

  async function rpc(method: string, params: unknown): Promise<any> {
    Object.assign(process.env, {
      MCP_CLIENT_ID: 'cli-client', MCP_BASE_URL: 'https://example.test', MCP_STATIC_BEARER_TOKEN: BEARER, APPROVAL_OPEN: 'true',
    });
    const { createApp } = await import('../src/app.js');
    const server = createApp().app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    try {
      const { port } = server.address() as { port: number };
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${BEARER}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      const text = await res.text();
      const line = text.split('\n').find(l => l.startsWith('data: '));
      return JSON.parse(line ? line.slice(6) : text).result;
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  }

  const toolNames = async () => ((await rpc('tools/list', {})).tools as { name: string }[]).map(t => t.name);

  test('the CLI tools are listed only when available', async () => {
    expect(await toolNames()).toEqual(expect.arrayContaining(['vault_cli', 'vault_cli_help']));
    delete process.env.OBSIDIAN_CLI_ENABLED;
    expect(await toolNames()).not.toContain('vault_cli');
    process.env.OBSIDIAN_CLI_ENABLED = 'true';
    await writeFile(path.join(vaultPath, '.mcpignore'), 'Private\n');
    expect(await toolNames()).not.toContain('vault_cli');
  });

  test('a connection approved without app control does not see the CLI tools, but backlinks still come from Obsidian', async () => {
    process.env.MCP_STATIC_BEARER_SCOPES = 'vault:write';
    expect(await toolNames()).not.toContain('vault_cli');
    expect(await toolNames()).not.toContain('vault_cli_help');
    process.env.FAKE_OBSIDIAN_BACKLINKS = JSON.stringify([{ file: 'Linker.md' }]);
    const links = await rpc('tools/call', { name: 'vault_links', arguments: { path: 'Open.md', include_backlinks: true } });
    expect(links.structuredContent.backlinks_source).toBe('obsidian');
  });

  test("vault_cli's read-only annotation follows the connection's editing access", async () => {
    const hint = async () => ((await rpc('tools/list', {})).tools as { name: string; annotations: { readOnlyHint: boolean } }[])
      .find(t => t.name === 'vault_cli')!.annotations.readOnlyHint;
    expect(await hint()).toBe(false);
    process.env.MCP_STATIC_BEARER_SCOPES = 'vault:cli';
    expect(await hint()).toBe(true);
  });

  test('vault_cli runs a command', async () => {
    const result = await rpc('tools/call', { name: 'vault_cli', arguments: { command: 'search', params: { query: 'x' } } });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('"command":"search"');
  });

  test('vault_links says which backend answered backlinks', async () => {
    process.env.FAKE_OBSIDIAN_BACKLINKS = JSON.stringify([{ file: 'Linker.md' }]);
    const args = { name: 'vault_links', arguments: { path: 'Open.md', include_backlinks: true } };
    const fromObsidian = await rpc('tools/call', args);
    expect(fromObsidian.structuredContent).toMatchObject({ backlinks: ['Linker.md'], backlinks_source: 'obsidian' });
    expect(fromObsidian.content[0].text).toContain('## Backlinks (from Obsidian)');
    delete process.env.OBSIDIAN_CLI_ENABLED;
    const fromServer = await rpc('tools/call', args);
    expect(fromServer.structuredContent.backlinks_source).toBe('server');
  });
});
