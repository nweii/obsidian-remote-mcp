// ABOUTME: Pins the OAuth discovery documents beyond issuer/endpoint identity — the advertised
// response types, grant types, PKCE methods, and how token_endpoint_auth_methods_supported flips
// between the client-secret and PKCE-only configurations.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import type { Express } from 'express';

let createApp: () => Express;
let vaultPath: string;

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

// Apply env vars (clearing those set to undefined) for the duration of fn, then restore.
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
  vaultPath = await mkdtemp(path.join(os.tmpdir(), 'orm-discovery-test-'));
  process.env.VAULT_PATH = vaultPath;
  process.env.MCP_CLIENT_ID = 'discovery-client';
  process.env.MCP_BASE_URL = 'https://example.test';
  process.env.VAULT_MCP_TEST = '1';
  createApp = (await import('../src/app.js')).createApp;
});

afterAll(async () => {
  await rm(vaultPath, { recursive: true, force: true });
});

describe('authorization server metadata', () => {
  test('advertises the code grant, S256 PKCE, and no other flows', async () => {
    const app = createApp();
    const { base, close } = await listen(app);
    try {
      const body = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as {
        response_types_supported: string[];
        grant_types_supported: string[];
        code_challenge_methods_supported: string[];
      };
      expect(body.response_types_supported).toEqual(['code']);
      expect(body.grant_types_supported).toEqual(['authorization_code']);
      expect(body.code_challenge_methods_supported).toEqual(['S256']);
    } finally {
      await close();
    }
  });

  test('offers only client_secret_post when a client secret is configured', async () => {
    await withEnvs({ MCP_CLIENT_SECRET: 'a-secret' }, async () => {
      const app = createApp();
      const { base, close } = await listen(app);
      try {
        const body = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as {
          token_endpoint_auth_methods_supported: string[];
        };
        expect(body.token_endpoint_auth_methods_supported).toEqual(['client_secret_post']);
      } finally {
        await close();
      }
    });
  });

  test('also offers "none" when no client secret is configured (PKCE-only clients)', async () => {
    await withEnvs({ MCP_CLIENT_SECRET: undefined }, async () => {
      const app = createApp();
      const { base, close } = await listen(app);
      try {
        const body = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as {
          token_endpoint_auth_methods_supported: string[];
        };
        expect(body.token_endpoint_auth_methods_supported).toEqual(['client_secret_post', 'none']);
      } finally {
        await close();
      }
    });
  });
});
