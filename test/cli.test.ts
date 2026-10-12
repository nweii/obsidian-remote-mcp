// ABOUTME: The opt-in Obsidian CLI tools against a fake binary: availability and registration gates,
// argv construction, output cleanup, guards, re-probing after failure, and backlinks routed through
// Obsidian with fallback to the server's index.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { fakeCalls, installFakeObsidian } from './fake-obsidian.js';
import * as cli from '../src/cli.js';

const ENV_KEYS = [
  'VAULT_PATH', 'VAULT_READ_ONLY', 'OBSIDIAN_CLI_ENABLED', 'OBSIDIAN_CLI_PATH', 'OBSIDIAN_CLI_VAULT',
  'OBSIDIAN_CLI_COMMANDS', 'OBSIDIAN_CLI_MCPIGNORE_ACK', 'FAKE_OBSIDIAN_VAULT', 'FAKE_OBSIDIAN_DOWN',
  'FAKE_OBSIDIAN_FAIL', 'FAKE_OBSIDIAN_BACKLINKS', 'FAKE_OBSIDIAN_LOG', 'MCP_CLIENT_ID', 'MCP_BASE_URL',
  'MCP_STATIC_BEARER_TOKEN', 'APPROVAL_OPEN',
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
    await writeFile(path.join(vaultPath, '.mcpignore'), '# comment only\n');
    expect((await cli.cliToolsAvailability()).ok).toBe(true);
    await writeFile(path.join(vaultPath, '.mcpignore'), 'Private\n');
    const withheld = await cli.cliToolsAvailability();
    expect(withheld.ok).toBe(false);
    expect(withheld.ok ? '' : withheld.reason).toContain('OBSIDIAN_CLI_MCPIGNORE_ACK');
    process.env.OBSIDIAN_CLI_MCPIGNORE_ACK = 'true';
    expect((await cli.cliToolsAvailability()).ok).toBe(true);
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
    process.env.OBSIDIAN_CLI_VAULT = 'Brain';
    await cli.runCli({ command: 'search', params: { query: 'x' } });
    expect((await fakeCalls(logFile))[0]![0]).toBe('vault=Brain');
  });

  test('resolves file= through the server and passes the exact path', async () => {
    await cli.runCli({ command: 'read', params: { file: 'Open' } });
    expect((await fakeCalls(logFile))[0]).toEqual(['vault=Vault', 'read', 'path=Open.md']);
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
    'plugins:restrict', 'theme:install', 'snippet:enable'])('always blocks %s', async command => {
    expect(await refused({ command })).toContain('blocked');
  });

  test('rejects malformed command names, keys and flags', async () => {
    await refused({ command: 'search --help' });
    await refused({ command: 'Search' });
    await refused({ command: 'search', params: { 'Query': 'x' } });
    await refused({ command: 'search', params: { 'query x': 'x' } });
    await refused({ command: 'search', flags: ['--copy'] });
    await refused({ command: 'search', flags: ['vault=Other'] });
    await refused({ command: 'search', flags: ['counts extra'] });
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

  test('stays off while .mcpignore has rules and no acknowledgment', async () => {
    await writeFile(path.join(vaultPath, '.mcpignore'), 'Private\n');
    await refused({ command: 'search', params: { query: 'x' } });
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
