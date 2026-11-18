// ABOUTME: MCP_AUTH=access: the server serves /mcp only to requests carrying a valid Cloudflare Access
// JWT, mounts none of its own OAuth routes, and gives every connection the scopes ACCESS_SCOPES names.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { generateKeyPairSync, sign } from 'crypto';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import type { Server } from 'http';
import os from 'os';
import path from 'path';
import express from 'express';
import type { Express } from 'express';

const AUDIENCE = 'vault-aud';
const ENV_KEYS = ['ACCESS_SCOPES', 'VAULT_READ_ONLY'];
const WRITE_ONLY_TOOLS = ['vault_create', 'vault_update', 'vault_edit', 'vault_trash'];

let createApp: () => { app: Express; auth: unknown };
let vaultPath: string;
let team: Server;
let issuer: string;
let savedClientId: string | undefined;
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

// Mints a JWT the way Access does for a Managed OAuth connection.
function mint(claims: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: issuer, aud: [AUDIENCE], email: 'owner@example.com', sub: 'user-1', iat: now, exp: now + 900,
    oauth: { client_id: 'connection-1' }, ...claims,
  })).toString('base64url');
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

beforeAll(async () => {
  const teamApp = express();
  teamApp.get('/cdn-cgi/access/certs', (_req, res) => {
    res.json({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' }] });
  });
  team = teamApp.listen(0, '127.0.0.1');
  await new Promise(resolve => team.once('listening', resolve));
  issuer = `http://127.0.0.1:${(team.address() as { port: number }).port}`;

  vaultPath = await mkdtemp(path.join(os.tmpdir(), 'orm-access-mode-test-'));
  await writeFile(path.join(vaultPath, 'Note.md'), 'Body.\n');
  Object.assign(process.env, {
    VAULT_PATH: vaultPath,
    MCP_BASE_URL: 'https://example.test',
    VAULT_MCP_TEST: '1',
    MCP_AUTH: 'access',
    ACCESS_TEAM_DOMAIN: issuer,
    ACCESS_AUD: AUDIENCE,
  });
  savedClientId = process.env.MCP_CLIENT_ID;
  delete process.env.MCP_CLIENT_ID;
  createApp = (await import('../src/app.js')).createApp;
});

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

afterAll(async () => {
  for (const k of ['MCP_AUTH', 'ACCESS_TEAM_DOMAIN', 'ACCESS_AUD']) delete process.env[k];
  if (savedClientId !== undefined) process.env.MCP_CLIENT_ID = savedClientId;
  team.close();
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

function post(base: string, jwt: string | undefined, method: string, params: unknown): Promise<Response> {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(jwt ? { 'Cf-Access-Jwt-Assertion': jwt } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function rpc(base: string, method: string, params: unknown): Promise<any> {
  const text = await (await post(base, mint(), method, params)).text();
  const line = text.split('\n').find(l => l.startsWith('data: '));
  return JSON.parse(line ? line.slice(6) : text).result;
}

const toolNames = async (base: string): Promise<string[]> =>
  ((await rpc(base, 'tools/list', {})).tools as { name: string }[]).map(t => t.name);

describe('with MCP_AUTH=access', () => {
  test('starts without MCP_CLIENT_ID or an approval guard, and has no token store', () => {
    expect(createApp().auth).toBeUndefined();
  });

  test('refuses requests without a valid Access JWT', async () => {
    await withServer(async base => {
      expect((await post(base, undefined, 'tools/list', {})).status).toBe(403);
      expect((await post(base, mint({ aud: ['other-app'] }), 'tools/list', {})).status).toBe(403);
      expect((await post(base, mint().slice(0, -4) + 'AAAA', 'tools/list', {})).status).toBe(403);
    });
  });

  test("mounts none of the server's own OAuth routes", async () => {
    await withServer(async base => {
      expect((await fetch(`${base}/authorize`)).status).toBe(404);
      expect((await fetch(`${base}/.well-known/oauth-authorization-server`)).status).toBe(404);
    });
  });

  test('gives every connection editing by default', async () => {
    await withServer(async base => {
      expect(await toolNames(base)).toEqual(expect.arrayContaining(WRITE_ONLY_TOOLS));
    });
  });

  test('ACCESS_SCOPES=none makes connections read-only, and says which setting to change', async () => {
    process.env.ACCESS_SCOPES = 'none';
    await withServer(async base => {
      const names = await toolNames(base);
      for (const name of WRITE_ONLY_TOOLS) expect(names).not.toContain(name);
      const move = await rpc(base, 'tools/call', { name: 'vault_move', arguments: { source: 'Note.md', destination: 'Moved.md', dry_run: false } });
      expect(move.isError).toBe(true);
      expect(move.content[0].text).toContain('ACCESS_SCOPES');
      expect(await readFile(path.join(vaultPath, 'Note.md'), 'utf-8')).toBe('Body.\n');
    });
  });

  test('VAULT_READ_ONLY stays the limit', async () => {
    process.env.VAULT_READ_ONLY = 'true';
    await withServer(async base => {
      const names = await toolNames(base);
      for (const name of WRITE_ONLY_TOOLS) expect(names).not.toContain(name);
    });
  });

  test('refuses to start with an unknown scope or without the Access settings', () => {
    process.env.ACCESS_SCOPES = 'vault:write,vault:everything';
    expect(() => createApp()).toThrow(/ACCESS_SCOPES/);
    delete process.env.ACCESS_SCOPES;
    const aud = process.env.ACCESS_AUD;
    delete process.env.ACCESS_AUD;
    try {
      expect(() => createApp()).toThrow(/ACCESS_AUD/);
    } finally {
      process.env.ACCESS_AUD = aud;
    }
  });
});
