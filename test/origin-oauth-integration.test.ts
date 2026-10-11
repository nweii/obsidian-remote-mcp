// ABOUTME: Protocol simulations of password-protected OAuth + PKCE and authenticated MCP
// access with Claude-style preconfigured and ChatGPT-style DCR callbacks. These are local
// HTTP regression tests, not tests against the actual vendor clients.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';

let createApp: typeof import('../src/app.js').createApp;
let vaultPath: string;
const siteOrigin = 'https://vault.example';
const password = 'integration-approval-password';
const staticClientId = 'origin-oauth-integration-client';
const noteContent = 'The authenticated OAuth integration fixture.\n';
const envKeys = ['VAULT_PATH', 'VAULT_MCP_TEST', 'MCP_CLIENT_ID', 'MCP_CLIENT_SECRET',
  'MCP_CLIENT_ALLOWED_REDIRECT_URIS', 'MCP_BASE_URL', 'APPROVAL_PASSWORD', 'APPROVAL_OPEN',
  'MCP_STATIC_BEARER_TOKEN', 'MCP_DCR_ENABLED', 'MCP_DCR_ALLOWED_REDIRECT_URIS',
  'CORS_ALLOWED_ORIGINS', 'TOKEN_STORE_PATH'];
let savedEnv: Map<string, string | undefined>;

const clients = [
  { name: 'preconfigured Claude-style', origin: 'https://claude.ai',
    callback: 'https://claude.ai/api/mcp/auth_callback', dynamic: false },
  { name: 'DCR ChatGPT-style', origin: 'https://chatgpt.com',
    callback: 'https://chatgpt.com/connector/oauth/integration-test', dynamic: true },
];

beforeAll(async () => {
  savedEnv = new Map(envKeys.map(key => [key, process.env[key]]));
  vaultPath = await mkdtemp(path.join(os.tmpdir(), 'origin-oauth-integration-'));
  await writeFile(path.join(vaultPath, 'Fixture.md'), noteContent);
  createApp = (await import('../src/app.js')).createApp;
});

beforeEach(() => {
  for (const key of envKeys) delete process.env[key];
  Object.assign(process.env, {
    VAULT_PATH: vaultPath,
    VAULT_MCP_TEST: '1',
    MCP_CLIENT_ID: staticClientId,
    MCP_CLIENT_ALLOWED_REDIRECT_URIS: clients[0].callback,
    MCP_BASE_URL: siteOrigin,
    APPROVAL_PASSWORD: password,
    TOKEN_STORE_PATH: path.join(vaultPath, 'tokens.json'),
  });
});

afterAll(async () => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(vaultPath, { recursive: true, force: true });
});

async function withServer(run: (base: string) => Promise<void>) {
  const { app } = createApp();
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing listen address');
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

function originHeaders(origin?: string): Record<string, string> {
  return origin === undefined ? {} : { Origin: origin };
}

async function checkDiscoveryAndPreflights(base: string, origin: string, dynamic: boolean) {
  for (const endpoint of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource']) {
    const response = await fetch(`${base}${endpoint}`, { headers: originHeaders(origin) });
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    const metadata = await response.json();
    if (endpoint.endsWith('oauth-authorization-server')) {
      expect(metadata.token_endpoint).toBe(`${siteOrigin}/token`);
      expect(metadata.authorization_endpoint).toBe(`${siteOrigin}/authorize`);
      expect(metadata.code_challenge_methods_supported).toContain('S256');
      expect(metadata.registration_endpoint).toBe(dynamic ? `${siteOrigin}/register` : undefined);
    }
  }
  for (const endpoint of ['/token', ...(dynamic ? ['/register'] : []),
    '/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource']) {
    const method = endpoint.startsWith('/.well-known/') ? 'GET' : 'POST';
    const response = await fetch(`${base}${endpoint}`, {
      method: 'OPTIONS',
      headers: { Origin: origin, 'Access-Control-Request-Method': method,
        'Access-Control-Request-Headers': 'content-type' },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-methods')).toContain(method);
    expect(response.headers.get('access-control-allow-headers')).toContain('content-type');
    await response.text();
  }
}

async function mintToken(base: string, client: typeof clients[number], origin?: string): Promise<string> {
  let clientId = staticClientId;
  if (client.dynamic) {
    const response = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { ...originHeaders(origin), 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Local ChatGPT-style protocol simulation',
        redirect_uris: [client.callback], token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'], response_types: ['code'] }),
    });
    expect(response.status).toBe(201);
    clientId = (await response.json()).client_id;
    expect(clientId).toBeString();
    expect(clientId).not.toBe(staticClientId);
  }
  const verifier = randomBytes(32).toString('base64url');
  const state = randomUUID();
  const authorizeParams = {
    response_type: 'code', client_id: clientId, redirect_uri: client.callback,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256', state,
  };
  const page = await fetch(`${base}/authorize?${new URLSearchParams(authorizeParams)}`, {
    headers: originHeaders(origin), redirect: 'manual',
  });
  expect(page.status).toBe(200);
  expect(await page.text()).toContain('name="password"');

  const approve = (approvalPassword: string) => fetch(`${base}/authorize`, {
    method: 'POST', redirect: 'manual',
    headers: { ...originHeaders(origin), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...authorizeParams, password: approvalPassword }),
  });
  const refused = await approve('wrong-password');
  expect(refused.status).toBe(401);
  expect(refused.headers.get('location')).toBeNull();
  await refused.text();

  const approval = await approve(password);
  expect(approval.status).toBe(302);
  const location = new URL(approval.headers.get('location')!);
  expect(`${location.origin}${location.pathname}`).toBe(client.callback);
  expect(location.searchParams.get('state')).toBe(state);
  const code = location.searchParams.get('code');
  expect(code).toBeTruthy();
  await approval.text();

  const exchange = (codeVerifier: string) => fetch(`${base}/token`, {
    method: 'POST',
    headers: { ...originHeaders(origin), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: code!,
      client_id: clientId, redirect_uri: client.callback, code_verifier: codeVerifier }),
  });
  const wrongPkce = await exchange('wrong-verifier'.repeat(4));
  expect(wrongPkce.status).toBe(400);
  expect((await wrongPkce.json()).error).toBe('invalid_grant');

  const token = await exchange(verifier);
  expect(token.status).toBe(200);
  const payload = await token.json();
  expect(payload.token_type).toBe('bearer');
  expect(payload.access_token).toBeString();
  expect(payload.access_token.length).toBeGreaterThan(0);
  const reusedCode = await exchange(verifier);
  expect(reusedCode.status).toBe(400);
  expect((await reusedCode.json()).error).toBe('invalid_grant');
  return payload.access_token;
}

