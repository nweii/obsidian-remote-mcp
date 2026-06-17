// ABOUTME: Tests for the OAuth approval-page password — the page issues a code on click when no
// password is set, requires the correct password when VAULT_APPROVAL_PASSWORD is set, and the
// startup guard (assertApprovalGuardConfigured) refuses to run unless an approval password, a
// client secret, or VAULT_APPROVAL_OPEN is configured.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import type { Express } from 'express';

let createApp: () => Express;
let assertApprovalGuardConfigured: () => void;
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

// Apply env vars (clearing those set to undefined) for the duration of fn, then restore — so each
// test controls the gate without leaking state to the others.
async function withEnvs(envs: Record<string, string | undefined>, fn: () => void | Promise<void>): Promise<void> {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(envs)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

beforeAll(async () => {
  vaultPath = await mkdtemp(path.join(os.tmpdir(), 'orm-gate-test-'));
  process.env.VAULT_PATH = vaultPath;
  process.env.MCP_CLIENT_ID = 'gate-client';
  process.env.MCP_BASE_URL = 'https://example.test';
  process.env.VAULT_MCP_TEST = '1';
  delete process.env.VAULT_APPROVAL_PASSWORD;
  delete process.env.VAULT_APPROVAL_OPEN;
  createApp = (await import('../src/app.js')).createApp;
  assertApprovalGuardConfigured = (await import('../src/auth.js')).assertApprovalGuardConfigured;
});

afterAll(async () => {
  await rm(vaultPath, { recursive: true, force: true });
});

describe('approval page without a password (click-to-approve)', () => {
  test('GET /authorize renders no password field', async () => {
    await withEnvs({ VAULT_APPROVAL_PASSWORD: undefined }, async () => {
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

  test('POST /authorize issues a code with no password', async () => {
    await withEnvs({ VAULT_APPROVAL_PASSWORD: undefined }, async () => {
      const app = createApp();
      const { base, close } = await listen(app);
      try {
        const res = await postAuthorize(base);
        expect(res.status).toBe(302);
        expect(new URL(res.headers.get('location')!).searchParams.get('code')).toBeTruthy();
      } finally {
        await close();
      }
    });
  });
});

describe('approval page with a password', () => {
  const PW = { VAULT_APPROVAL_PASSWORD: 'hunter2' };

  test('GET /authorize renders a password field and no username field', async () => {
    await withEnvs(PW, async () => {
      const app = createApp();
      const { base, close } = await listen(app);
      try {
        const html = await (await getAuthorize(base)).text();
        expect(html).toContain('name="password"');
        expect(html).not.toContain('name="username"');
      } finally {
        await close();
      }
    });
  });

  test('POST without a password is rejected with 401 and no redirect', async () => {
    await withEnvs(PW, async () => {
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
    await withEnvs(PW, async () => {
      const app = createApp();
      const { base, close } = await listen(app);
      try {
        expect((await postAuthorize(base, { password: 'wrong' })).status).toBe(401);
      } finally {
        await close();
      }
    });
  });

  test('POST with the correct password issues a code', async () => {
    await withEnvs(PW, async () => {
      const app = createApp();
      const { base, close } = await listen(app);
      try {
        const res = await postAuthorize(base, { password: 'hunter2' });
        expect(res.status).toBe(302);
        expect(new URL(res.headers.get('location')!).searchParams.get('code')).toBeTruthy();
      } finally {
        await close();
      }
    });
  });

  test('state round-trips to the redirect after a correct password', async () => {
    await withEnvs(PW, async () => {
      const app = createApp();
      const { base, close } = await listen(app);
      try {
        const res = await postAuthorize(base, { password: 'hunter2', state: 'xyz-state' });
        expect(res.status).toBe(302);
        expect(new URL(res.headers.get('location')!).searchParams.get('state')).toBe('xyz-state');
      } finally {
        await close();
      }
    });
  });

  test('the 401 re-render preserves state and shows the password field again', async () => {
    await withEnvs(PW, async () => {
      const app = createApp();
      const { base, close } = await listen(app);
      try {
        const res = await postAuthorize(base, { password: 'wrong', state: 'keepme' });
        expect(res.status).toBe(401);
        const html = await res.text();
        expect(html).toContain('value="keepme"');   // state carried in a hidden input
        expect(html).toContain('name="password"');  // password field re-rendered for a retry
      } finally {
        await close();
      }
    });
  });
});

describe('assertApprovalGuardConfigured (startup guard)', () => {
  test('throws when no password, client secret, or open opt-out is set', async () => {
    await withEnvs(
      { VAULT_APPROVAL_PASSWORD: undefined, VAULT_APPROVAL_OPEN: undefined, MCP_CLIENT_SECRET: undefined },
      () => { expect(() => assertApprovalGuardConfigured()).toThrow(/Refusing to start/); },
    );
  });

  test('passes when VAULT_APPROVAL_PASSWORD is set', async () => {
    await withEnvs(
      { VAULT_APPROVAL_PASSWORD: 'hunter2', VAULT_APPROVAL_OPEN: undefined, MCP_CLIENT_SECRET: undefined },
      () => { expect(() => assertApprovalGuardConfigured()).not.toThrow(); },
    );
  });

  test('passes when MCP_CLIENT_SECRET is set (it guards token exchange)', async () => {
    await withEnvs(
      { VAULT_APPROVAL_PASSWORD: undefined, VAULT_APPROVAL_OPEN: undefined, MCP_CLIENT_SECRET: 'shh' },
      () => { expect(() => assertApprovalGuardConfigured()).not.toThrow(); },
    );
  });

  test('passes when VAULT_APPROVAL_OPEN=true', async () => {
    await withEnvs(
      { VAULT_APPROVAL_PASSWORD: undefined, VAULT_APPROVAL_OPEN: 'true', MCP_CLIENT_SECRET: undefined },
      () => { expect(() => assertApprovalGuardConfigured()).not.toThrow(); },
    );
  });
});
