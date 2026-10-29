// ABOUTME: Tests for vault_search_semantic — reading QMD's result paths, the request sent to QMD, mapping
// results back to vault paths, withholding results the access policy hides, and registration over MCP.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import { createHash } from 'crypto';
import path from 'path';
import { McpServer } from '@modelcontextprotocol/server';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { loadQmdConfig, pathInCollection, plainQuerySearches, registerQmdTool, semanticSearch, type Fetcher, type QmdConfig } from '../src/qmd.js';

const config: QmdConfig = { url: 'http://127.0.0.1:8181', collection: 'notes', timeoutMs: 5000 };

const docid = (content: string) => `#${createHash('sha256').update(content).digest('hex').slice(0, 6)}`;

// Each hit is a QMD path plus the content QMD indexed for it, which sets the docid. QMD's title and
// snippet carry the indexed content, so a test can check that none of it is passed on.
function fakeQmd(hits: [file: string, content: string, docidOverride?: string][], calls: { url: string; body: any }[] = []): Fetcher {
  return async (url, init) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    const results = hits.map(([file, content, override], i) => ({ docid: override ?? docid(content), file, title: content, score: 0.9 - i / 10, line: 3, snippet: `3: ${content}` }));
    return new Response(JSON.stringify({ results }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}

describe('pathInCollection', () => {
  test('reads both the collection/path form and the encoded qmd:// URI form', () => {
    expect(pathInCollection('notes/Projects/Plan.md', 'notes')).toBe('Projects/Plan.md');
    expect(pathInCollection('qmd://notes/Projects/Caf%C3%A9%20(draft).md', 'notes')).toBe('Projects/Café (draft).md');
    expect(pathInCollection('qmd://other/Projects/Plan.md', 'notes')).toBeNull();
    expect(pathInCollection('notesy/Plan.md', 'notes')).toBeNull();
    expect(pathInCollection('qmd://notes/%E0%A4%A.md', 'notes')).toBeNull();
    expect(pathInCollection(undefined, 'notes')).toBeNull();
  });
});

describe('plainQuerySearches', () => {
  test('keeps balanced quotes in the keyword half', () => {
    expect(plainQuerySearches('"power cut" recovery')).toEqual([
      { type: 'lex', query: '"power cut" recovery' },
      { type: 'vec', query: '"power cut" recovery' },
    ]);
  });

  test('drops an unbalanced quote from the keyword half only', () => {
    expect(plainQuerySearches('"unclosed quote')).toEqual([
      { type: 'lex', query: 'unclosed quote' },
      { type: 'vec', query: '"unclosed quote' },
    ]);
    expect(plainQuerySearches('say "this" and "that')[0]).toEqual({ type: 'lex', query: 'say this and that' });
  });
});

describe('loadQmdConfig', () => {
  test('is off without QMD_URL, and off without QMD_COLLECTION', () => {
    expect(loadQmdConfig({})).toBeNull();
    expect(loadQmdConfig({ QMD_URL: 'http://127.0.0.1:8181' })).toBeNull();
  });

  test('trims the trailing slash and defaults the timeout', () => {
    expect(loadQmdConfig({ QMD_URL: 'http://127.0.0.1:8181/', QMD_COLLECTION: 'notes' }))
      .toEqual({ url: 'http://127.0.0.1:8181', collection: 'notes', timeoutMs: 60000 });
  });
});

const PLAN = '# Plan\n\nplant tomatoes\n';

describe('semanticSearch', () => {
  let vaultPath: string;

  beforeAll(async () => {
    vaultPath = await mkdtemp(path.join(os.tmpdir(), 'vault-qmd-'));
    await mkdir(path.join(vaultPath, 'Projects'), { recursive: true });
    await mkdir(path.join(vaultPath, 'Private'), { recursive: true });
    await mkdir(path.join(vaultPath, '.hidden'), { recursive: true });
    await writeFile(path.join(vaultPath, 'Projects', 'Garden plan.md'), PLAN);
    await writeFile(path.join(vaultPath, 'Projects', 'Secret-draft.md'), 'public draft\n');
    await writeFile(path.join(vaultPath, 'Projects', 'Secret (draft).md'), 'private draft\n');
    await writeFile(path.join(vaultPath, 'Private', 'Diary.md'), 'secret\n');
    await writeFile(path.join(vaultPath, '.hidden', 'Note.md'), 'hidden\n');
    await writeFile(path.join(vaultPath, '.mcpignore'), 'Private/\nProjects/Secret (draft).md\n');
    process.env.VAULT_PATH = vaultPath;
  });

  afterAll(async () => {
    await rm(vaultPath, { recursive: true, force: true });
  });

  test('searches only the configured collection and forwards the query', async () => {
    process.env.VAULT_PATH = vaultPath;
    const calls: { url: string; body: any }[] = [];
    await semanticSearch(config, { searches: [{ type: 'vec', query: 'planting tomatoes' }], limit: 5, intent: 'vegetable garden' }, fakeQmd([], calls));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://127.0.0.1:8181/query');
    expect(calls[0]!.body).toEqual({
      searches: [{ type: 'vec', query: 'planting tomatoes' }],
      collections: ['notes'],
      limit: 5,
      intent: 'vegetable garden',
    });
  });

  test('maps results to vault paths and drops ignored, hidden, foreign, and unknown documents', async () => {
    process.env.VAULT_PATH = vaultPath;
    const hits: [string, string][] = [
      ['qmd://notes/Projects/Garden%20plan.md', PLAN],
      ['notes/Private/Diary.md', 'secret\n'],
      ['notes/hidden/Note.md', 'hidden\n'],
      ['other/Projects/Garden plan.md', PLAN],
      ['notes/Gone.md', 'gone\n'],
    ];
    const { items: results } = await semanticSearch(config, { searches: [{ type: 'lex', query: 'plan' }], limit: 10 }, fakeQmd(hits));
    expect(results).toEqual([{ path: 'Projects/Garden plan.md', score: 0.9, line: 3, excerpt: '3: plant tomatoes\n4: ' }]);
  });

  test('drops a note the access policy hides even when QMD reports its exact path and content', async () => {
    process.env.VAULT_PATH = vaultPath;
    const { items: results } = await semanticSearch(config, { searches: [{ type: 'lex', query: 'draft' }], limit: 10 },
      fakeQmd([['qmd://notes/Projects/Secret%20(draft).md', 'private draft\n'], ['notes/Projects/Secret-draft.md', 'public draft\n']]));
    expect(results.map(r => r.path)).toEqual(['Projects/Secret-draft.md']);
    expect(JSON.stringify(results)).not.toContain('private');
  });

  test('drops a result whose note changed since QMD indexed it', async () => {
    process.env.VAULT_PATH = vaultPath;
    const { items: results } = await semanticSearch(config, { searches: [{ type: 'lex', query: 'plan' }], limit: 10 }, fakeQmd([['notes/Projects/Garden plan.md', 'older text\n']]));
    expect(results).toEqual([]);
  });

  test('drops results outside the requested folder', async () => {
    process.env.VAULT_PATH = vaultPath;
    await writeFile(path.join(vaultPath, 'Plan elsewhere.md'), PLAN);
    const { items } = await semanticSearch(config, { searches: [{ type: 'lex', query: 'plan' }], limit: 10, folder: 'Projects' },
      fakeQmd([['notes/Plan elsewhere.md', PLAN], ['notes/Projects/Garden plan.md', PLAN]]));
    expect(items.map(r => r.path)).toEqual(['Projects/Garden plan.md']);
    await rm(path.join(vaultPath, 'Plan elsewhere.md'));
  });

  test('reports a QMD HTTP failure as an error', async () => {
    process.env.VAULT_PATH = vaultPath;
    const failing: Fetcher = async () => new Response('nope', { status: 500 });
    await expect(semanticSearch(config, { searches: [{ type: 'lex', query: 'x' }], limit: 1 }, failing)).rejects.toThrow('HTTP 500');
    const leaky: Fetcher = async () => new Response('Error at /srv/host/index.sqlite: secret note text', { status: 500 });
    const error = await semanticSearch(config, { searches: [{ type: 'lex', query: '"x' }], limit: 1 }, leaky).catch(e => e);
    expect(error.message).toContain('unclosed "');
    expect(error.message).not.toContain('/srv/host');
    expect(error.message).not.toContain('secret note text');
    await expect(semanticSearch(config, { searches: [{ type: 'vec', query: 'x' }], limit: 1 }, leaky)).rejects.toThrow(/^QMD returned HTTP 500$/);
    const unreachable: Fetcher = async () => { throw new Error('connect ECONNREFUSED /some/host/path'); };
    await expect(semanticSearch(config, { searches: [{ type: 'lex', query: 'x' }], limit: 1 }, unreachable))
      .rejects.toThrow('QMD search failed: could not reach http://127.0.0.1:8181 or read its response');
  });

  test('registers vault_search_semantic only when configured, and returns readable results', async () => {
    process.env.VAULT_PATH = vaultPath;
    const off = new McpServer({ name: 'qmd-off', version: '0' });
    registerQmdTool(off, { config: null });
    const on = new McpServer({ name: 'qmd-on', version: '0' });
    registerQmdTool(on, { config, fetcher: fakeQmd([['notes/Projects/Garden plan.md', PLAN], ['notes/Private/Diary.md', 'secret\n'], ['notes/Projects/Garden plan.md', 'older text\n']]) });

    for (const [server, expected] of [[off, false], [on, true]] as const) {
      const client = new Client({ name: 't', version: '0' });
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
      const { tools } = await client.listTools();
      expect(tools.some(t => t.name === 'vault_search_semantic')).toBe(expected);
      if (expected) {
        const missing = await client.callTool({ name: 'vault_search_semantic', arguments: {} }) as any;
        expect(missing.isError).toBe(true);
        const calls: { url: string; body: any }[] = [];
        const plain = new McpServer({ name: 'qmd-plain', version: '0' });
        registerQmdTool(plain, { config, fetcher: fakeQmd([], calls) });
        const plainClient = new Client({ name: 't', version: '0' });
        const [pc, ps] = InMemoryTransport.createLinkedPair();
        await Promise.all([plain.connect(ps), plainClient.connect(pc)]);
        await plainClient.callTool({ name: 'vault_search_semantic', arguments: { query: 'planting tomatoes' } });
        expect(calls[0]!.body.searches).toEqual([{ type: 'lex', query: 'planting tomatoes' }, { type: 'vec', query: 'planting tomatoes' }]);
        await plainClient.callTool({ name: 'vault_search_semantic', arguments: { query: '"tomato stakes' } });
        expect(calls[1]!.body.searches).toEqual([{ type: 'lex', query: 'tomato stakes' }, { type: 'vec', query: '"tomato stakes' }]);
        await plainClient.callTool({ name: 'vault_search_semantic', arguments: { searches: [{ type: 'lex', query: '"tomato' }] } });
        expect(calls[2]!.body.searches).toEqual([{ type: 'lex', query: '"tomato' }]);
        await plainClient.close();
        const res = await client.callTool({ name: 'vault_search_semantic', arguments: { searches: [{ type: 'lex', query: 'plan' }] } }) as any;
        expect(res.isError).toBeFalsy();
        expect(res.content[0].text).toContain('Projects/Garden plan.md:3');
        expect(res.content[0].text).not.toContain('Diary');
        expect(res.content[0].text).not.toMatch(/withheld|skipped/);
        expect(res.structuredContent.items.map((i: any) => i.path)).toEqual(['Projects/Garden plan.md']);
      }
      await client.close();
    }
  });
});
