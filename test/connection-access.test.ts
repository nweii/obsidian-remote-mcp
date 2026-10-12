// ABOUTME: Per-connection access chosen on the approval page: which boxes the page offers, what a
// connection approved without "Edit notes" can do, that VAULT_READ_ONLY stays the limit for every
// connection, and the static bearer's MCP_STATIC_BEARER_SCOPES.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import type { Express } from 'express';

let createApp: () => { app: Express };
let vaultPath: string;

const ENV_KEYS = ['VAULT_READ_ONLY', 'MCP_STATIC_BEARER_TOKEN', 'MCP_STATIC_BEARER_SCOPES', 'OBSIDIAN_CLI_ENABLED', 'OBSIDIAN_CLI_PATH'];
const BEARER = 'access-test-bearer';
const AUTHORIZE = {
  response_type: 'code',
  client_id: 'access-client',
  redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
  code_challenge: createHash('sha256').update('verifier').digest('base64url'),
  code_challenge_method: 'S256',
};
const WRITE_ONLY_TOOLS = ['vault_create', 'vault_update', 'vault_edit', 'vault_trash'];

beforeAll(async () => {
  vaultPath = await mkdtemp(path.join(os.tmpdir(), 'orm-access-test-'));
  await writeFile(path.join(vaultPath, 'Note.md'), 'Body.\n');
  Object.assign(process.env, {
    VAULT_PATH: vaultPath,
    MCP_CLIENT_ID: 'access-client',
    MCP_BASE_URL: 'https://example.test',
    APPROVAL_OPEN: 'true',
    VAULT_MCP_TEST: '1',
    DAILY_NOTE_PATH_TEMPLATE: 'Daily/{YYYY}-{MM}-{DD}.md',
  });
  createApp = (await import('../src/app.js')).createApp;
});

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

afterAll(async () => {
  delete process.env.DAILY_NOTE_PATH_TEMPLATE;
  await rm(vaultPath, { recursive: true, force: true });
});

async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const server = createApp().app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    return await fn(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function approvalPage(base: string): Promise<string> {
  return (await fetch(`${base}/authorize?${new URLSearchParams(AUTHORIZE)}`)).text();
}

// Approves a connection with the given boxes ticked and returns its access token.
async function connect(base: string, grants: string[]): Promise<string> {
  const approval = await fetch(`${base}/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams([...Object.entries(AUTHORIZE), ...grants.map(g => ['grant', g])]),
  });
  const code = new URL(approval.headers.get('location')!).searchParams.get('code')!;
  const token = await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code, code_verifier: 'verifier',
      client_id: AUTHORIZE.client_id, redirect_uri: AUTHORIZE.redirect_uri,
    }),
  });
  return ((await token.json()) as { access_token: string }).access_token;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function rpc(base: string, token: string, method: string, params: unknown): Promise<any> {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await res.text();
  const line = text.split('\n').find(l => l.startsWith('data: '));
  return JSON.parse(line ? line.slice(6) : text).result;
}

const toolNames = async (base: string, token: string): Promise<string[]> =>
  ((await rpc(base, token, 'tools/list', {})).tools as { name: string }[]).map(t => t.name);

describe('the approval page', () => {
  test('offers editing, ticked, under a line saying every connection can read', async () => {
    await withServer(async base => {
      const html = await approvalPage(base);
      expect(html).toContain('Every connection can read your notes. Also allow this one to:');
      expect(html).toMatch(/value="vault:write" checked><span>Edit notes<small>Create, edit, move and trash notes\.<\/small>/);
    });
  });

  test('offers app control while the Obsidian CLI tools are turned on, even if Obsidian is unreachable', async () => {
    await withServer(async base => {
      expect(await approvalPage(base)).not.toContain('Control the Obsidian app');
    });
    process.env.OBSIDIAN_CLI_ENABLED = 'true';
    process.env.OBSIDIAN_CLI_PATH = path.join(vaultPath, 'no-such-obsidian');
    await withServer(async base => {
      expect(await approvalPage(base)).toMatch(/value="vault:cli" checked><span>Control the Obsidian app/);
    });
  });

  test('offers nothing to choose when the vault is read-only for everyone', async () => {
    process.env.VAULT_READ_ONLY = 'true';
    await withServer(async base => {
      expect(await approvalPage(base)).not.toContain('class="access"');
    });
  });
});

describe('a connection approved without "Edit notes"', () => {
  test('sees no write-only tools', async () => {
    await withServer(async base => {
      const names = await toolNames(base, await connect(base, []));
      for (const name of WRITE_ONLY_TOOLS) expect(names).not.toContain(name);
      expect(names).toEqual(expect.arrayContaining(['vault_read', 'vault_periodic_note', 'vault_move']));
    });
  });

  test('stays read-only when it was approved while the whole vault was', async () => {
    process.env.VAULT_READ_ONLY = 'true';
    await withServer(async base => {
      const token = await connect(base, ['vault:write']);
      delete process.env.VAULT_READ_ONLY;
      const names = await toolNames(base, token);
      for (const name of WRITE_ONLY_TOOLS) expect(names).not.toContain(name);
    });
  });

  test('is refused by tools that can write, with a message pointing at the approval page', async () => {
    await withServer(async base => {
      const token = await connect(base, []);
      const result = await rpc(base, token, 'tools/call', { name: 'vault_periodic_note', arguments: { period: 'daily', create_if_missing: true } });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('approved without "Edit notes"');
      const move = await rpc(base, token, 'tools/call', { name: 'vault_move', arguments: { source: 'Note.md', destination: 'Moved.md', dry_run: false } });
      expect(move.isError).toBe(true);
      expect(move.content[0].text).toContain('approved without "Edit notes"');
      expect(await readFile(path.join(vaultPath, 'Note.md'), 'utf-8')).toBe('Body.\n');
    });
  });

  test('does not change another connection that kept editing', async () => {
    await withServer(async base => {
      await connect(base, []);
      const names = await toolNames(base, await connect(base, ['vault:write']));
      for (const name of WRITE_ONLY_TOOLS) expect(names).toContain(name);
    });
  });
});

test('VAULT_READ_ONLY limits every connection, whatever it was granted', async () => {
  await withServer(async base => {
    const token = await connect(base, ['vault:write']);
    process.env.VAULT_READ_ONLY = 'true';
    const names = await toolNames(base, token);
    for (const name of WRITE_ONLY_TOOLS) expect(names).not.toContain(name);
  });
});

describe('the static bearer token', () => {
  test('has full access by default', async () => {
    process.env.MCP_STATIC_BEARER_TOKEN = BEARER;
    await withServer(async base => {
      for (const name of WRITE_ONLY_TOOLS) expect(await toolNames(base, BEARER)).toContain(name);
    });
  });

  test('follows MCP_STATIC_BEARER_SCOPES, where "none" means read-only', async () => {
    process.env.MCP_STATIC_BEARER_TOKEN = BEARER;
    process.env.MCP_STATIC_BEARER_SCOPES = 'none';
    await withServer(async base => {
      expect(await toolNames(base, BEARER)).not.toContain('vault_create');
    });
  });

  test('refuses to start with an unknown scope name', () => {
    process.env.MCP_STATIC_BEARER_TOKEN = BEARER;
    process.env.MCP_STATIC_BEARER_SCOPES = 'vault:edit';
    expect(() => createApp()).toThrow(/vault:edit/);
  });
});
