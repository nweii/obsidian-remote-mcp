// ABOUTME: Tests for vault_search_semantic — chunking, provider resolution, request shapes per provider, batching and
// failure handling with a fake transport, exclusion rules, note ranking, passage extraction, the judgment
// cache, and calls over MCP.
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
import { NOTE_PROMPT, registerSemanticSearchTool, runSemanticSearch, selectNotes } from '../src/semantic-search.js';
import { exclusionRules, pathMatches, unsupportedExclusionSetting } from '../src/api-exclusions.js';
import { JudgmentCache } from '../src/judgment-cache.js';

const typesafe: DecisionProvider = {
  name: 'typesafe', label: 'TypeSafe', endpoint: 'https://api.typesafe.ai/v1/systemone', apiKey: 'k', model: 'jev-latest',
};
const openai: DecisionProvider = {
  name: 'openai', label: 'OpenAI', endpoint: 'https://api.openai.com/v1/decisions', apiKey: 'k', model: 'gpt-6-luna',
};

// Answers every System One question: P = 0.9 when the item text (a chunk or a note card) contains
// `needle`, else 0.1.
function scoringTransport(needle: string, calls: unknown[] = []): Transport {
  return async (_endpoint, _key, body) => {
    calls.push(body);
    const state = (body as { state: Record<string, unknown> }).state;
    const items = (state.chunks ?? state.notes) as { id: string; text: string }[];
    const answers = Object.fromEntries(items.map(c => [c.id, { type: 'noul', noul: c.text.includes(needle) ? 0.9 : 0.1 }]));
    return { status: 200, json: { answers } };
  };
}

