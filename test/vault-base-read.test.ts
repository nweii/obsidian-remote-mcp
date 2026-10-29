// ABOUTME: Tests that vault_read returns an Obsidian Base (.base) as text when given its path, under
// the note access policy, and that note-only tools (title resolution, frontmatter) leave Bases alone.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import type { Express } from 'express';

let vault: typeof import('../src/vault.js');
let createApp: () => { app: Express };
let vaultPath: string;

const BEARER = 'base-read-test-bearer';
// A Base is YAML with no `---` fences; a frontmatter parser must never be pointed at it.
const BASE = 'filters:\n  and:\n    - file.inFolder("Reading")\nviews:\n  - type: table\n    name: Shelf\n    order:\n      - file.name\n      - status\n';

async function write(rel: string, content: string): Promise<void> {
  const abs = path.join(vaultPath, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf-8');
}

beforeAll(async () => {
  vaultPath = await mkdtemp(path.join(os.tmpdir(), 'orm-base-read-test-'));
  await write('Views/Shelf.base', BASE);
  await write('Private/Hidden.base', BASE);
  await write('.obsidian/Dot.base', BASE);
  await write('.mcpignore', 'Private\n');

  process.env.VAULT_PATH = vaultPath;
  process.env.MCP_CLIENT_ID = 'base-read-client';
  process.env.MCP_BASE_URL = 'https://example.test';
  process.env.MCP_STATIC_BEARER_TOKEN = BEARER;
  process.env.APPROVAL_OPEN = 'true';
  process.env.VAULT_MCP_TEST = '1';
  vault = await import(`../src/vault.js?base-read-test=${Date.now()}`);
  createApp = (await import('../src/app.js')).createApp;
});

afterAll(async () => {
  delete process.env.MCP_STATIC_BEARER_TOKEN;
  await rm(vaultPath, { recursive: true, force: true });
});

async function callTool(name: string, args: Record<string, unknown>) {
  const { app } = createApp();
  const server = await new Promise<import('http').Server>(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const addr = server.address() as import('net').AddressInfo;
    const res = await fetch(`http://127.0.0.1:${addr.port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${BEARER}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    const text = await res.text();
    const line = text.split('\n').find(l => l.startsWith('data: '));
    return JSON.parse(line ? line.slice(6) : text).result;
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

describe('reading .base files', () => {
  test('vault_read returns an allowed Base as text, with no version line', async () => {
    const result = await callTool('vault_read', { path: 'Views/Shelf.base' });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: 'text', text: BASE }]);
  });

  test('vault_read refuses a Base blocked by .mcpignore or in an internal folder', async () => {
    for (const hidden of ['Private/Hidden.base', '.obsidian/Dot.base']) {
      const result = await callTool('vault_read', { path: hidden });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).not.toContain('file.inFolder');
    }
    await expect(vault.readBase('Private/Hidden.base')).rejects.toBeInstanceOf(vault.VaultPolicyError);
  });

  test('a missing Base is reported by its vault path', async () => {
    const result = await callTool('vault_read', { path: 'Views/Missing.base' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Views/Missing.base');
    expect(result.content[0].text).not.toContain(vaultPath);
  });

  test('note-only resolution and frontmatter tools do not treat a Base as a note', async () => {
    await expect(vault.resolveNoteReference('Shelf')).rejects.toBeInstanceOf(vault.NotFoundError);
    await expect(vault.resolveNoteReference('Views/Shelf.base')).rejects.toBeInstanceOf(vault.NotFoundError);
    const fm = await callTool('vault_frontmatter', { path: 'Views/Shelf.base' });
    expect(fm.isError).toBe(true);
    const search = await callTool('vault_search_frontmatter', { field: 'views', matchType: 'exists' });
    expect(JSON.stringify(search)).not.toContain('Shelf');
  });
});
