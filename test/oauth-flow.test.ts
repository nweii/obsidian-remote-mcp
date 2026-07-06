// ABOUTME: Pins the authorization-code + PKCE flow — the GET /authorize parameter validation, every
// POST /oauth/token reject path (bad grant, unknown/reused code, client and redirect mismatches,
// failed PKCE, stray client_secret) and the token payload on a successful exchange.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'crypto';
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import type { Express } from 'express';

let createApp: () => Express;
let vaultPath: string;

const CLIENT_ID = 'flow-client';
const REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback';
const OTHER_REDIRECT_URI = 'cursor://anysphere.cursor-mcp/oauth/callback';

function toCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

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

// POST /authorize (click-to-approve, no password gate here) and return the issued code.
async function issueCode(base: string, challenge: string): Promise<string> {
  const res = await fetch(`${base}/authorize`, {
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
  expect(res.status).toBe(302);
  const code = new URL(res.headers.get('location')!).searchParams.get('code');
  expect(code).toBeTruthy();
  return code!;
}

async function postToken(base: string, params: Record<string, string>): Promise<Response> {
  return fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
}

beforeAll(async () => {
  vaultPath = await mkdtemp(path.join(os.tmpdir(), 'orm-flow-test-'));
  process.env.VAULT_PATH = vaultPath;
  process.env.MCP_CLIENT_ID = CLIENT_ID;
  process.env.MCP_BASE_URL = 'https://example.test';
  process.env.VAULT_MCP_TEST = '1';
  // This file exercises the PKCE-only exchange; a stray client secret would change the token path.
  delete process.env.MCP_CLIENT_SECRET;
  delete process.env.VAULT_APPROVAL_PASSWORD;
  createApp = (await import('../src/app.js')).createApp;
});

afterAll(async () => {
  await rm(vaultPath, { recursive: true, force: true });
});

describe('GET /authorize parameter validation', () => {
  async function getAuthorize(base: string, overrides: Record<string, string>): Promise<Response> {
    const params = {
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_challenge: toCodeChallenge('some-verifier'),
      code_challenge_method: 'S256',
      ...overrides,
    };
    return fetch(`${base}/authorize?${new URLSearchParams(params)}`);
  }

  test('rejects an unsupported response_type', async () => {
    const app = createApp();
    const { base, close } = await listen(app);
    try {
      const res = await getAuthorize(base, { response_type: 'token' });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain('Unsupported response_type');
    } finally {
      await close();
    }
  });

  test('rejects an unknown client_id', async () => {
    const app = createApp();
    const { base, close } = await listen(app);
    try {
      const res = await getAuthorize(base, { client_id: 'not-the-client' });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain('Unknown client_id');
    } finally {
      await close();
    }
  });

  test('rejects a redirect_uri outside the allowlist', async () => {
    const app = createApp();
    const { base, close } = await listen(app);
    try {
      const res = await getAuthorize(base, { redirect_uri: 'https://evil.example/callback' });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain('redirect_uri not allowed');
    } finally {
      await close();
    }
  });

  test('rejects a non-S256 PKCE challenge method', async () => {
    const app = createApp();
    const { base, close } = await listen(app);
    try {
      const res = await getAuthorize(base, { code_challenge_method: 'plain' });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain('PKCE with S256 is required');
    } finally {
      await close();
    }
  });

  test('rejects a missing PKCE challenge', async () => {
    const app = createApp();
    const { base, close } = await listen(app);
    try {
      const res = await getAuthorize(base, { code_challenge: '' });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain('PKCE with S256 is required');
    } finally {
      await close();
    }
  });
});

describe('POST /oauth/token reject paths', () => {
  test('unsupported grant_type returns 400 unsupported_grant_type', async () => {
    const app = createApp();
    const { base, close } = await listen(app);
    try {
      const res = await postToken(base, { grant_type: 'client_credentials', code: 'x' });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error?: string }).error).toBe('unsupported_grant_type');
    } finally {
      await close();
    }
  });

  test('missing code returns 400 invalid_request', async () => {
    const app = createApp();
    const { base, close } = await listen(app);
    try {
      const res = await postToken(base, { grant_type: 'authorization_code' });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error?: string }).error).toBe('invalid_request');
    } finally {
      await close();
    }
  });

  test('unknown code returns 400 invalid_grant', async () => {
    const app = createApp();
    const { base, close } = await listen(app);
    try {
      const res = await postToken(base, {
        grant_type: 'authorization_code',
        code: randomUUID(),
        code_verifier: 'whatever',
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error?: string }).error).toBe('invalid_grant');
    } finally {
      await close();
    }
  });

  test('mismatched client_id returns 400 invalid_grant', async () => {
    const app = createApp();
    const { base, close } = await listen(app);
    try {
      const verifier = 'verifier-client-mismatch';
      const code = await issueCode(base, toCodeChallenge(verifier));
      const res = await postToken(base, {
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        client_id: 'a-different-client',
        redirect_uri: REDIRECT_URI,
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error?: string }).error).toBe('invalid_grant');
    } finally {
      await close();
    }
  });

  test('mismatched redirect_uri returns 400 invalid_grant', async () => {
    const app = createApp();
    const { base, close } = await listen(app);
    try {
      const verifier = 'verifier-redirect-mismatch';
      const code = await issueCode(base, toCodeChallenge(verifier));
      const res = await postToken(base, {
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        client_id: CLIENT_ID,
        redirect_uri: OTHER_REDIRECT_URI,
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error?: string }).error).toBe('invalid_grant');
    } finally {
      await close();
    }
  });

  test('wrong PKCE verifier returns 400 invalid_grant', async () => {
    const app = createApp();
    const { base, close } = await listen(app);
    try {
      const code = await issueCode(base, toCodeChallenge('the-real-verifier'));
      const res = await postToken(base, {
        grant_type: 'authorization_code',
        code,
        code_verifier: 'the-wrong-verifier',
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string; error_description?: string };
      expect(body.error).toBe('invalid_grant');
      expect(body.error_description).toContain('PKCE');
    } finally {
      await close();
    }
  });

  test('a stray client_secret returns 401 invalid_client when none is configured', async () => {
    const app = createApp();
    const { base, close } = await listen(app);
    try {
      const verifier = 'verifier-stray-secret';
      const code = await issueCode(base, toCodeChallenge(verifier));
      const res = await postToken(base, {
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        client_id: CLIENT_ID,
        client_secret: 'unexpected',
        redirect_uri: REDIRECT_URI,
      });
      expect(res.status).toBe(401);
      expect(((await res.json()) as { error?: string }).error).toBe('invalid_client');
    } finally {
      await close();
    }
  });

  test('an authorization code is single-use', async () => {
    const app = createApp();
    const { base, close } = await listen(app);
    try {
      const verifier = 'verifier-single-use';
      const code = await issueCode(base, toCodeChallenge(verifier));
      const exchange = () =>
        postToken(base, {
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
          client_id: CLIENT_ID,
          redirect_uri: REDIRECT_URI,
        });
      const first = await exchange();
      expect(first.ok).toBe(true);
      const second = await exchange();
      expect(second.status).toBe(400);
      expect(((await second.json()) as { error?: string }).error).toBe('invalid_grant');
    } finally {
      await close();
    }
  });
});

describe('POST /oauth/token success', () => {
  test('a valid PKCE exchange returns a bearer token with an expiry', async () => {
    const app = createApp();
    const { base, close } = await listen(app);
    try {
      const verifier = 'verifier-happy-path';
      const code = await issueCode(base, toCodeChallenge(verifier));
      const res = await postToken(base, {
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
      });
      expect(res.ok).toBe(true);
      const body = (await res.json()) as { access_token?: string; token_type?: string; expires_in?: number };
      expect(typeof body.access_token).toBe('string');
      expect(body.access_token!.length).toBeGreaterThan(0);
      expect(body.token_type).toBe('bearer');
      expect(body.expires_in).toBe(30 * 24 * 60 * 60);
    } finally {
      await close();
    }
  });
});
