// ABOUTME: Verifies exact browser Origin validation before MCP execution, safe origin
// configuration, and compatibility with clients that omit Origin and OAuth discovery.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import type { Express } from 'express';

let createApp: typeof import('../src/app.js').createApp;
let vaultPath: string;
const bearer = 'origin-guard-test-token';
const envKeys = ['VAULT_PATH', 'MCP_CLIENT_ID', 'MCP_CLIENT_SECRET', 'MCP_BASE_URL',
  'APPROVAL_PASSWORD', 'APPROVAL_OPEN', 'MCP_STATIC_BEARER_TOKEN', 'VAULT_MCP_TEST',
  'CORS_ALLOWED_ORIGINS', 'PORT', 'VAULT_READ_ONLY', 'MCP_DCR_ENABLED', 'MCP_DCR_ALLOWED_REDIRECT_URIS'];
let savedEnv: Map<string, string | undefined>;

beforeAll(async () => {
  savedEnv = new Map(envKeys.map(key => [key, process.env[key]]));
  vaultPath = await mkdtemp('/tmp/origin-guard-');
  Object.assign(process.env, {
    VAULT_PATH: vaultPath,
    MCP_CLIENT_ID: 'origin-guard-client',
    APPROVAL_PASSWORD: 'origin-test-password',
    MCP_STATIC_BEARER_TOKEN: bearer,
    VAULT_MCP_TEST: '1',
  });
  delete process.env.MCP_CLIENT_SECRET;
  delete process.env.APPROVAL_OPEN;
  delete process.env.VAULT_READ_ONLY;
  createApp = (await import('../src/app.js')).createApp;
});

beforeEach(() => {
  process.env.MCP_BASE_URL = 'https://vault.example';
  delete process.env.CORS_ALLOWED_ORIGINS;
  delete process.env.PORT;
  delete process.env.MCP_DCR_ENABLED;
  delete process.env.MCP_DCR_ALLOWED_REDIRECT_URIS;
});

afterAll(async () => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(vaultPath, { recursive: true, force: true });
});

