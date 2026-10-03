// ABOUTME: Pins which tools tools/list advertises in read-only mode — write-only tools are hidden,
// read tools and read-or-write tools stay — and that the optional clipper is probed once per
// process rather than once per request. Uses the static bearer so the OAuth flow stays out of scope.
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import type { Express } from 'express';

let createApp: () => { app: Express };
let vaultPath: string;

const BEARER = 'read-only-test-bearer';

const WRITE_ONLY_TOOLS = [
  'vault_create',
  'vault_update',
  'vault_set_frontmatter_property',
  'vault_batch_frontmatter_update',
  'vault_edit',
  'vault_edit_section',
  'vault_trash',
  'vault_move',
];

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

async function listToolNames(base: string): Promise<string[]> {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${BEARER}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  const text = await res.text();
  const line = text.split('\n').find(l => l.startsWith('data: '));
  const body = JSON.parse(line ? line.slice(6) : text) as { result?: { tools?: Array<{ name: string }> } };
  return (body.result?.tools ?? []).map(t => t.name);
}

beforeAll(async () => {
  vaultPath = await mkdtemp(path.join(os.tmpdir(), 'orm-read-only-test-'));
  await writeFile(path.join(vaultPath, 'Note.md'), 'Body.\n');
  process.env.VAULT_PATH = vaultPath;
  process.env.MCP_CLIENT_ID = 'read-only-client';
  process.env.MCP_BASE_URL = 'https://example.test';
  process.env.MCP_STATIC_BEARER_TOKEN = BEARER;
  process.env.APPROVAL_OPEN = 'true';
  process.env.VAULT_MCP_TEST = '1';
  createApp = (await import('../src/app.js')).createApp;
});

afterEach(() => {
  delete process.env.VAULT_READ_ONLY;
});

afterAll(async () => {
  delete process.env.MCP_STATIC_BEARER_TOKEN;
  await rm(vaultPath, { recursive: true, force: true });
});

describe('read-only mode', () => {
  test('hides write-only tools and keeps read and read-or-write tools', async () => {
    process.env.VAULT_READ_ONLY = 'true';
    const { app } = createApp();
    const { base, close } = await listen(app);
    try {
      const names = await listToolNames(base);
      for (const name of WRITE_ONLY_TOOLS) expect(names).not.toContain(name);
      for (const name of ['vault_read', 'vault_search_content', 'vault_periodic_note']) {
        expect(names).toContain(name);
      }
    } finally {
      await close();
    }
  });

  test('advertises write tools when the vault is writable', async () => {
    const { app } = createApp();
    const { base, close } = await listen(app);
    try {
      const names = await listToolNames(base);
      for (const name of WRITE_ONLY_TOOLS) expect(names).toContain(name);
    } finally {
      await close();
    }
  });
});

describe('optional clipper', () => {
  test('reports a missing clipper at most once across requests', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const { app } = createApp();
    const { base, close } = await listen(app);
    try {
      await listToolNames(base);
      await listToolNames(base);
      await listToolNames(base);
      const clipperWarnings = errorSpy.mock.calls.filter(args =>
        String(args[0]).includes('web-clipper-headless not available'),
      );
      expect(clipperWarnings.length).toBeLessThanOrEqual(1);
    } finally {
      errorSpy.mockRestore();
      await close();
    }
  });
});
