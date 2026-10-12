// ABOUTME: Tests for vault_skim — chunking, provider resolution, request shapes per provider, batching and
// failure handling with a fake transport, exclusion rules, and the dry-run → confirm flow over MCP.
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import fs, { mkdir, mkdtemp, rm, symlink, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { McpServer } from '@modelcontextprotocol/server';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { chunkText } from '../src/chunk.js';
import {
  buildRequest,
  judgeChunks,
  parseAnswers,
  planBatches,
  resolveDecisionProvider,
  MAX_ITEMS_PER_BATCH,
  type DecisionProvider,
  type HttpResponse,
  type Transport,
} from '../src/decision.js';
import { exclusionRules, pathMatches, planSkim, registerSkimTool, runSkim, tagMatches } from '../src/skim.js';

const typesafe: DecisionProvider = {
  name: 'typesafe', label: 'TypeSafe', endpoint: 'https://api.typesafe.ai/v1/systemone', apiKey: 'k', model: 'jev-latest',
};
const openai: DecisionProvider = {
  name: 'openai', label: 'OpenAI', endpoint: 'https://api.openai.com/v1/decisions', apiKey: 'k', model: 'gpt-6-luna',
};

// Answers every System One question: P = 0.9 when the chunk text contains `needle`, else 0.1.
function scoringTransport(needle: string, calls: unknown[] = []): Transport {
  return async (_endpoint, _key, body) => {
    calls.push(body);
    const req = body as { state: { chunks: { id: string; text: string }[] } };
    const answers = Object.fromEntries(req.state.chunks.map(c => [c.id, { type: 'noul', noul: c.text.includes(needle) ? 0.9 : 0.1 }]));
    return { status: 200, json: { answers } };
  };
}

const noSleep = async () => {};

describe('chunkText', () => {
  test('returns no chunks for blank text', () => {
    expect(chunkText('\n  \n')).toEqual([]);
  });

  test('keeps a short note as one chunk spanning its lines', () => {
    expect(chunkText('a\nb\nc')).toEqual([{ startLine: 1, endLine: 3, text: 'a\nb\nc' }]);
  });

  test('splits long text into bounded chunks whose line ranges cover every line', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1} ${'x'.repeat(40)}`);
    const chunks = chunkText(lines.join('\n'), { chunkChars: 1000, overlap: 0.1 });
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(1000);
    expect(chunks[0]!.startLine).toBe(1);
    expect(chunks.at(-1)!.endLine).toBe(200);
    for (let i = 1; i < chunks.length; i++) {
      // Overlap: each chunk starts at or before the line after the previous chunk ended.
      expect(chunks[i]!.startLine).toBeLessThanOrEqual(chunks[i - 1]!.endLine + 1);
      expect(chunks[i]!.startLine).toBeGreaterThan(chunks[i - 1]!.startLine);
    }
  });

  test('cuts a single huge line into pieces that share its line number', () => {
    const chunks = chunkText(`intro\n${'y'.repeat(5000)}\noutro`, { chunkChars: 1000, overlap: 0 });
    expect(chunks.every(c => c.text.length <= 1000)).toBe(true);
    expect(chunks.some(c => c.startLine === 2 && c.endLine === 2)).toBe(true);
  });

  test('overlaps long paragraphs by 200 source characters with accurate line citations', () => {
    const lines = Array.from({ length: 6 }, (_, i) => `paragraph ${i}: ${String(i).repeat(900)}`);
    const text = lines.join('\n');
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]!.text).toBe(`${lines[0]}\n${lines[1]}`);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.text.slice(0, 200)).toBe(chunks[i - 1]!.text.slice(-200));
      expect(chunks[i]!.text.length).toBeLessThanOrEqual(2000);
    }
    expect(chunks[1]!.startLine).toBe(2);
    expect(chunks.at(-1)!.endLine).toBe(6);
  });

  test('overlaps a huge single line without adding newlines or exceeding the chunk bound', () => {
    const text = Array.from({ length: 1000 }, (_, i) => String(i).padStart(5, '0')).join('');
    const chunks = chunkText(text, { chunkChars: 1000, overlap: 0.1 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.startLine).toBe(1);
      expect(chunk.endLine).toBe(1);
      expect(chunk.text.length).toBeLessThanOrEqual(1000);
      expect(chunk.text).not.toContain('\n');
    }
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.text.slice(0, 100)).toBe(chunks[i - 1]!.text.slice(-100));
    }
    expect(chunks[0]!.text + chunks.slice(1).map(c => c.text.slice(100)).join('')).toBe(text);
  });
});

describe('resolveDecisionProvider', () => {
  test('returns null without a key, so the tool stays unregistered', () => {
    expect(resolveDecisionProvider({})).toBeNull();
  });

  test('defaults to TypeSafe and Jev', () => {
    expect(resolveDecisionProvider({ TYPESAFE_API_KEY: 'k' })).toMatchObject({ name: 'typesafe', model: 'jev-latest' });
  });

  test('reads the chosen provider key and SKIM_MODEL', () => {
    const p = resolveDecisionProvider({ SKIM_PROVIDER: 'OpenRouter', OPENROUTER_API_KEY: 'k', SKIM_MODEL: 'typesafe/jev-2' });
    expect(p).toMatchObject({ name: 'openrouter', endpoint: 'https://openrouter.ai/api/alpha/decisions', model: 'typesafe/jev-2' });
  });

  test('rejects an unknown provider', () => {
    expect(() => resolveDecisionProvider({ SKIM_PROVIDER: 'gemini', TYPESAFE_API_KEY: 'k' })).toThrow(/SKIM_PROVIDER/);
  });
});

describe('decision requests', () => {
  const items = [
    { source: 'A.md', lines: '1-3', text: 'alpha' },
    { source: 'B.md', lines: '4-9', text: 'beta' },
  ];

  test('System One request carries the chunks in state and one noul question each', () => {
    const req = buildRequest(typesafe, 'goal', items) as any;
    expect(req.model).toBe('jev-latest');
    expect(req.state.chunks.map((c: any) => c.id)).toEqual(['chunk_0', 'chunk_1']);
    expect(req.questions.chunk_1.type).toBe('noul');
    expect(req.questions.chunk_1.instructions.chunk).toBe('chunk_1');
  });

  test('OpenAI request uses named predicates over a JSON input', () => {
    const req = buildRequest(openai, 'goal', items) as any;
    expect(JSON.parse(req.input).goal).toBe('goal');
    expect(req.questions.map((q: any) => [q.type, q.name])).toEqual([['predicate', 'chunk_0'], ['predicate', 'chunk_1']]);
  });

  test('parseAnswers leaves malformed or missing answers unjudged', () => {
    expect(parseAnswers(typesafe, { answers: { chunk_0: { type: 'noul', noul: 0.7 }, chunk_1: { type: 'noul', noul: 7 } } }, 2)).toEqual([0.7, null]);
    expect(parseAnswers(openai, { answers: [{ type: 'predicate', name: 'chunk_1', probability: 0.2 }] }, 2)).toEqual([null, 0.2]);
    expect(parseAnswers(typesafe, null, 2)).toEqual([null, null]);
  });

  test('planBatches caps items per request', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ source: 'A.md', lines: `${i}-${i}`, text: 't' }));
    const batches = planBatches(many);
    expect(batches.every(b => b.length <= MAX_ITEMS_PER_BATCH)).toBe(true);
    expect(batches.flat()).toEqual(many.map((_, i) => i));
  });
});

describe('judgeChunks', () => {
  const items = Array.from({ length: 30 }, (_, i) => ({ source: 'A.md', lines: `${i}-${i}`, text: i % 2 ? 'needle' : 'hay' }));

  test('scores every item across batches', async () => {
    const calls: unknown[] = [];
    const result = await judgeChunks(typesafe, 'g', items, { transport: scoringTransport('needle', calls), sleep: noSleep });
    expect(calls.length).toBe(2);
    expect(result.failures).toEqual([]);
    expect(result.probabilities).toEqual(items.map(it => (it.text === 'needle' ? 0.9 : 0.1)));
  });

  test('a failed batch leaves its items unjudged and reports why', async () => {
    const transport: Transport = async () => ({ status: 401, json: {} });
    const result = await judgeChunks(typesafe, 'g', items.slice(0, 3), { transport, sleep: noSleep });
    expect(result.probabilities).toEqual([null, null, null]);
    expect(result.failures[0]).toMatch(/API key/);
  });

  test('retries a rate-limited request', async () => {
    let n = 0;
    const ok = scoringTransport('needle');
    const transport: Transport = async (...args) => (n++ === 0 ? { status: 429, json: {}, retryAfter: '0' } : ok(...args));
    const result = await judgeChunks(typesafe, 'g', items.slice(0, 2), { transport, sleep: noSleep });
    expect(result.probabilities).toEqual([0.1, 0.9]);
  });

  test('retries a transient HTTP 500 and returns the judged chunks', async () => {
    let attempts = 0;
    const ok = scoringTransport('needle');
    const transport: Transport = async (...args) => (++attempts === 1 ? { status: 500, json: {} } : ok(...args));
    const result = await judgeChunks(typesafe, 'g', items.slice(0, 2), { transport, sleep: noSleep });
    expect(attempts).toBe(2);
    expect(result.failures).toEqual([]);
    expect(result.probabilities).toEqual([0.1, 0.9]);
  });

  test('splits a batch when the provider names a question limit', async () => {
    const ok = scoringTransport('needle');
    const sizes: number[] = [];
    const transport: Transport = async (endpoint, key, body, signal): Promise<HttpResponse> => {
      const count = Object.keys((body as any).questions).length;
      sizes.push(count);
      if (count > 5) {
        return { status: 422, json: { detail: [{ type: 'too_long', loc: ['body', 'questions'], msg: 'Dictionary should have at most 5 items after validation, not 12' }] } };
      }
      return ok(endpoint, key, body, signal);
    };
    const result = await judgeChunks(typesafe, 'g', items.slice(0, 12), { transport, sleep: noSleep });
    expect(result.failures).toEqual([]);
    expect(result.probabilities.every(p => p !== null)).toBe(true);
    expect(sizes).toEqual([12, 5, 5, 2]);
  });

  test('split batches share the four-request concurrency bound and preserve every judgment', async () => {
    const many = Array.from({ length: 96 }, (_, i) => ({ source: 'A.md', lines: `${i + 1}-${i + 1}`, text: i % 2 ? 'needle' : 'hay' }));
    const ok = scoringTransport('needle');
    let active = 0;
    let peak = 0;
    const transport: Transport = async (...args) => {
      active++;
      peak = Math.max(peak, active);
      try {
        await new Promise(resolve => setTimeout(resolve, 1));
        const count = Object.keys((args[2] as any).questions).length;
        if (count > 1) return { status: 422, json: { detail: [{ type: 'too_long', loc: ['body', 'questions'], msg: 'Dictionary should have at most 1 items after validation' }] } };
        return await ok(...args);
      } finally {
        active--;
      }
    };
    const result = await judgeChunks(typesafe, 'g', many, { transport, sleep: noSleep });
    expect(peak).toBeLessThanOrEqual(4);
    expect(result.failures).toEqual([]);
    expect(result.probabilities).toEqual(many.map(it => it.text === 'needle' ? 0.9 : 0.1));
  });
});

describe('exclusion rules', () => {
  test('tag patterns: exact or branch', () => {
    expect(tagMatches('Private', 'private')).toBe(true);
    expect(tagMatches('private/health', 'private')).toBe(false);
    expect(tagMatches('work/acme', 'work/*')).toBe(true);
    expect(tagMatches('work', 'work/*')).toBe(true);
    expect(tagMatches('workshop', 'work/*')).toBe(false);
  });

  test('path patterns cover the path and everything under it', () => {
    expect(pathMatches('03-Records/Journaling/2026.md', '03-Records/Journaling')).toBe(true);
    expect(pathMatches('03-Records/Journaling-old/x.md', '03-Records/Journaling')).toBe(false);
    expect(pathMatches('03-records/journaling/2026.md', '03-Records/Journaling')).toBe(true);
  });

  test('path patterns accept .mcpignore wildcards', () => {
    expect(pathMatches('03-Records/Journaling/2026.md', '03-Records/*')).toBe(true);
    expect(pathMatches('Projects/Acme/Private/plan.md', '**/Private')).toBe(true);
    expect(pathMatches('Private.md', '**/Private')).toBe(false);
    expect(pathMatches('Notes/draft-1.md', 'Notes/draft-?.md')).toBe(true);
    expect(pathMatches('Notes/draft-10.md', 'Notes/draft-?.md')).toBe(false);
    expect(pathMatches('anything.md', '/')).toBe(true);
  });

  test('request rules add to config rules', () => {
    const rules = exclusionRules({ exclude_tags: ['#Draft'], exclude_paths: ['/Inbox/'] }, { SKIM_EXCLUDE_TAGS: 'private, work/*', SKIM_EXCLUDE_PATHS: 'Journal' });
    expect(rules.tags.map(r => [r.pattern, r.origin])).toEqual([
      ['private', 'server config'], ['work/*', 'server config'], ['draft', 'this request'],
    ]);
    expect(rules.paths.map(r => r.pattern)).toEqual(['Journal', 'Inbox']);
  });
});

describe('vault_skim over a temp vault', () => {
  let vaultPath: string;
  const env = { SKIM_EXCLUDE_TAGS: 'private', SKIM_EXCLUDE_PATHS: 'Journal' };

  async function seed(rel: string, content: string) {
    const full = path.join(vaultPath, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, 'utf-8');
  }

  beforeAll(async () => {
    vaultPath = await mkdtemp(path.join(os.tmpdir(), 'orm-skim-test-'));
    process.env.VAULT_PATH = vaultPath;
    const filler = Array.from({ length: 60 }, (_, i) => `Filler paragraph ${i} about nothing in particular, padded out.`).join('\n');
    await seed('Notes/Garden.md', `# Garden\n\n${filler}\nThe tomatoes need needle-thin stakes by May.\n${filler}\n`);
    await seed('Notes/Secret.md', '---\ntags: [private]\n---\nneedle in a private note\n');
    await seed('Notes/Draft.md', 'Draft mentions needle #draft\n');
    await seed('Journal/2026-10-11.md', 'needle in the journal\n');
    await symlink('../Journal/2026-10-11.md', path.join(vaultPath, 'Notes/Journal-link.md'));
  });

  afterAll(async () => {
    await rm(vaultPath, { recursive: true, force: true });
  });

  test('plan withholds config and request exclusions and sends nothing', async () => {
    process.env.VAULT_PATH = vaultPath;
    const plan = await planSkim({ goal: 'stakes', query: 'needle', exclude_tags: ['draft'] }, typesafe, env);
    expect(plan.notes.map(n => n.path)).toEqual(['Notes/Garden.md']);
    const reasons = Object.fromEntries(plan.excluded.map(e => [e.path, e.reason]));
    expect(reasons['Journal/2026-10-11.md']).toBe('path Journal (server config)');
    expect(reasons['Notes/Secret.md']).toBe('tag #private (server config)');
    expect(reasons['Notes/Draft.md']).toBe('tag #draft (this request)');
    expect(plan.chunkCount).toBeGreaterThan(1);
  });

  test('plan id changes when a planned note changes', async () => {
    process.env.VAULT_PATH = vaultPath;
    const before = await planSkim({ goal: 'g', paths: ['Notes/Draft.md'] }, typesafe, {});
    await seed('Notes/Draft.md', 'Draft mentions needle twice #draft\n');
    const after = await planSkim({ goal: 'g', paths: ['Notes/Draft.md'] }, typesafe, {});
    expect(after.planId).not.toBe(before.planId);
  });

  test('allowed aliases share one canonical note in the disclosure plan', async () => {
    process.env.VAULT_PATH = vaultPath;
    await symlink('Garden.md', path.join(vaultPath, 'Notes/Garden-link.md'));
    const plan = await planSkim({ goal: 'stakes', paths: ['Notes/Garden.md', './Notes/Garden.md', 'Notes/Garden-link.md'] }, typesafe, env);
    expect(plan.notes.map(n => n.path)).toEqual(['Notes/Garden.md']);
    expect(plan.missing).toEqual([]);
    const excluded = await planSkim({ goal: 'stakes', paths: ['Notes/Garden-link.md'], exclude_paths: ['Notes/Garden-link.md'] }, typesafe, env);
    expect(excluded.notes).toEqual([]);
    expect(excluded.excluded).toEqual([{ path: 'Notes/Garden-link.md', reason: 'path Notes/Garden-link.md (this request)' }]);
  });

  test('tool withholds excluded notes reached through equivalent paths or symlinks', async () => {
    process.env.VAULT_PATH = vaultPath;
    const previous = process.env.SKIM_EXCLUDE_PATHS;
    process.env.SKIM_EXCLUDE_PATHS = 'Journal';
    const calls: unknown[] = [];
    const server = new McpServer({ name: 'skim-policy-test', version: '0' });
    registerSkimTool(server, { provider: typesafe, transport: scoringTransport('needle', calls), sleep: noSleep });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'skim-policy-client', version: '0' });
    await client.connect(clientSide);
    try {
      const args = {
        goal: 'needle',
        paths: ['Notes/Garden.md', './Journal/2026-10-11.md', 'Notes/../Journal/2026-10-11.md', 'Notes/Journal-link.md'],
      };
      const dry = await client.callTool({ name: 'vault_skim', arguments: args }) as any;
      expect(calls).toEqual([]);
      expect(dry.content[0].text).toContain('from 1 note(s)');
      const planId = dry.content[0].text.match(/confirm: "([0-9a-f]{12})"/)![1]!;
      const run = await client.callTool({ name: 'vault_skim', arguments: { ...args, confirm: planId } }) as any;
      expect(run.isError).toBeFalsy();
      expect(calls.length).toBeGreaterThan(0);
      expect(JSON.stringify(calls)).not.toContain('needle in the journal');
    } finally {
      await client.close();
      if (previous === undefined) delete process.env.SKIM_EXCLUDE_PATHS;
      else process.env.SKIM_EXCLUDE_PATHS = previous;
    }
  });

  test('query selection never reads a path-excluded note, including through a symlink', async () => {
    process.env.VAULT_PATH = vaultPath;
    const read = spyOn(fs, 'readFile');
    try {
      const plan = await planSkim({ goal: 'stakes', query: 'needle' }, typesafe, env);
      expect(plan.notes.map(n => n.path)).toEqual(['Notes/Draft.md', 'Notes/Garden.md']);
      const pathsRead = read.mock.calls.map(([file]) => String(file));
      expect(pathsRead.some(file => file.includes('/Journal/') || file.endsWith('/Journal-link.md'))).toBe(false);
    } finally {
      read.mockRestore();
    }
  });

  test('runSkim keeps only relevant chunks, cited by line range', async () => {
    process.env.VAULT_PATH = vaultPath;
    const plan = await planSkim({ goal: 'stakes', paths: ['Notes/Garden.md'] }, typesafe, env);
    const text = await runSkim(plan, { transport: scoringTransport('tomatoes'), sleep: noSleep });
    expect(text).toContain('tomatoes need needle-thin stakes');
    expect(text).toMatch(/\[Notes\/Garden\.md:\d+-\d+ · p=0\.90\]/);
    // Overlap can repeat the matching line in a neighbouring chunk, so 1–2 chunks pass.
    const [, kept, total] = text.match(/kept (\d+) of (\d+) chunk/)!;
    expect(Number(kept)).toBeGreaterThanOrEqual(1);
    expect(Number(kept)).toBeLessThan(Number(total));
  });

  test('runSkim keeps unjudged chunks when requests fail', async () => {
    process.env.VAULT_PATH = vaultPath;
    const plan = await planSkim({ goal: 'stakes', paths: ['Notes/Garden.md'] }, typesafe, env);
    const text = await runSkim(plan, { transport: async () => ({ status: 500, json: {} }), sleep: noSleep });
    expect(text).toContain('Warning: ');
    expect(text).toContain(`kept ${plan.chunkCount} of ${plan.chunkCount}`);
    expect(text).toContain('unjudged');
  });

  test('tool: dry run, refused stale confirm, then confirmed run', async () => {
    process.env.VAULT_PATH = vaultPath;
    const calls: unknown[] = [];
    const server = new McpServer({ name: 'skim-test', version: '0' });
    registerSkimTool(server, { provider: typesafe, transport: scoringTransport('tomatoes', calls), sleep: noSleep });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'skim-test-client', version: '0' });
    await client.connect(clientSide);

    const args = { goal: 'stakes', paths: ['Notes/Garden.md'] };
    const dry = await client.callTool({ name: 'vault_skim', arguments: args }) as any;
    const planText: string = dry.content[0].text;
    expect(planText).toContain('Dry run: nothing has been sent');
    expect(calls.length).toBe(0);
    const planId = planText.match(/confirm: "([0-9a-f]{12})"/)![1]!;

    const stale = await client.callTool({ name: 'vault_skim', arguments: { ...args, confirm: '000000000000' } }) as any;
    expect(stale.isError).toBe(true);
    expect(calls.length).toBe(0);

    await seed('Notes/Garden.md', `${await fs.readFile(path.join(vaultPath, 'Notes/Garden.md'), 'utf-8')}\nThe stakes plan changed.\n`);
    const changed = await client.callTool({ name: 'vault_skim', arguments: { ...args, confirm: planId } }) as any;
    expect(changed.isError).toBe(true);
    expect(calls.length).toBe(0);
    const currentId = changed.content[0].text.match(/confirm: "([0-9a-f]{12})"/)![1]!;
    const run = await client.callTool({ name: 'vault_skim', arguments: { ...args, confirm: currentId } }) as any;
    expect(run.isError).toBeFalsy();
    expect(run.content[0].text).toContain('tomatoes need needle-thin stakes');
    expect(calls.length).toBeGreaterThan(0);

    await client.close();
  });

  test('tool rejects bad queries and missing folders without naming host paths', async () => {
    process.env.VAULT_PATH = vaultPath;
    const calls: unknown[] = [];
    const server = new McpServer({ name: 'skim-test', version: '0' });
    registerSkimTool(server, { provider: typesafe, transport: scoringTransport('tomatoes', calls), sleep: noSleep });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'skim-test-client', version: '0' });
    await client.connect(clientSide);

    for (const query of ['(', 'a'.repeat(1001)]) {
      const result = await client.callTool({ name: 'vault_skim', arguments: { goal: 'stakes', query } }) as any;
      expect(result.isError).toBe(true);
    }
    const missing = await client.callTool({ name: 'vault_skim', arguments: { goal: 'stakes', folder: 'Nowhere' } }) as any;
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain('Folder not found: Nowhere');
    expect(missing.content[0].text).not.toContain(vaultPath);
    expect(calls.length).toBe(0);

    await client.close();
  });

  test('tool is not registered without a provider', async () => {
    const server = new McpServer({ name: 'skim-test', version: '0' });
    registerSkimTool(server, { provider: null });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'skim-test-client', version: '0' });
    await client.connect(clientSide);
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name)).not.toContain('vault_skim');
    await client.close();
  });
});