const stage = (call: unknown) => ((call as { state: Record<string, unknown> }).state.notes ? 'notes' : 'chunks');

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

  test.each([
    ['typesafe', 'TYPESAFE_API_KEY', 'jev-latest'],
    ['openrouter', 'OPENROUTER_API_KEY', 'typesafe/jev-1.13'],
    ['openai', 'OPENAI_API_KEY', 'gpt-6-luna'],
  ])('selects %s through DECISION_PROVIDER with its existing key and default model', (provider, key, model) => {
    expect(resolveDecisionProvider({ DECISION_PROVIDER: provider, [key]: 'k' })).toMatchObject({ name: provider, model });
  });

  test('trims decision settings and accepts provider names without case sensitivity', () => {
    expect(resolveDecisionProvider({ DECISION_PROVIDER: ' OpenAI ', OPENAI_API_KEY: ' k ', DECISION_MODEL: ' custom-model ' }))
      .toMatchObject({ name: 'openai', apiKey: 'k', model: 'custom-model' });
  });

  test('does not select a different provider because its key is available', () => {
    expect(resolveDecisionProvider({ DECISION_PROVIDER: 'openai', TYPESAFE_API_KEY: 'k' })).toBeNull();
  });

  test('uses legacy settings when decision settings are blank', () => {
    expect(resolveDecisionProvider({
      DECISION_PROVIDER: ' ', DECISION_MODEL: '\t',
      SKIM_PROVIDER: 'openrouter', SKIM_MODEL: 'legacy-model', OPENROUTER_API_KEY: 'k',
    })).toMatchObject({ name: 'openrouter', model: 'legacy-model' });
  });

  test('resolves provider and model aliases independently', () => {
    expect(resolveDecisionProvider({ DECISION_PROVIDER: 'openai', SKIM_MODEL: 'custom-model', OPENAI_API_KEY: 'k' }))
      .toMatchObject({ name: 'openai', model: 'custom-model' });
    expect(resolveDecisionProvider({ SKIM_PROVIDER: 'openai', DECISION_MODEL: 'custom-model', OPENAI_API_KEY: 'k' }))
      .toMatchObject({ name: 'openai', model: 'custom-model' });
  });

  test('equal settings and legacy-only settings do not warn', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      resolveDecisionProvider({ SKIM_PROVIDER: 'openai', SKIM_MODEL: 'custom-model', OPENAI_API_KEY: 'k' });
      resolveDecisionProvider({
        DECISION_PROVIDER: ' OpenAI ', SKIM_PROVIDER: 'openai',
        DECISION_MODEL: ' custom-model ', SKIM_MODEL: 'custom-model', OPENAI_API_KEY: 'k',
      });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test('preferred settings win conflicts and each setting warns once per process', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const env = {
      DECISION_PROVIDER: 'openai', SKIM_PROVIDER: 'typesafe',
      DECISION_MODEL: 'preferred-model', SKIM_MODEL: 'legacy-model', OPENAI_API_KEY: 'secret-test-key',
    };
    try {
      expect(resolveDecisionProvider(env)).toMatchObject({ name: 'openai', model: 'preferred-model' });
      resolveDecisionProvider(env);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls).toEqual([
        ['[obsidian-remote-mcp] DECISION_PROVIDER and SKIM_PROVIDER differ; using DECISION_PROVIDER.'],
        ['[obsidian-remote-mcp] DECISION_MODEL and SKIM_MODEL differ; using DECISION_MODEL.'],
      ]);
      expect(() => resolveDecisionProvider({ ...env, DECISION_PROVIDER: 'unknown' })).toThrow(/DECISION_PROVIDER/);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  test.each(['gemini', 'constructor', '__proto__'])('rejects unknown provider %s under either setting name', provider => {
    expect(() => resolveDecisionProvider({ SKIM_PROVIDER: provider, TYPESAFE_API_KEY: 'k' })).toThrow(/SKIM_PROVIDER/);
    expect(() => resolveDecisionProvider({ DECISION_PROVIDER: provider, TYPESAFE_API_KEY: 'k' })).toThrow(/DECISION_PROVIDER/);
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
  test('the SKIM_EXCLUDE_PATHS alias adds to EXTERNAL_API_EXCLUDE_PATHS rather than replacing it', () => {
    const rules = exclusionRules({}, { EXTERNAL_API_EXCLUDE_PATHS: 'Journal', SKIM_EXCLUDE_PATHS: 'Inbox' });
    expect(rules.paths.map(r => r.pattern)).toEqual(['Journal', 'Inbox']);
  });

  test('a leftover SKIM_EXCLUDE_TAGS setting is reported as unsupported', () => {
    expect(unsupportedExclusionSetting({ SKIM_EXCLUDE_TAGS: 'private' })).toContain('tag exclusions are not supported');
    expect(unsupportedExclusionSetting({ SKIM_EXCLUDE_TAGS: ' ' })).toBeNull();
    expect(unsupportedExclusionSetting({})).toBeNull();
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
    const rules = exclusionRules({ exclude_paths: ['/Inbox/'] }, { EXTERNAL_API_EXCLUDE_PATHS: 'Journal' });
    expect(rules.paths.map(r => [r.pattern, r.origin])).toEqual([['Journal', 'server config'], ['Inbox', 'this request']]);
  });
});

describe('note prompt requests', () => {
  const items = [{ source: 'A.md', text: 'Title: A' }, { source: 'B.md', text: 'Title: B' }];

  test('System One carries the criteria once in state and omits them from questions', () => {
    const req = buildRequest(typesafe, 'g', items, NOTE_PROMPT) as any;
    expect(req.state.criteria).toEqual(NOTE_PROMPT.criteria);
    expect(req.state.notes.map((n: any) => n.id)).toEqual(['note_0', 'note_1']);
    expect(req.state.notes[0].lines).toBeUndefined();
    expect(req.questions.note_1).toEqual({ type: 'noul', instructions: { question: NOTE_PROMPT.question('note_1'), note: 'note_1' } });
  });

  test('OpenAI predicates reference the criteria in the input', () => {
    const req = buildRequest(openai, 'g', items, NOTE_PROMPT) as any;
    expect(JSON.parse(req.input).criteria).toEqual(NOTE_PROMPT.criteria);
    expect(req.questions[0]).toEqual({ type: 'predicate', name: 'note_0', instructions: NOTE_PROMPT.question('note_0') });
    const response = { answers: [{ type: 'predicate', name: 'note_1', probability: 0.7 }] };
    expect(parseAnswers(openai, response, 2, NOTE_PROMPT)).toEqual([null, 0.7]);
  });

  test('note batches hold up to 100 cards', () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ source: `${i}.md`, text: 'Title: x' }));
    expect(planBatches(many, NOTE_PROMPT).map(b => b.length)).toEqual([100, 100, 50]);
  });
});

