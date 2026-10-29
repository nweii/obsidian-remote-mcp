// ABOUTME: Tests for vault_semantic_search — QMD path normalization, the request sent to QMD, mapping
// results back to vault paths, withholding results the access policy hides, and registration over MCP.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import { createHash } from 'crypto';
import path from 'path';
import { McpServer } from '@modelcontextprotocol/server';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { loadQmdConfig, pathInCollection, qmdPath, registerQmdTool, semanticSearch, type Fetcher, type QmdConfig } from '../src/qmd.js';

const config: QmdConfig = { url: 'http://127.0.0.1:8181', collection: 'brain', timeoutMs: 5000 };

const docid = (content: string) => `#${createHash('sha256').update(content).digest('hex').slice(0, 6)}`;

// Each hit is a QMD path plus the content QMD indexed for it, which sets the docid.
function fakeQmd(hits: [file: string, content: string][], calls: { url: string; body: any }[] = []): Fetcher {
  return async (url, init) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    const results = hits.map(([file, content], i) => ({ docid: docid(content), file, title: file, score: 0.9 - i / 10, line: 3, snippet: `3: hit ${i}` }));
    return new Response(JSON.stringify({ results }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}

describe('qmdPath', () => {
  test('matches QMD normalization of folders, spaces, punctuation, and emoji', () => {
    expect(qmdPath('06-Working/Systems/Log - Mac mini migration 2026-10.md')).toBe('06-Working/Systems/Log-Mac-mini-migration-2026-10.md');
    expect(qmdPath('01-Days/2026-10-29-Thu.md')).toBe('01-Days/2026-10-29-Thu.md');
    expect(qmdPath('Notes/Café (draft).md')).toBe('Notes/Café-draft.md');
    expect(qmdPath('Ideas/🌱 Seeds.md')).toBe('Ideas/1f331-Seeds.md');
    expect(qmdPath('a___b.md')).toBe('a/b.md');
  });
});

describe('pathInCollection', () => {
  test('reads both the collection/path form and the encoded qmd:// URI form', () => {
    expect(pathInCollection('brain/Projects/Plan.md', 'brain')).toBe('Projects/Plan.md');
    expect(pathInCollection('qmd://brain/Projects/Caf%C3%A9-draft.md', 'brain')).toBe('Projects/Café-draft.md');
    expect(pathInCollection('qmd://other/Projects/Plan.md', 'brain')).toBeNull();
    expect(pathInCollection('brainy/Plan.md', 'brain')).toBeNull();
    expect(pathInCollection('qmd://brain/%E0%A4%A.md', 'brain')).toBeNull();
    expect(pathInCollection(undefined, 'brain')).toBeNull();
  });
});

describe('loadQmdConfig', () => {
  test('is off without QMD_URL, and off without QMD_COLLECTION', () => {
    expect(loadQmdConfig({})).toBeNull();
    expect(loadQmdConfig({ QMD_URL: 'http://127.0.0.1:8181' })).toBeNull();
  });

  test('trims the trailing slash and defaults the timeout', () => {
    expect(loadQmdConfig({ QMD_URL: 'http://127.0.0.1:8181/', QMD_COLLECTION: 'brain' }))
      .toEqual({ url: 'http://127.0.0.1:8181', collection: 'brain', timeoutMs: 60000 });
  });
});

const PLAN = '# Plan\n\nmove services\n';

describe('semanticSearch', () => {
  let vaultPath: string;

  beforeAll(async () => {
    vaultPath = await mkdtemp(path.join(os.tmpdir(), 'vault-qmd-'));
    await mkdir(path.join(vaultPath, 'Projects'), { recursive: true });
    await mkdir(path.join(vaultPath, 'Private'), { recursive: true });
    await mkdir(path.join(vaultPath, '.hidden'), { recursive: true });
    await writeFile(path.join(vaultPath, 'Projects', 'Mac mini plan.md'), PLAN);
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
    await semanticSearch(config, { searches: [{ type: 'vec', query: 'moving services' }], limit: 5, intent: 'home server' }, fakeQmd([], calls));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://127.0.0.1:8181/query');
    expect(calls[0]!.body).toEqual({
      searches: [{ type: 'vec', query: 'moving services' }],
      collections: ['brain'],
      limit: 5,
      intent: 'home server',
    });
  });

  test('maps results to vault paths and withholds ignored, hidden, foreign, and unknown documents', async () => {
    process.env.VAULT_PATH = vaultPath;
    const hits: [string, string][] = [
      ['qmd://brain/Projects/Mac-mini-plan.md', PLAN],
      ['brain/Private/Diary.md', 'secret\n'],
      ['brain/hidden/Note.md', 'hidden\n'],
      ['other/Projects/Mac-mini-plan.md', PLAN],
      ['brain/Gone.md', 'gone\n'],
    ];
    const { results, withheld } = await semanticSearch(config, { searches: [{ type: 'lex', query: 'plan' }], limit: 10 }, fakeQmd(hits));
    expect(results).toEqual([{ path: 'Projects/Mac mini plan.md', title: hits[0]![0], score: 0.9, line: 3, snippet: '3: hit 0' }]);
    expect(withheld).toBe(4);
  });

  test('matches the original vault path that current QMD releases report, percent-encoded', async () => {
    process.env.VAULT_PATH = vaultPath;
    const { results, withheld } = await semanticSearch(config, { searches: [{ type: 'lex', query: 'plan' }], limit: 10 },
      fakeQmd([['qmd://brain/Projects/Mac%20mini%20plan.md', PLAN], ['qmd://brain/Projects/Secret%20(draft).md', 'private draft\n']]));
    expect(results.map(r => r.path)).toEqual(['Projects/Mac mini plan.md']);
    expect(withheld).toBe(1);
  });

  test('withholds an excluded note that shares a QMD path with a readable one', async () => {
    process.env.VAULT_PATH = vaultPath;
    const hits: [string, string][] = [
      ['brain/Projects/Secret-draft.md', 'private draft\n'],
      ['brain/Projects/Secret-draft.md', 'public draft\n'],
    ];
    const { results, withheld } = await semanticSearch(config, { searches: [{ type: 'lex', query: 'draft' }], limit: 10 }, fakeQmd(hits));
    expect(results.map(r => r.path)).toEqual(['Projects/Secret-draft.md']);
    expect(results[0]!.snippet).toBe('3: hit 1');
    expect(withheld).toBe(1);
  });

  test('withholds a result whose note changed since QMD indexed it', async () => {
    process.env.VAULT_PATH = vaultPath;
    const { results, withheld } = await semanticSearch(config, { searches: [{ type: 'lex', query: 'plan' }], limit: 10 }, fakeQmd([['brain/Projects/Mac-mini-plan.md', 'older text\n']]));
    expect(results).toEqual([]);
    expect(withheld).toBe(1);
  });

  test('reports a QMD HTTP failure as an error', async () => {
    process.env.VAULT_PATH = vaultPath;
    const failing: Fetcher = async () => new Response('nope', { status: 500 });
    await expect(semanticSearch(config, { searches: [{ type: 'lex', query: 'x' }], limit: 1 }, failing)).rejects.toThrow('HTTP 500');
    const unreachable: Fetcher = async () => { throw new Error('connect ECONNREFUSED /some/host/path'); };
    await expect(semanticSearch(config, { searches: [{ type: 'lex', query: 'x' }], limit: 1 }, unreachable))
      .rejects.toThrow('QMD search failed: could not reach http://127.0.0.1:8181 or read its response');
  });

  test('registers vault_semantic_search only when configured, and returns readable results', async () => {
    process.env.VAULT_PATH = vaultPath;
    const off = new McpServer({ name: 'qmd-off', version: '0' });
    registerQmdTool(off, { config: null });
    const on = new McpServer({ name: 'qmd-on', version: '0' });
    registerQmdTool(on, { config, fetcher: fakeQmd([['brain/Projects/Mac-mini-plan.md', PLAN], ['brain/Private/Diary.md', 'secret\n']]) });

    for (const [server, expected] of [[off, false], [on, true]] as const) {
      const client = new Client({ name: 't', version: '0' });
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
      const { tools } = await client.listTools();
      expect(tools.some(t => t.name === 'vault_semantic_search')).toBe(expected);
      if (expected) {
        const res = await client.callTool({ name: 'vault_semantic_search', arguments: { searches: [{ type: 'lex', query: 'plan' }] } }) as any;
        expect(res.isError).toBeFalsy();
        expect(res.content[0].text).toContain('Projects/Mac mini plan.md:3');
        expect(res.content[0].text).toContain('1 result(s) withheld');
        expect(res.content[0].text).not.toContain('Diary');
      }
      await client.close();
    }
  });
});