async function mcp(base: string, token: string | undefined, origin: string | undefined, method: string, params = {}) {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { ...originHeaders(origin), 'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

async function rpcResult(response: Response) {
  expect(response.status).toBe(200);
  const text = await response.text();
  const event = text.split('\n').find(line => line.startsWith('data: '));
  const body = JSON.parse(event ? event.slice(6) : text);
  expect(body.error).toBeUndefined();
  expect(body.result).toBeDefined();
  return body.result;
}

describe('OAuth and MCP protocol simulations with default browser origins', () => {
  for (const client of clients) {
    for (const origin of [undefined, client.origin]) {
      test(`${client.name}: password + PKCE + MCP ${origin ? `with Origin ${origin}` : 'without Origin'}`, async () => {
        if (client.dynamic) {
          process.env.MCP_DCR_ENABLED = 'true';
          process.env.MCP_DCR_ALLOWED_REDIRECT_URIS = 'https://chatgpt.com/*';
        }
        await withServer(async base => {
          await checkDiscoveryAndPreflights(base, client.origin, client.dynamic);
          const token = await mintToken(base, client, origin);
          const initResponse = await mcp(base, token, origin, 'initialize', {
            protocolVersion: '2025-11-25', capabilities: {},
            clientInfo: { name: 'Local origin protocol simulation', version: '1.0.0' },
          });
          if (origin) expect(initResponse.headers.get('access-control-allow-origin')).toBe(origin);
          const initialized = await rpcResult(initResponse);
          expect(initialized.serverInfo.name).toBe('obsidian-remote-mcp');
          const listed = await rpcResult(await mcp(base, token, origin, 'tools/list'));
          expect(listed.tools.some((tool: { name: string }) => tool.name === 'vault_read')).toBe(true);
          const read = await rpcResult(await mcp(base, token, origin, 'tools/call', {
            name: 'vault_read', arguments: { path: 'Fixture.md' },
          }));
          expect(read.isError).not.toBe(true);
          expect(read.content.some((block: { type: string; text?: string }) =>
            block.type === 'text' && block.text?.includes(noteContent))).toBe(true);

          const unrelated = await mcp(base, token, 'https://unrelated.example', 'tools/call', {
            name: 'vault_read', arguments: { path: 'Fixture.md' },
          });
          expect(unrelated.status).toBe(403);
          expect(unrelated.headers.get('access-control-allow-origin')).toBeNull();
          await unrelated.text();
          for (const trustedOrigin of [undefined, siteOrigin, ...clients.map(value => value.origin)]) {
            const unauthorized = await mcp(base, undefined, trustedOrigin, 'tools/list');
            expect(unauthorized.status).toBe(401);
            expect(unauthorized.headers.get('www-authenticate')).toContain('Bearer');
            await unauthorized.text();
          }
        });
      });
    }
  }
});