describe('vault_search_semantic over a temp vault', () => {
  let vaultPath: string;
  const env = { EXTERNAL_API_EXCLUDE_PATHS: 'Journal, Notes/Secret.md' };
  const fresh = () => new JudgmentCache(null);

  async function seed(rel: string, content: string) {
    const full = path.join(vaultPath, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, 'utf-8');
  }

  async function connect(transport: Transport, cache = fresh()) {
    const server = new McpServer({ name: 'semantic-test', version: '0' });
    registerSemanticSearchTool(server, { provider: typesafe, transport, sleep: noSleep, cache });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'semantic-test-client', version: '0' });
    await client.connect(clientSide);
    return client;
  }

  beforeAll(async () => {
    vaultPath = await mkdtemp(path.join(os.tmpdir(), 'orm-semantic-test-'));
    process.env.VAULT_PATH = vaultPath;
    const filler = Array.from({ length: 60 }, (_, i) => `Filler paragraph ${i} about nothing in particular, padded out.`).join('\n');
    await seed('Notes/Garden.md', `---\ndescription: "Tomato staking and the garden plan"\n---\n# Garden\n\n${filler}\nThe tomatoes need needle-thin stakes by May.\n${filler}\n`);
    await seed('Notes/Secret.md', '---\ntags: [private]\n---\nneedle in a private note\n');
    await seed('Notes/Draft.md', 'Draft mentions needle #draft\n');
    await seed('Notes/Recipes.md', '---\ndescription: "Weeknight soups"\n---\nLentils and stock.\n');
    await seed('Journal/2026-10-11.md', 'needle in the journal about tomatoes\n');
    await symlink('../Journal/2026-10-11.md', path.join(vaultPath, 'Notes/Journal-link.md'));
  });

  afterAll(async () => {
    await rm(vaultPath, { recursive: true, force: true });
  });

  test('selection withholds config and request exclusions', async () => {
    process.env.VAULT_PATH = vaultPath;
    const selection = await selectNotes({ goal: 'stakes', query: 'needle', exclude_paths: ['Notes/Draft.md'] }, env);
    expect(selection.candidates.map(n => n.path)).toEqual(['Notes/Garden.md']);
    const reasons = Object.fromEntries(selection.excluded.map(e => [e.path, e.reason]));
    expect(reasons['Journal/2026-10-11.md']).toBe('path Journal (server config)');
    expect(reasons['Notes/Secret.md']).toBe('path Notes/Secret.md (server config)');
    expect(reasons['Notes/Draft.md']).toBe('path Notes/Draft.md (this request)');
  });

  test('a note with unreadable frontmatter is still judged, by its title and opening text', async () => {
    process.env.VAULT_PATH = vaultPath;
    await seed('Broken/Bad.md', '---\ntags: [a\n  b: : c\n---\nneedle text\n');
    try {
      const selection = await selectNotes({ goal: 'g', folder: 'Broken' }, env);
      expect(selection.candidates.map(c => c.path)).toEqual(['Broken/Bad.md']);
      expect(selection.candidates[0]!.card).toStartWith('Title: Bad\nFolder: Broken\nOpening text: ');
    } finally {
      await rm(path.join(vaultPath, 'Broken'), { recursive: true, force: true });
    }
  });

  test('note cards carry title, folder, and the description, or opening text without one', async () => {
    process.env.VAULT_PATH = vaultPath;
    const selection = await selectNotes({ goal: 'g', folder: 'Notes' }, env);
    const cards = Object.fromEntries(selection.candidates.map(c => [c.path, c.card]));
    expect(cards['Notes/Garden.md']).toBe('Title: Garden\nFolder: Notes\nDescription: Tomato staking and the garden plan');
    expect(cards['Notes/Draft.md']).toBe('Title: Draft\nFolder: Notes\nTags: draft\nOpening text: Draft mentions needle #draft');
  });

  test('allowed aliases share one canonical note', async () => {
    process.env.VAULT_PATH = vaultPath;
    await symlink('Garden.md', path.join(vaultPath, 'Notes/Garden-link.md'));
    const selection = await selectNotes({ goal: 'stakes', paths: ['Notes/Garden.md', './Notes/Garden.md', 'Notes/Garden-link.md'] }, env);
    expect(selection.candidates.map(n => n.path)).toEqual(['Notes/Garden.md']);
    expect(selection.missing).toEqual([]);
    const excluded = await selectNotes({ goal: 'stakes', paths: ['Notes/Garden-link.md'], exclude_paths: ['Notes/Garden-link.md'] }, env);
    expect(excluded.candidates).toEqual([]);
    expect(excluded.excluded).toEqual([{ path: 'Notes/Garden-link.md', reason: 'path Notes/Garden-link.md (this request)' }]);
  });

  test('query selection never reads a path-excluded note, including through a symlink', async () => {
    process.env.VAULT_PATH = vaultPath;
    const read = spyOn(fs, 'readFile');
    try {
      const selection = await selectNotes({ goal: 'stakes', query: 'needle' }, env);
      expect(selection.candidates.map(n => n.path)).toEqual(['Notes/Draft.md', 'Notes/Garden.md']);
      const pathsRead = read.mock.calls.map(([file]) => String(file));
      expect(pathsRead.some(file => file.includes('/Journal/') || file.endsWith('/Journal-link.md'))).toBe(false);
    } finally {
      read.mockRestore();
    }
  });

  test('named notes within max_notes skip ranking and keep only relevant chunks', async () => {
    process.env.VAULT_PATH = vaultPath;
    const calls: unknown[] = [];
    const text = await runSemanticSearch({ goal: 'stakes', paths: ['Notes/Garden.md'] }, typesafe, {
      transport: scoringTransport('tomatoes', calls), sleep: noSleep, cache: fresh(), env,
    });
    expect(calls.map(stage).every(s => s === 'chunks')).toBe(true);
    expect(text).toContain('tomatoes need needle-thin stakes');
    expect(text).toMatch(/\[Notes\/Garden\.md:\d+-\d+ · p=0\.90\]/);
    // Overlap can repeat the matching line in a neighbouring chunk, so 1–2 chunks pass.
    const [, kept, total] = text.match(/kept (\d+) of (\d+) chunk/)!;
    expect(Number(kept)).toBeGreaterThanOrEqual(1);
    expect(Number(kept)).toBeLessThan(Number(total));
  });

  test('keeps unjudged chunks when requests fail', async () => {
    process.env.VAULT_PATH = vaultPath;
    const text = await runSemanticSearch({ goal: 'stakes', paths: ['Notes/Garden.md'] }, typesafe, {
      transport: async () => ({ status: 500, json: {} }), sleep: noSleep, cache: fresh(), env,
    });
    expect(text).toContain('Warning: ');
    const [, kept, total] = text.match(/kept (\d+) of (\d+) chunk/)!;
    expect(kept).toBe(total);
    expect(text).toContain('unjudged');
  });

  test('with no selection, ranks the whole vault, then skims the best notes', async () => {
    process.env.VAULT_PATH = vaultPath;
    const calls: unknown[] = [];
    const text = await runSemanticSearch({ goal: 'staking tomatoes' }, typesafe, {
      transport: scoringTransport('omato', calls), sleep: noSleep, cache: fresh(), env, maxNotes: 1,
    });
    expect(stage(calls[0])).toBe('notes');
    expect(calls.slice(1).every(c => stage(c) === 'chunks')).toBe(true);
    const sent = JSON.stringify(calls);
    expect(sent).not.toContain('journal');
    expect(sent).not.toContain('private note');
    expect(text).toContain('Ranked 3 note(s) (every note in the vault)');
    expect(text).toContain('1 relevant at p ≥ 0.5');
    expect(text).toContain('## Notes/Garden.md (p=0.90): kept');
    expect(text).toContain('Withheld 2 note(s) by exclusion rules.');
  });

  test('passages: false returns only the ranked notes', async () => {
    process.env.VAULT_PATH = vaultPath;
    const calls: unknown[] = [];
    const text = await runSemanticSearch({ goal: 'soup', folder: 'Notes' }, typesafe, {
      transport: scoringTransport('soup', calls), sleep: noSleep, cache: fresh(), env, passages: false,
    });
    expect(calls.map(stage)).toEqual(['notes']);
    expect(text).toContain('## Relevant notes\n- 0.90  Notes/Recipes.md: Weeknight soups');
    expect(text).not.toContain('chunk(s)');
  });

  test('reports the closest notes when none reach the threshold', async () => {
    process.env.VAULT_PATH = vaultPath;
    const text = await runSemanticSearch({ goal: 'astronomy', folder: 'Notes' }, typesafe, {
      transport: scoringTransport('nothing-matches'), sleep: noSleep, cache: fresh(), env, passages: false,
    });
    expect(text).toContain('0 relevant');
    expect(text).toContain('No note reached the threshold. Closest:');
  });

  test('repeat calls reuse cached judgments; an edited note is judged again', async () => {
    process.env.VAULT_PATH = vaultPath;
    const cache = fresh();
    const calls: unknown[] = [];
    const run = (goal: string) => runSemanticSearch({ goal, folder: 'Notes' }, typesafe, {
      transport: scoringTransport('soup', calls), sleep: noSleep, cache, env, passages: false,
    });
    await run('soup ideas');
    expect(calls.length).toBe(1);
    const repeat = await run('  Soup   IDEAS ');
    expect(calls.length).toBe(1);
    expect(repeat).toContain('3 judgment(s) reused from cache');

    await seed('Notes/Recipes.md', '---\ndescription: "Weeknight soups and stews"\n---\nLentils and stock.\n');
    const edited = await run('soup ideas');
    expect(calls.length).toBe(2);
    expect((calls[1] as any).state.notes.map((n: any) => n.source)).toEqual(['Notes/Recipes.md']);
    expect(edited).toContain('2 judgment(s) reused from cache');
  });

  test('tool runs without confirmation and never sends excluded notes, however they are named', async () => {
    process.env.VAULT_PATH = vaultPath;
    const previous = process.env.EXTERNAL_API_EXCLUDE_PATHS;
    process.env.EXTERNAL_API_EXCLUDE_PATHS = 'Journal';
    const calls: unknown[] = [];
    const client = await connect(scoringTransport('needle', calls));
    try {
      const result = await client.callTool({
        name: 'vault_search_semantic',
        arguments: {
          goal: 'needle',
          paths: ['Notes/Garden.md', './Journal/2026-10-11.md', 'Notes/../Journal/2026-10-11.md', 'Notes/Journal-link.md'],
        },
      }) as any;
      expect(result.isError).toBeFalsy();
      expect(calls.length).toBeGreaterThan(0);
      expect(JSON.stringify(calls)).not.toContain('needle in the journal');
      expect(result.content[0].text).toContain('Withheld 3 note(s) by exclusion rules.');
    } finally {
      await client.close();
      if (previous === undefined) delete process.env.EXTERNAL_API_EXCLUDE_PATHS;
      else process.env.EXTERNAL_API_EXCLUDE_PATHS = previous;
    }
  });

  test('tool rejects bad queries and missing folders without naming host paths', async () => {
    process.env.VAULT_PATH = vaultPath;
    const calls: unknown[] = [];
    const client = await connect(scoringTransport('tomatoes', calls));
    for (const query of ['(', 'a'.repeat(1001)]) {
      const result = await client.callTool({ name: 'vault_search_semantic', arguments: { goal: 'stakes', query } }) as any;
      expect(result.isError).toBe(true);
    }
    const missing = await client.callTool({ name: 'vault_search_semantic', arguments: { goal: 'stakes', folder: 'Nowhere' } }) as any;
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain('Folder not found: Nowhere');
    expect(missing.content[0].text).not.toContain(vaultPath);
    expect(calls.length).toBe(0);
    await client.close();
  });

  test('tool is not registered while SKIM_EXCLUDE_TAGS is set', async () => {
    const previous = process.env.SKIM_EXCLUDE_TAGS;
    process.env.SKIM_EXCLUDE_TAGS = 'private';
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const client = await connect(scoringTransport('x'));
      const { tools } = await client.listTools();
      expect(tools.map(t => t.name)).not.toContain('vault_search_semantic');
      expect(String(errors.mock.calls[0]?.[0])).toContain('SKIM_EXCLUDE_TAGS');
      await client.close();
    } finally {
      errors.mockRestore();
      if (previous === undefined) delete process.env.SKIM_EXCLUDE_TAGS;
      else process.env.SKIM_EXCLUDE_TAGS = previous;
    }
  });

  test('tool is not registered without a provider', async () => {
    const server = new McpServer({ name: 'semantic-test', version: '0' });
    registerSemanticSearchTool(server, { provider: null });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'semantic-test-client', version: '0' });
    await client.connect(clientSide);
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name)).not.toContain('vault_search_semantic');
    await client.close();
  });
});