async function withServer(run: (base: string, app: Express) => Promise<void>) {
  const { app } = createApp();
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing listen address');
  try {
    await run(`http://127.0.0.1:${address.port}`, app);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

function request(base: string, method: string, origin?: string, extraHeaders = {}) {
  return fetch(`${base}/mcp`, {
    method,
    headers: {
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${bearer}`,
      'Content-Type': 'application/json',
      ...(origin === undefined ? {} : { Origin: origin }),
      ...extraHeaders,
    },
    ...(method === 'POST' ? { body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) } : {}),
  });
}

describe('MCP Origin guard', () => {
  test('allows the configured server origin and requests without Origin', async () => {
    await withServer(async base => {
      for (const origin of ['https://vault.example', undefined]) {
        const response = await request(base, 'POST', origin);
        expect(response.status).toBe(200);
        expect(await response.text()).toContain('vault_read');
      }
      const preflight = await request(base, 'OPTIONS', 'https://vault.example');
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe('https://vault.example');
    });
  });

  for (const setting of [undefined, '', '   ']) {
    test(`default origins with setting ${JSON.stringify(setting)} allow only the configured site and reject others`, async () => {
      if (setting === undefined) delete process.env.CORS_ALLOWED_ORIGINS;
      else process.env.CORS_ALLOWED_ORIGINS = setting;
      await withServer(async base => {
        for (const origin of ['https://vault.example']) {
          const response = await request(base, 'POST', origin);
          expect(response.status).toBe(200);
          expect(response.headers.get('access-control-allow-origin')).toBe(origin);
          expect(await response.text()).toContain('vault_read');
          const preflight = await request(base, 'OPTIONS', origin);
          expect(preflight.status).toBe(204);
          expect(preflight.headers.get('access-control-allow-origin')).toBe(origin);
          const denied = await request(base, 'POST', origin, { Authorization: 'Bearer invalid' });
          expect(denied.status).toBe(401);
          await denied.text();
        }
        for (const origin of ['https://other.example', 'https://claude.ai', 'https://chatgpt.com', 'null', '', 'https://claude.ai.evil.example',
          'https://sub.chatgpt.com', 'http://claude.ai', 'https://chatgpt.com:8443']) {
          const denied = await request(base, 'POST', origin);
          expect(denied.status).toBe(403);
          await denied.text();
        }
      });
    });
  }

  test('explicit wildcard permits any origin but still requires authentication', async () => {
    process.env.CORS_ALLOWED_ORIGINS = ' * ';
    await withServer(async base => {
      for (const origin of ['https://other.example', 'http://localhost:9999', 'null', undefined]) {
        const response = await request(base, 'POST', origin);
        expect(response.status).toBe(200);
        expect(response.headers.get('access-control-allow-origin')).toBe('*');
        expect(await response.text()).toContain('vault_read');
      }
      const preflight = await request(base, 'OPTIONS', 'https://other.example', {
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type',
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
      const denied = await request(base, 'POST', 'https://other.example', { Authorization: 'Bearer invalid' });
      expect(denied.status).toBe(401);
      await denied.text();
    });
  });

  test('rejects disallowed, malformed, opaque, and empty Origins on every MCP method', async () => {
    await withServer(async base => {
      for (const origin of ['https://evil.example', 'null', '', '*', 'not-an-origin',
        'https://user@vault.example', 'https://vault.example/path', 'https://vault.example.evil']) {
        for (const method of ['GET', 'POST', 'DELETE', 'OPTIONS']) {
          const response = await request(base, method, origin);
          expect(response.status).toBe(403);
          expect(response.headers.get('access-control-allow-origin')).toBeNull();
          await response.text();
        }
      }
    });
  });

  test('rejects an authenticated write before any note is created', async () => {
    await withServer(async base => {
      const response = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { Origin: 'https://evil.example', Authorization: `Bearer ${bearer}`,
          'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: { name: 'vault_create', arguments: { path: 'Blocked.md', content: 'blocked' } } }),
      });
      expect(response.status).toBe(403);
      expect(existsSync(`${vaultPath}/Blocked.md`)).toBe(false);
      await response.text();
    });
  });

  test('Host and forwarded headers cannot grant an origin access', async () => {
    await withServer(async (base, app) => {
      expect(app.get('trust proxy')).toBe('loopback');
      const response = await request(base, 'POST', 'https://evil.example', {
        Host: 'evil.example', 'X-Forwarded-Host': 'evil.example', 'X-Forwarded-Proto': 'https',
      });
      expect(response.status).toBe(403);
      await response.text();
    });
  });

  test('explicit allowlist replaces the default and uses exact origins', async () => {
    process.env.CORS_ALLOWED_ORIGINS = 'https://claude.ai, https://app.example:8443';
    await withServer(async base => {
      for (const origin of ['https://claude.ai', 'https://app.example:8443']) {
        const response = await request(base, 'GET', origin);
        expect(response.status).toBe(405);
        expect(response.headers.get('access-control-allow-origin')).toBe(origin);
        await response.text();
      }
      for (const origin of ['https://vault.example', 'https://chatgpt.com', 'https://sub.claude.ai', 'http://claude.ai', 'https://app.example']) {
        const response = await request(base, 'GET', origin);
        expect(response.status).toBe(403);
        await response.text();
      }
    });
  });

  test('local default includes the configured port without trusting the bind address', async () => {
    delete process.env.MCP_BASE_URL;
    process.env.PORT = '4567';
    await withServer(async base => {
      const allowed = await request(base, 'GET', 'http://localhost:4567');
      expect(allowed.status).toBe(405);
      await allowed.text();
      const denied = await request(base, 'GET', 'http://localhost:3456');
      expect(denied.status).toBe(403);
      await denied.text();
    });
  });

  test('OAuth discovery remains accessible to browser clients from other origins', async () => {
    await withServer(async base => {
      for (const endpoint of ['oauth-authorization-server', 'oauth-protected-resource']) {
        const response = await fetch(`${base}/.well-known/${endpoint}`, { headers: { Origin: 'https://claude.ai' } });
        expect(response.status).toBe(200);
        expect(response.headers.get('access-control-allow-origin')).toBe('*');
        await response.text();
      }
    });
  });

  test('OAuth and DCR browser preflights remain open independently of the MCP allowlist', async () => {
    process.env.MCP_DCR_ENABLED = 'true';
    for (const allowlist of [undefined, 'https://app.example']) {
      if (allowlist === undefined) delete process.env.CORS_ALLOWED_ORIGINS;
      else process.env.CORS_ALLOWED_ORIGINS = allowlist;
      await withServer(async base => {
        for (const [endpoint, method] of [
          ['/register', 'POST'], ['/token', 'POST'],
          ['/.well-known/oauth-authorization-server', 'GET'],
          ['/.well-known/oauth-protected-resource', 'GET'],
        ]) {
          const response = await fetch(`${base}${endpoint}`, {
            method: 'OPTIONS',
            headers: { Origin: 'https://claude.ai', 'Access-Control-Request-Method': method,
              'Access-Control-Request-Headers': 'content-type' },
          });
          expect(response.status).toBe(204);
          expect(response.headers.get('access-control-allow-origin')).toBe('*');
          expect(response.headers.get('access-control-allow-methods')).toContain(method);
          expect(response.headers.get('access-control-allow-headers')).toContain('content-type');
          await response.text();
        }
        const mcp = await request(base, 'OPTIONS', 'https://claude.ai');
        expect(mcp.status).toBe(403);
        await mcp.text();
      });
    }
  });

  test('cross-origin OAuth and DCR requests reach the SDK body parsers and handlers', async () => {
    process.env.MCP_DCR_ENABLED = 'true';
    await withServer(async base => {
      const registration = await fetch(`${base}/register`, {
        method: 'POST',
        headers: { Origin: 'https://claude.ai', 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_name: 'Browser test',
          redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], token_endpoint_auth_method: 'none' }),
      });
      expect(registration.status).toBe(201);
      expect(registration.headers.get('access-control-allow-origin')).toBe('*');
      expect((await registration.json()).client_id).toBeString();

      const token = await fetch(`${base}/token`, {
        method: 'POST',
        headers: { Origin: 'https://claude.ai', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', client_id: 'origin-guard-client',
          code: 'invalid-code', code_verifier: 'v'.repeat(43), redirect_uri: 'https://claude.ai/api/mcp/auth_callback' }),
      });
      expect(token.status).toBe(400);
      expect(token.headers.get('access-control-allow-origin')).toBe('*');
      expect((await token.json()).error).toBe('invalid_grant');
    });
  });
});

describe('origin configuration', () => {
  test('rejects unsafe or malformed allowlist entries at startup', () => {
    for (const value of ['https://claude.ai,*', 'null', 'not-a-url', 'ftp://example.test',
      'https://user:password@example.test', 'https://@example.test', 'https://example.test/path',
      'https://example.test/', 'https://example.test?query', 'https://example.test#fragment',
      'https://*.example.test', 'https://%2a.example.test', 'https://claude.ai,', ',', 'https:\\example.test']) {
      process.env.CORS_ALLOWED_ORIGINS = value;
      expect(createApp).toThrow(/CORS_ALLOWED_ORIGINS must contain explicit HTTP\(S\) origins/);
    }
  });

  test('rejects an unsafe default base URL even with an explicit allowlist', () => {
    process.env.CORS_ALLOWED_ORIGINS = 'https://claude.ai';
    for (const value of ['null', 'https://user:password@example.test', 'https://example.test/path',
      'https://example.test?query', 'https://*.example.test', 'https://%2a.example.test']) {
      process.env.MCP_BASE_URL = value;
      expect(createApp).toThrow(/MCP_BASE_URL must contain explicit HTTP\(S\) origins/);
    }
  });

  test('normalizes host casing and default ports; accepts a base URL trailing slash', async () => {
    process.env.MCP_BASE_URL = 'https://VAULT.EXAMPLE:443/';
    await withServer(async base => {
      const response = await request(base, 'GET', 'https://vault.example');
      expect(response.status).toBe(405);
      await response.text();
    });
  });
});
