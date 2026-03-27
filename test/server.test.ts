import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import type { Express } from 'express';

let createApp: () => Express;
let seedTestToken: () => string;
let vault: typeof import('../src/vault.js');
let vaultPath: string;

function toCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

async function issueAuthCode(base: string, codeChallenge: string): Promise<string> {
  const approveRes = await fetch(`${base}/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      response_type: 'code',
      client_id: 'test-client',
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    }),
  });

  expect(approveRes.status).toBe(302);
  const location = approveRes.headers.get('location');
  expect(location).toBeTruthy();
  const code = new URL(location!).searchParams.get('code');
  expect(code).toBeTruthy();
  return code!;
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
        close: () =>
          new Promise<void>((res, rej) => {
            server.close(err => (err ? rej(err) : res()));
          }),
      });
    });
    server.on('error', reject);
  });
}

beforeAll(async () => {
  vaultPath = await mkdtemp(path.join(os.tmpdir(), 'obsidian-remote-mcp-test-'));
  process.env.VAULT_PATH = vaultPath;
  process.env.MCP_CLIENT_ID = 'test-client';
  process.env.MCP_CLIENT_SECRET = 'test-secret';
  process.env.MCP_BASE_URL = 'https://example.test';
  process.env.VAULT_MCP_TEST = '1';

  const appMod = await import('../src/app.js');
  const authMod = await import('../src/auth.js');
  vault = await import('../src/vault.js');
  createApp = appMod.createApp;
  seedTestToken = authMod.seedTestToken;
});

afterAll(async () => {
  delete process.env.VAULT_MCP_TEST;
  delete process.env.VAULT_CONTEXT_PATH;
  delete process.env.VAULT_DISPLAY_NAME;
  delete process.env.DAILY_NOTE_PATH_TEMPLATE;
  await rm(vaultPath, { recursive: true, force: true });
});

describe('OAuth discovery', () => {
  test('protected resource metadata includes resource and authorization_servers', async () => {
    const app = createApp();
    const { base, close } = await listen(app);
    try {
      const res = await fetch(`${base}/.well-known/oauth-protected-resource`);
      expect(res.ok).toBe(true);
      const body = (await res.json()) as { resource: string; authorization_servers: string[] };
      expect(body.resource).toBe('https://example.test');
      expect(body.authorization_servers).toEqual(['https://example.test']);
    } finally {
      await close();
    }
  });

  test('authorization server metadata exposes token and authorize endpoints', async () => {
    const app = createApp();
    const { base, close } = await listen(app);
    try {
      const res = await fetch(`${base}/.well-known/oauth-authorization-server`);
      expect(res.ok).toBe(true);
      const body = (await res.json()) as {
        issuer: string;
        authorization_endpoint: string;
        token_endpoint: string;
        token_endpoint_auth_methods_supported: string[];
      };
      expect(body.issuer).toBe('https://example.test');
      expect(body.authorization_endpoint).toBe('https://example.test/authorize');
      expect(body.token_endpoint).toBe('https://example.test/oauth/token');
      expect(body.token_endpoint_auth_methods_supported).toEqual(['client_secret_post']);
    } finally {
      await close();
    }
  });
});

describe('OAuth token endpoint', () => {
  test('requires client_secret when MCP_CLIENT_SECRET is set', async () => {
    const app = createApp();
    const { base, close } = await listen(app);
    try {
      const verifier = 'verifier-without-secret';
      const code = await issueAuthCode(base, toCodeChallenge(verifier));
      const res = await fetch(`${base}/oauth/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
          client_id: 'test-client',
          redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        }),
      });

      expect(res.status).toBe(401);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe('invalid_client');
    } finally {
      await close();
    }
  });

  test('accepts valid client_secret when provided', async () => {
    const app = createApp();
    const { base, close } = await listen(app);
    try {
      const verifier = 'verifier-with-secret';
      const code = await issueAuthCode(base, toCodeChallenge(verifier));
      const res = await fetch(`${base}/oauth/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
          client_id: 'test-client',
          client_secret: 'test-secret',
          redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        }),
      });

      expect(res.ok).toBe(true);
      const body = (await res.json()) as { access_token?: string };
      expect(body.access_token).toBeTruthy();
    } finally {
      await close();
    }
  });

  test('rejects invalid client_secret when provided', async () => {
    const app = createApp();
    const { base, close } = await listen(app);
    try {
      const verifier = 'verifier-bad-secret';
      const code = await issueAuthCode(base, toCodeChallenge(verifier));
      const res = await fetch(`${base}/oauth/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
          client_id: 'test-client',
          client_secret: 'wrong-secret',
          redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        }),
      });

      expect(res.status).toBe(401);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe('invalid_client');
    } finally {
      await close();
    }
  });

  test('allows PKCE-only exchange when MCP_CLIENT_SECRET is unset', async () => {
    const prev = process.env.MCP_CLIENT_SECRET;
    delete process.env.MCP_CLIENT_SECRET;
    const app = createApp();
    const { base, close } = await listen(app);
    try {
      const verifier = 'verifier-without-configured-secret';
      const code = await issueAuthCode(base, toCodeChallenge(verifier));
      const res = await fetch(`${base}/oauth/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
          client_id: 'test-client',
          redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        }),
      });

      expect(res.ok).toBe(true);
      const body = (await res.json()) as { access_token?: string; token_type?: string };
      expect(body.access_token).toBeTruthy();
      expect(body.token_type).toBe('bearer');
    } finally {
      if (prev === undefined) delete process.env.MCP_CLIENT_SECRET;
      else process.env.MCP_CLIENT_SECRET = prev;
      await close();
    }
  });
});

describe('Vault-derived defaults', () => {
  test('uses the vault directory name as the default display name', () => {
    delete process.env.VAULT_DISPLAY_NAME;
    expect(vault.getVaultDisplayName()).toBe(path.basename(vaultPath));
  });

  test('uses VAULT_DISPLAY_NAME when provided', () => {
    process.env.VAULT_DISPLAY_NAME = 'Work notes';
    expect(vault.getVaultDisplayName()).toBe('Work notes');
    delete process.env.VAULT_DISPLAY_NAME;
  });

  test('falls back from AGENTS.md to CLAUDE.md for vault context', async () => {
    const agentsPath = path.join(vaultPath, 'AGENTS.md');
    const claudePath = path.join(vaultPath, 'CLAUDE.md');

    await writeFile(claudePath, '# Context\n', 'utf-8');
    expect(vault.getContextNotePath()).toBe('CLAUDE.md');

    await writeFile(agentsPath, '# Context\n', 'utf-8');
    expect(vault.getContextNotePath()).toBe('AGENTS.md');
  });

  test('uses VAULT_CONTEXT_PATH when provided', () => {
    process.env.VAULT_CONTEXT_PATH = 'Guides/assistant.md';
    expect(vault.getContextNotePath()).toBe('Guides/assistant.md');
    delete process.env.VAULT_CONTEXT_PATH;
  });

  test('uses DAILY_NOTE_PATH_TEMPLATE tokens', () => {
    process.env.DAILY_NOTE_PATH_TEMPLATE = 'Daily/{YYYY}/{MM}/{DD}-{dddd}.md';
    expect(vault.getDailyNotePath(new Date('2026-03-26T12:00:00Z'))).toBe('Daily/2026/03/26-Thursday.md');
    delete process.env.DAILY_NOTE_PATH_TEMPLATE;
  });

  test('supports expanded daily note template tokens', () => {
    process.env.DAILY_NOTE_PATH_TEMPLATE = 'Journal/{YY}/{MMM}/{M}-{D}-{dd}.md';
    expect(vault.getDailyNotePath(new Date('2026-03-26T12:00:00Z'))).toBe('Journal/26/Mar/3-26-Th.md');
    delete process.env.DAILY_NOTE_PATH_TEMPLATE;
  });

  test('supports zero as no limit for title search', async () => {
    await writeFile(path.join(vaultPath, 'alpha.md'), '# alpha\n', 'utf-8');
    await writeFile(path.join(vaultPath, 'beta alpha.md'), '# beta alpha\n', 'utf-8');
    await writeFile(path.join(vaultPath, 'gamma alpha.md'), '# gamma alpha\n', 'utf-8');

    const results = await vault.findByTitle('alpha', false, 0);
    expect(results.length).toBeGreaterThanOrEqual(3);
  });

  test('reads and writes frontmatter properties', async () => {
    const notePath = path.join(vaultPath, 'frontmatter.md');
    await writeFile(notePath, '---\ntags:\n  - mcp\nstatus: draft\n---\n# Hello\n', 'utf-8');

    expect(await vault.getFrontmatterProperty('frontmatter.md', 'status')).toBe('draft');
    await vault.setFrontmatterProperty('frontmatter.md', 'status', 'published');
    await vault.setFrontmatterProperty('frontmatter.md', 'count', 3);

    const frontmatter = await vault.getFrontmatter('frontmatter.md');
    expect(frontmatter?.status).toBe('published');
    expect(frontmatter?.count).toBe(3);
  });

  test('parses common Obsidian frontmatter value types', async () => {
    const notePath = path.join(vaultPath, 'frontmatter-types.md');
    await writeFile(
      notePath,
      [
        '---',
        'title: A New Hope',
        'link: "[[Episode IV]]"',
        'url: https://www.example.com',
        'cast:',
        '  - Mark Hamill',
        '  - Harrison Ford',
        '  - Carrie Fisher',
        'links:',
        '  - "[[Link]]"',
        '  - "[[Link2]]"',
        'year: 1977',
        'pie: 3.14',
        'favorite: true',
        'reply: false',
        'last:',
        'date: 2020-08-21',
        'time: 2020-08-21T10:30:00',
        'tags:',
        '  - journal',
        '  - personal',
        '  - draft',
        '---',
        '# Frontmatter types',
        '',
      ].join('\n'),
      'utf-8',
    );

    const frontmatter = await vault.getFrontmatter('frontmatter-types.md');

    expect(frontmatter?.title).toBe('A New Hope');
    expect(frontmatter?.link).toBe('[[Episode IV]]');
    expect(frontmatter?.url).toBe('https://www.example.com');
    expect(frontmatter?.cast).toEqual(['Mark Hamill', 'Harrison Ford', 'Carrie Fisher']);
    expect(frontmatter?.links).toEqual(['[[Link]]', '[[Link2]]']);
    expect(frontmatter?.year).toBe(1977);
    expect(frontmatter?.pie).toBe(3.14);
    expect(frontmatter?.favorite).toBe(true);
    expect(frontmatter?.reply).toBe(false);
    expect(frontmatter?.last).toBe(null);
    expect(frontmatter?.tags).toEqual(['journal', 'personal', 'draft']);
    expect(frontmatter?.date).toBeInstanceOf(Date);
    expect(frontmatter?.time).toBeInstanceOf(Date);
    expect((frontmatter?.date as Date).toISOString()).toBe('2020-08-21T00:00:00.000Z');
    expect((frontmatter?.time as Date).toISOString()).toBe('2020-08-21T10:30:00.000Z');
  });

  test('parses JSON-style frontmatter blocks', async () => {
    const notePath = path.join(vaultPath, 'frontmatter-json.md');
    await writeFile(
      notePath,
      [
        '---',
        '{',
        '  "tags": ["journal"],',
        '  "publish": false',
        '}',
        '---',
        '# JSON frontmatter',
        '',
      ].join('\n'),
      'utf-8',
    );

    const frontmatter = await vault.getFrontmatter('frontmatter-json.md');
    expect(frontmatter).toEqual({
      tags: ['journal'],
      publish: false,
    });
  });

  test('parses inline array frontmatter syntax', async () => {
    const notePath = path.join(vaultPath, 'frontmatter-inline-arrays.md');
    await writeFile(
      notePath,
      [
        '---',
        'tags: [journal, personal, draft]',
        'links: ["[[Link One]]", "[[Link Two]]"]',
        '---',
        '# Inline arrays',
        '',
      ].join('\n'),
      'utf-8',
    );

    const frontmatter = await vault.getFrontmatter('frontmatter-inline-arrays.md');
    expect(frontmatter).toEqual({
      tags: ['journal', 'personal', 'draft'],
      links: ['[[Link One]]', '[[Link Two]]'],
    });
  });
});

describe('CORS', () => {
  test('allows all origins by default', async () => {
    delete process.env.CORS_ALLOWED_ORIGINS;
    const app = createApp();
    const { base, close } = await listen(app);
    try {
      const res = await fetch(`${base}/.well-known/oauth-protected-resource`, {
        headers: { Origin: 'https://claude.ai' },
      });
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
    } finally {
      await close();
    }
  });

  test('reflects configured allowed origins', async () => {
    process.env.CORS_ALLOWED_ORIGINS = 'https://claude.ai,https://app.example.com';
    const app = createApp();
    const { base, close } = await listen(app);
    try {
      const res = await fetch(`${base}/.well-known/oauth-protected-resource`, {
        headers: { Origin: 'https://claude.ai' },
      });
      expect(res.headers.get('access-control-allow-origin')).toBe('https://claude.ai');
    } finally {
      delete process.env.CORS_ALLOWED_ORIGINS;
      await close();
    }
  });

  test('rejects disallowed preflight origins', async () => {
    process.env.CORS_ALLOWED_ORIGINS = 'https://claude.ai';
    const app = createApp();
    const { base, close } = await listen(app);
    try {
      const res = await fetch(`${base}/mcp`, {
        method: 'OPTIONS',
        headers: { Origin: 'https://evil.example' },
      });
      expect(res.status).toBe(403);
    } finally {
      delete process.env.CORS_ALLOWED_ORIGINS;
      await close();
    }
  });
});

describe('MCP /mcp', () => {
  test('GET without Authorization returns 401', async () => {
    const app = createApp();
    const { base, close } = await listen(app);
    try {
      const res = await fetch(`${base}/mcp`, {
        headers: { Accept: 'text/event-stream' },
      });
      expect(res.status).toBe(401);
    } finally {
      await close();
    }
  });

  test('GET with invalid Bearer returns 401', async () => {
    const app = createApp();
    const { base, close } = await listen(app);
    try {
      const res = await fetch(`${base}/mcp`, {
        headers: {
          Accept: 'text/event-stream',
          Authorization: 'Bearer not-a-real-token',
        },
      });
      expect(res.status).toBe(401);
    } finally {
      await close();
    }
  });

  test('GET with valid token returns 405 (no standalone SSE)', async () => {
    const app = createApp();
    const { base, close } = await listen(app);
    try {
      const token = seedTestToken();
      const res = await fetch(`${base}/mcp`, {
        headers: {
          Accept: 'text/event-stream',
          Authorization: `Bearer ${token}`,
        },
      });
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')?.toUpperCase()).toContain('POST');
    } finally {
      await close();
    }
  });

  test('GET /mcp accepts MCP_STATIC_BEARER_TOKEN when set', async () => {
    const prev = process.env.MCP_STATIC_BEARER_TOKEN;
    process.env.MCP_STATIC_BEARER_TOKEN = 'static-bearer-test-secret';
    try {
      const app = createApp();
      const { base, close } = await listen(app);
      try {
        const res = await fetch(`${base}/mcp`, {
          headers: {
            Accept: 'text/event-stream',
            Authorization: 'Bearer static-bearer-test-secret',
          },
        });
        expect(res.status).toBe(405);
      } finally {
        await close();
      }
    } finally {
      if (prev === undefined) delete process.env.MCP_STATIC_BEARER_TOKEN;
      else process.env.MCP_STATIC_BEARER_TOKEN = prev;
    }
  });

  test('POST without Authorization returns 401', async () => {
    const app = createApp();
    const { base, close } = await listen(app);
    try {
      const res = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'test', version: '1.0.0' },
          },
        }),
      });
      expect(res.status).toBe(401);
    } finally {
      await close();
    }
  });

  test('POST initialize with valid token returns JSON-RPC result', async () => {
    const app = createApp();
    const { base, close } = await listen(app);
    try {
      const token = seedTestToken();
      const res = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'test', version: '1.0.0' },
          },
        }),
      });
      expect(res.ok).toBe(true);
      const ct = res.headers.get('content-type') ?? '';
      expect(ct.includes('application/json')).toBe(true);
      const body = (await res.json()) as {
        jsonrpc: string;
        id: number;
        result?: { protocolVersion: string; serverInfo: { name: string } };
      };
      expect(body.jsonrpc).toBe('2.0');
      expect(body.id).toBe(1);
      expect(body.result?.serverInfo?.name).toBe('obsidian-remote-mcp');
    } finally {
      await close();
    }
  });
});
