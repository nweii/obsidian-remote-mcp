// ABOUTME: Pins the /mcp endpoint contract — the WWW-Authenticate challenge on unauthenticated and
// bad-token requests, static-bearer acceptance on POST, the tool listing, JSON-RPC method gating,
// and the (unrouted) DELETE verb. Access tokens are minted over HTTP through the real OAuth flow.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import type { Express } from 'express';

let createApp: () => { app: Express };
let vaultPath: string;

const CLIENT_ID = 'contract-client';
const REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback';

async function listen(app: Express): Promise<{ base: string; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        reject(new Error('could not get listen address'));
        return;
      }
      resolve({
        base: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((res, rej) => server.close(err => (err ? rej(err) : res()))),
      });
    });
    server.on('error', reject);
  });
}

// Mint a real access token over HTTP: approve the authorization, then exchange the code with PKCE.
async function mintToken(base: string): Promise<string> {
  const verifier = 'contract-verifier';
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const approve = await fetch(`${base}/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }),
  });
  const code = new URL(approve.headers.get('location')!).searchParams.get('code')!;
  // Re-pin (delta: token endpoint /oauth/token → /token). Path change only.
  const tokenRes = await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
    }),
  });
  return ((await tokenRes.json()) as { access_token: string }).access_token;
}

// POST a JSON-RPC message to /mcp with the given bearer; parse the JSON (or first SSE data line).
async function mcp(base: string, bearer: string, method: string, params: unknown, id = 1) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const text = await res.text();
  const line = text.split('\n').find(l => l.startsWith('data: '));
  const payload = line ? line.slice(6) : text;
  return { status: res.status, body: JSON.parse(payload) as any };
}

beforeAll(async () => {
  vaultPath = await mkdtemp(path.join(os.tmpdir(), 'orm-contract-test-'));
  process.env.VAULT_PATH = vaultPath;
  process.env.MCP_CLIENT_ID = CLIENT_ID;
  process.env.MCP_BASE_URL = 'https://example.test';
  process.env.VAULT_MCP_TEST = '1';
  delete process.env.MCP_CLIENT_SECRET;
  delete process.env.APPROVAL_PASSWORD;
  delete process.env.MCP_STATIC_BEARER_TOKEN;
  // createAuth now refuses to construct with /authorize unguarded; this suite mints tokens through the
  // click-to-approve (no-password) flow, so declare the page externally guarded.
  process.env.APPROVAL_OPEN = 'true';
  createApp = (await import('../src/app.js')).createApp;
});

afterAll(async () => {
  await rm(vaultPath, { recursive: true, force: true });
});

describe('WWW-Authenticate challenge', () => {
  test('POST without a bearer advertises the protected-resource metadata', async () => {
    const { app } = createApp();
    const { base, close } = await listen(app);
    try {
      const res = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      });
      expect(res.status).toBe(401);
      const header = res.headers.get('www-authenticate') ?? '';
      expect(header).toContain('Bearer');
      expect(header).toContain('resource_metadata="https://example.test/.well-known/oauth-protected-resource"');
      // Re-pin (delta: bearer 401 bodies → the SDK's invalid_token, not the hand-rolled unauthorized).
      expect(((await res.json()) as { error?: string }).error).toBe('invalid_token');
    } finally {
      await close();
    }
  });

  test('an invalid token is challenged with error="invalid_token"', async () => {
    const { app } = createApp();
    const { base, close } = await listen(app);
    try {
      const res = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: 'Bearer not-a-real-token',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      });
      expect(res.status).toBe(401);
      const header = res.headers.get('www-authenticate') ?? '';
      expect(header).toContain('error="invalid_token"');
      expect(((await res.json()) as { error?: string }).error).toBe('invalid_token');
    } finally {
      await close();
    }
  });
});

describe('static bearer acceptance', () => {
  test('POST initialize succeeds with the configured MCP_STATIC_BEARER_TOKEN', async () => {
    const prev = process.env.MCP_STATIC_BEARER_TOKEN;
    process.env.MCP_STATIC_BEARER_TOKEN = 'a-fixed-bearer-secret';
    try {
      const { app } = createApp();
      const { base, close } = await listen(app);
      try {
        const { status, body } = await mcp(base, 'a-fixed-bearer-secret', 'initialize', {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' },
        });
        expect(status).toBe(200);
        expect(body.result?.serverInfo?.name).toBe('obsidian-remote-mcp');
      } finally {
        await close();
      }
    } finally {
      if (prev === undefined) delete process.env.MCP_STATIC_BEARER_TOKEN;
      else process.env.MCP_STATIC_BEARER_TOKEN = prev;
    }
  });
});

describe('JSON-RPC method gating and tool listing', () => {
  test('tools/list returns a non-empty tool set including vault_read', async () => {
    const { app } = createApp();
    const { base, close } = await listen(app);
    try {
      const token = await mintToken(base);
      const { status, body } = await mcp(base, token, 'tools/list', {}, 2);
      expect(status).toBe(200);
      const names: string[] = (body.result?.tools ?? []).map((t: { name: string }) => t.name);
      expect(names.length).toBeGreaterThan(0);
      expect(names).toContain('vault_read');
    } finally {
      await close();
    }
  });

  test('an unknown JSON-RPC method returns a -32601 error', async () => {
    const { app } = createApp();
    const { base, close } = await listen(app);
    try {
      const token = await mintToken(base);
      const { status, body } = await mcp(base, token, 'no/such/method', {}, 3);
      expect(status).toBe(200);
      expect(body.error?.code).toBe(-32601);
    } finally {
      await close();
    }
  });
});

describe('DELETE /mcp', () => {
  test('is method-not-allowed (405) with a valid token', async () => {
    // Re-pin (delta: DELETE /mcp 404 → 405). The kit mounts a DELETE handler on the stateless
    // transport that answers 405 (Allow: POST) — there is no session to delete — rather than leaving
    // DELETE to fall through to Express's default 404.
    const { app } = createApp();
    const { base, close } = await listen(app);
    try {
      const token = await mintToken(base);
      const res = await fetch(`${base}/mcp`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(405);
    } finally {
      await close();
    }
  });
});
