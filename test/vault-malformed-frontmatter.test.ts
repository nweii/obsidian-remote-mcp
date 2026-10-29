// ABOUTME: Tests that vault-wide frontmatter scans (frontmatter search, tags, skim selection) skip a
// note whose frontmatter isn't valid YAML, report it by path and reason, and never report a hidden one.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import type { Express } from 'express';

let vault: typeof import('../src/vault.js');
let createApp: () => { app: Express };
let vaultPath: string;

const BEARER = 'malformed-frontmatter-test-bearer';
// An unclosed flow sequence: js-yaml rejects it with a line number.
const BROKEN = '---\nstatus: active\ntags: [one, two\n---\n#inline body\n';

async function write(rel: string, content: string): Promise<void> {
  const abs = path.join(vaultPath, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf-8');
}

beforeAll(async () => {
  vaultPath = await mkdtemp(path.join(os.tmpdir(), 'orm-malformed-fm-test-'));
  await write('Notes/Good.md', '---\nstatus: active\ntags: [one]\n---\nbody\n');
  await write('Notes/Broken.md', BROKEN);
  await write('Clean/Plain.md', '---\nstatus: active\n---\nbody\n');
  await write('Private/Hidden.md', BROKEN);
  await write('.hidden/Dot.md', BROKEN);
  await write('.mcpignore', 'Private\n');

  process.env.VAULT_PATH = vaultPath;
  process.env.MCP_CLIENT_ID = 'malformed-fm-client';
  process.env.MCP_BASE_URL = 'https://example.test';
  process.env.MCP_STATIC_BEARER_TOKEN = BEARER;
  process.env.APPROVAL_OPEN = 'true';
  process.env.VAULT_MCP_TEST = '1';
  vault = await import(`../src/vault.js?malformed-fm-test=${Date.now()}`);
  createApp = (await import('../src/app.js')).createApp;
});

afterAll(async () => {
  delete process.env.MCP_STATIC_BEARER_TOKEN;
  await rm(vaultPath, { recursive: true, force: true });
});

describe('vault-wide scans skip malformed frontmatter', () => {
  test('frontmatter search returns the other matches and lists the skipped note', async () => {
    const { items, skipped } = await vault.searchFrontmatter('status', { value: 'active', folder: 'Notes' });
    expect(items.map(r => r.path)).toEqual(['Notes/Good.md']);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].path).toBe('Notes/Broken.md');
    expect(skipped[0].reason).toBeString();
    expect(skipped[0].line).toBeNumber();
  });

  test('hidden and ignored notes appear in neither results nor warnings', async () => {
    const { skipped } = await vault.searchFrontmatter('status', { matchType: 'exists' });
    const reported = JSON.stringify(skipped);
    expect(reported).not.toContain('Hidden');
    expect(reported).not.toContain('Dot');
  });

  test('tag listing and tag lookup skip the note instead of failing', async () => {
    const all = await vault.getAllTags();
    expect(all.tags.map(t => t.tag)).toEqual(['one']);
    expect(all.skipped.map(s => s.path)).toEqual(['Notes/Broken.md']);

    const byTag = await vault.getNotesByTag('one');
    expect(byTag.paths).toEqual(['Notes/Good.md']);
    expect(byTag.skipped.map(s => s.path)).toEqual(['Notes/Broken.md']);
  });

  test('batch read reports the parse error for that note only', async () => {
    const { found, missing } = await vault.readNotesBatch(['Notes/Good.md', 'Notes/Broken.md'], false);
    expect(found.map(f => f.path)).toEqual(['Notes/Good.md']);
    expect(missing.map(m => m.reference)).toEqual(['Notes/Broken.md']);
  });
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

describe('tools report skipped notes in text and structured output', () => {
  test('vault_search_frontmatter', async () => {
    const result = await callTool('vault_search_frontmatter', { field: 'status', value: 'active', folder: 'Notes' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.items).toEqual([{ path: 'Notes/Good.md', value: 'active' }]);
    expect(result.structuredContent.skipped.map((s: { path: string }) => s.path)).toEqual(['Notes/Broken.md']);
    const text: string = result.content[0].text;
    expect(text).toContain('Notes/Good.md');
    expect(text).toContain('Skipped 1 note with invalid frontmatter');
    expect(text).toContain('Notes/Broken.md (line');
    // The note's own text never leaks into the warning.
    expect(text).not.toContain('[one, two');
  });

  test('vault_tags', async () => {
    const result = await callTool('vault_tags', {});
    expect(result.structuredContent.tags).toEqual([{ tag: 'one', noteCount: 1 }]);
    expect(result.structuredContent.skipped.map((s: { path: string }) => s.path)).toEqual(['Notes/Broken.md']);
    expect(result.content[0].text).toContain('Skipped 1 note with invalid frontmatter');
  });

  test('a clean scan carries no skipped field', async () => {
    const result = await callTool('vault_search_frontmatter', { field: 'status', value: 'active', folder: 'Clean' });
    expect(result.structuredContent.items).toEqual([{ path: 'Clean/Plain.md', value: 'active' }]);
    expect(result.structuredContent.skipped).toBeUndefined();
  });
});
