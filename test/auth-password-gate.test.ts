// ABOUTME: Tests for the optional OAuth password gate — off by default (click-to-approve issues a
// code), and when VAULT_OAUTH_PASSWORD is set it requires valid credentials before issuing a code.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import type { Express } from 'express';

let createApp: () => Express;
let vaultPath: string;

const PARAMS = {
  response_type: 'code',
  client_id: 'gate-client',
  redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
  code_challenge: createHash('sha256').update('verifier').digest('base64url'),
  code_challenge_method: 'S256',
};

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

async function getAuthorize(base: string): Promise<Response> {
  return fetch(`${base}/authorize?${new URLSearchParams(PARAMS)}`);
}

async function postAuthorize(base: string, extra: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...PARAMS, ...extra }),
  });
}

// Run fn with the gate env applied, then restore — keeps each test independent.
async function withGate(
  env: { password?: string; username?: string },
  fn: () => Promise<void>,
): Promise<void> {
  const prevPw = process.env.VAULT_OAUTH_PASSWORD;
  const prevUser = process.env.VAULT_OAUTH_USERNAME;
  if (env.password === undefined) delete process.env.VAULT_OAUTH_PASSWORD;
  else process.env.VAULT_OAUTH_PASSWORD = env.password;
  if (env.username === undefined) delete process.env.VAULT_OAUTH_USERNAME;
  else process.env.VAULT_OAUTH_USERNAME = env.username;
  try {
    await fn();
  } finally {
    if (prevPw === undefined) delete process.env.VAULT_OAUTH_PASSWORD;
    else process.env.VAULT_OAUTH_PASSWORD = prevPw;
    if (prevUser === undefined) delete process.env.VAULT_OAUTH_USERNAME;
    else process.env.VAULT_OAUTH_USERNAME = prevUser;
  }
}

beforeAll(async () => {
  vaultPath = await mkdtemp(path.join(os.tmpdir(), 'orm-gate-test-'));
  process.env.VAULT_PATH = vaultPath;
  process.env.MCP_CLIENT_ID = 'gate-client';
  process.env.MCP_BASE_URL = 'https://example.test';
  process.env.VAULT_MCP_TEST = '1';
  delete process.env.VAULT_OAUTH_PASSWORD;
  delete process.env.VAULT_OAUTH_USERNAME;
  createApp = (await import('../src/app.js')).createApp;
});

afterAll(async () => {
  await rm(vaultPath, { recursive: true, force: true });
});

describe('password gate off (default)', () => {
  test('GET /authorize renders no password field', async () => {
    await withGate({}, async () => {
      const app = createApp();
      const { base, close } = await listen(app);
      try {
        const html = await (await getAuthorize(base)).text();
        expect(html).toContain('Approve');
        expect(html).not.toContain('name="password"');
      } finally {
        await close();
      }
    });
  });

  test('POST /authorize issues a code with no credentials', async () => {
    await withGate({}, async () => {
      const app = createApp();
      const { base, close } = await listen(app);
      try {
        const res = await postAuthorize(base);
        expect(res.status).toBe(302);
        const code = new URL(res.headers.get('location')!).searchParams.get('code');
        expect(code).toBeTruthy();
      } finally {
        await close();
      }
    });
  });
});

describe('password gate on', () => {
  test('GET /authorize renders username + password fields', async () => {
    await withGate({ password: 'hunter2' }, async () => {
      const app = createApp();
      const { base, close } = await listen(app);
      try {
        const html = await (await getAuthorize(base)).text();
        expect(html).toContain('name="username"');
        expect(html).toContain('name="password"');
      } finally {
        await close();
      }
    });
  });

  test('POST without credentials is rejected with 401 and no redirect', async () => {
    await withGate({ password: 'hunter2' }, async () => {
      const app = createApp();
      const { base, close } = await listen(app);
      try {
        const res = await postAuthorize(base);
        expect(res.status).toBe(401);
        expect(res.headers.get('location')).toBeNull();
      } finally {
        await close();
      }
    });
  });

  test('POST with the wrong password is rejected with 401', async () => {
    await withGate({ password: 'hunter2' }, async () => {
      const app = createApp();
      const { base, close } = await listen(app);
      try {
        const res = await postAuthorize(base, { username: 'obsidian', password: 'wrong' });
        expect(res.status).toBe(401);
      } finally {
        await close();
      }
    });
  });

  test('POST with correct default-username credentials issues a code', async () => {
    await withGate({ password: 'hunter2' }, async () => {
      const app = createApp();
      const { base, close } = await listen(app);
      try {
        const res = await postAuthorize(base, { username: 'obsidian', password: 'hunter2' });
        expect(res.status).toBe(302);
        expect(new URL(res.headers.get('location')!).searchParams.get('code')).toBeTruthy();
      } finally {
        await close();
      }
    });
  });

  test('a custom username is enforced', async () => {
    await withGate({ password: 'hunter2', username: 'nathan' }, async () => {
      const app = createApp();
      const { base, close } = await listen(app);
      try {
        expect((await postAuthorize(base, { username: 'obsidian', password: 'hunter2' })).status).toBe(401);
        expect((await postAuthorize(base, { username: 'nathan', password: 'hunter2' })).status).toBe(302);
      } finally {
        await close();
      }
    });
  });

  test('state round-trips to the redirect with the gate on', async () => {
    await withGate({ password: 'hunter2' }, async () => {
      const app = createApp();
      const { base, close } = await listen(app);
      try {
        const res = await postAuthorize(base, { username: 'obsidian', password: 'hunter2', state: 'xyz-state' });
        expect(res.status).toBe(302);
        expect(new URL(res.headers.get('location')!).searchParams.get('state')).toBe('xyz-state');
      } finally {
        await close();
      }
    });
  });

  test('the 401 re-render preserves state and escapes a reflected username', async () => {
    await withGate({ password: 'hunter2' }, async () => {
      const app = createApp();
      const { base, close } = await listen(app);
      try {
        const res = await postAuthorize(base, {
          username: '"><script>x</script>',
          password: 'wrong',
          state: 'keepme',
        });
        expect(res.status).toBe(401);
        const html = await res.text();
        expect(html).toContain('value="keepme"');          // state carried in a hidden input
        expect(html).not.toContain('<script>x</script>');   // username not reflected raw
        expect(html).toContain('&lt;script&gt;');           // escaped form present
      } finally {
        await close();
      }
    });
  });
});
