// ABOUTME: Decision-model client for vault_search_semantic. Resolves a provider (TypeSafe,
// OpenRouter, or OpenAI) from env, asks one yes/no question per item (a text chunk or a note card) in
// batched requests, and returns P(relevant) per item.

export type ProviderName = 'typesafe' | 'openrouter' | 'openai';

export interface DecisionProvider {
  name: ProviderName;
  label: 'TypeSafe' | 'OpenRouter' | 'OpenAI';
  endpoint: string;
  apiKey: string;
  model: string;
}

const PROVIDERS: Record<ProviderName, Omit<DecisionProvider, 'apiKey' | 'model'> & { keyVar: string; defaultModel: string }> = {
  typesafe: { name: 'typesafe', label: 'TypeSafe', endpoint: 'https://api.typesafe.ai/v1/systemone', keyVar: 'TYPESAFE_API_KEY', defaultModel: 'jev-latest' },
  openrouter: { name: 'openrouter', label: 'OpenRouter', endpoint: 'https://openrouter.ai/api/alpha/decisions', keyVar: 'OPENROUTER_API_KEY', defaultModel: 'typesafe/jev-1.13' },
  openai: { name: 'openai', label: 'OpenAI', endpoint: 'https://api.openai.com/v1/decisions', keyVar: 'OPENAI_API_KEY', defaultModel: 'gpt-6-luna' },
};

export function providerKeyVar(name: ProviderName): string {
  return PROVIDERS[name].keyVar;
}

const warnedConflicts = new Set<string>();

function decisionSetting(env: NodeJS.ProcessEnv, setting: 'PROVIDER' | 'MODEL'): string | undefined {
  const name = `DECISION_${setting}`;
  const alias = `SKIM_${setting}`;
  const normalize = (value: string | undefined) => setting === 'PROVIDER' ? value?.trim().toLowerCase() : value?.trim();
  const preferred = normalize(env[name]);
  const legacy = normalize(env[alias]);
  if (preferred && legacy && preferred !== legacy && !warnedConflicts.has(name)) {
    console.warn(`[obsidian-remote-mcp] ${name} and ${alias} differ; using ${name}.`);
    warnedConflicts.add(name);
  }
  return preferred || legacy;
}

// DECISION_PROVIDER picks the provider (default typesafe); its standard key variable supplies the key and
// DECISION_MODEL optionally overrides its default model. SKIM_PROVIDER and SKIM_MODEL are fallback aliases.
// Returns null when the provider's key is unset, which leaves vault_search_semantic unregistered. An unknown provider
// throws so a typo fails loudly, including when a valid alias is set.
export function resolveDecisionProvider(env: NodeJS.ProcessEnv = process.env): DecisionProvider | null {
  const raw = decisionSetting(env, 'PROVIDER') || 'typesafe';
  if (!Object.hasOwn(PROVIDERS, raw)) {
    throw new Error(`DECISION_PROVIDER (or legacy SKIM_PROVIDER) must be one of ${Object.keys(PROVIDERS).join(', ')} (got "${raw}").`);
  }
  const spec = PROVIDERS[raw as ProviderName];
  const apiKey = env[spec.keyVar]?.trim();
  if (!apiKey) return null;
  const { keyVar: _keyVar, defaultModel, ...identity } = spec;
  return { ...identity, apiKey, model: decisionSetting(env, 'MODEL') || defaultModel };
}

// --- Requests ------------------------------------------------------------------

export interface JudgeItem {
  source: string; // vault-relative note path
  lines?: string; // "start-end", for chunks
  text: string;
}

// What is being judged and how. Items sit in the request state under `collection`, each with an id
// `${kind}_${index}`; every question names one id. With `criteriaInState`, the criteria travel once per
// request in the state instead of inside every question, which matters when items are short.
export interface JudgePrompt {
  kind: string;
  collection: string;
  question: (id: string) => string;
  criteria: { true: string; false: string };
  criteriaInState: boolean;
  maxItemsPerBatch: number;
  overheadBytes: number; // per-item question and JSON envelope, for batch sizing
}

export const CHUNK_PROMPT: JudgePrompt = {
  kind: 'chunk',
  collection: 'chunks',
  question: id => `Would chunk \`${id}\` in \`chunks\` help someone accomplish \`goal\`? Judge only that one chunk.`,
  criteria: {
    true: 'The chunk itself carries substance that bears on the goal: facts, decisions, reflections, plans, steps, names, dates, numbers, or reasoning the reader would otherwise have to go read.',
    false: 'Boilerplate (bare frontmatter, navigation, link lists, empty template sections), passages about a different topic, or a chunk that only mentions a keyword from the goal without saying anything useful about it.',
  },
  criteriaInState: false,
  maxItemsPerBatch: 24,
  overheadBytes: 600,
};

const itemId = (prompt: JudgePrompt, index: number) => `${prompt.kind}_${index}`;

// TypeSafe and OpenRouter take System One requests (a state plus keyed `noul` questions); OpenAI
// takes a flat input string plus named `predicate` questions.
export function buildRequest(provider: DecisionProvider, goal: string, items: JudgeItem[], prompt: JudgePrompt = CHUNK_PROMPT): unknown {
  const state: Record<string, unknown> = {
    goal,
    [prompt.collection]: items.map((item, i) => ({
      id: itemId(prompt, i),
      source: item.source,
      ...(item.lines !== undefined ? { lines: item.lines } : {}),
      text: item.text,
    })),
  };
  if (prompt.criteriaInState) state.criteria = prompt.criteria;
  const ids = items.map((_, i) => itemId(prompt, i));
  const instructions = (id: string) => ({ question: prompt.question(id), [prompt.kind]: id });
  if (provider.name === 'openai') {
    return {
      model: provider.model,
      input: JSON.stringify(state),
      questions: ids.map(id => ({
        type: 'predicate',
        name: id,
        instructions: prompt.criteriaInState
          ? prompt.question(id)
          : `${prompt.question(id)}\nTrue: ${prompt.criteria.true}\nFalse: ${prompt.criteria.false}`,
      })),
    };
  }
  return {
    model: provider.model,
    state,
    questions: Object.fromEntries(ids.map(id => [id, {
      type: 'noul',
      instructions: instructions(id),
      ...(prompt.criteriaInState ? {} : { criteria: prompt.criteria }),
    }])),
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isProbability = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;

// Per-item P(relevant), in request order. A missing or malformed answer is null (unjudged) rather
// than a guess, so the caller can keep that item.
export function parseAnswers(provider: DecisionProvider, response: unknown, count: number, prompt: JudgePrompt = CHUNK_PROMPT): (number | null)[] {
  const out: (number | null)[] = Array(count).fill(null);
  if (!isRecord(response)) return out;
  if (provider.name === 'openai') {
    if (!Array.isArray(response.answers)) return out;
    for (const answer of response.answers) {
      if (!isRecord(answer) || answer.type !== 'predicate' || typeof answer.name !== 'string') continue;
      const index = Number(answer.name.replace(`${prompt.kind}_`, ''));
      if (Number.isInteger(index) && index >= 0 && index < count && isProbability(answer.probability)) out[index] = answer.probability;
    }
    return out;
  }
  if (!isRecord(response.answers)) return out;
  for (let i = 0; i < count; i++) {
    const answer = response.answers[itemId(prompt, i)];
    if (isRecord(answer) && answer.type === 'noul' && isProbability(answer.noul)) out[i] = answer.noul;
  }
  return out;
}

// --- Transport and retries --------------------------------------------------------

export interface HttpResponse {
  status: number;
  json: unknown;
  retryAfter?: string;
}

export type Transport = (endpoint: string, apiKey: string, body: unknown, signal: AbortSignal) => Promise<HttpResponse>;

export const fetchTransport: Transport = async (endpoint, apiKey, body, signal) => {
  const response = await fetch(endpoint, {
    method: 'POST',
    signal,
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    json = undefined;
  }
  return { status: response.status, json, retryAfter: response.headers.get('retry-after') ?? undefined };
};

export type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// The provider's own question-count cap, read only from an explicit validation error
// ("List should have at most N items" on body.questions) — never inferred from an arbitrary 4xx.
export function questionLimit(value: unknown, depth = 0): number | undefined {
  if (depth > 3 || !isRecord(value)) return undefined;
  if (Array.isArray(value.detail)) {
    for (const item of value.detail) {
      if (!isRecord(item) || item.type !== 'too_long' || !Array.isArray(item.loc)
        || item.loc.join('.') !== 'body.questions' || typeof item.msg !== 'string') continue;
      const match = item.msg.match(/^(?:Dictionary|List) should have at most (\d+) items after validation/);
      const limit = match ? Number(match[1]) : undefined;
      if (limit && Number.isSafeInteger(limit)) return limit;
    }
  }
  if (isRecord(value.error)) return questionLimit(value.error, depth + 1);
  return undefined;
}

class QuestionLimitError extends Error {
  constructor(public readonly limit: number) {
    super(`accepts at most ${limit} questions per request`);
  }
}

const STATUS_MESSAGES: Record<number, string> = {
  400: 'rejected the request; check the model',
  401: 'rejected the API key',
  402: 'needs more credits on the account',
  403: 'refused access to the model',
  404: 'could not find the model',
  422: 'rejected the request; check the model',
  429: 'rate limit reached',
};

const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 60_000;

async function evaluate(provider: DecisionProvider, body: unknown, transport: Transport, sleep: Sleep): Promise<unknown> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let result: HttpResponse;
    try {
      result = await transport(provider.endpoint, provider.apiKey, body, AbortSignal.timeout(REQUEST_TIMEOUT_MS));
    } catch (e) {
      throw new Error(`${provider.label} could not be reached (${e instanceof Error ? e.message : String(e)})`);
    }
    if (result.status >= 200 && result.status < 300) return result.json;
    if ((result.status === 429 || (result.status >= 500 && result.status < 600)) && attempt < MAX_ATTEMPTS - 1) {
      const seconds = Number(result.retryAfter);
      const wait = Number.isFinite(seconds) ? seconds * 1000 : 1000 * 2 ** attempt;
      if (wait > 30_000) break;
      await sleep(wait);
      continue;
    }
    const limit = [400, 422].includes(result.status) ? questionLimit(result.json) : undefined;
    if (limit) throw new QuestionLimitError(limit);
    throw new Error(`${provider.label} ${STATUS_MESSAGES[result.status] ?? `request failed (HTTP ${result.status})`}`);
  }
  throw new Error(`${provider.label} is busy; try again shortly`);
}

// --- Batching ---------------------------------------------------------------------

// Each item's text sits in the request state, so requests are packed by size as well as count.
// Byte bounds are deliberately conservative, not a tokenizer.
export const MAX_ITEMS_PER_BATCH = CHUNK_PROMPT.maxItemsPerBatch;
export const MAX_BATCH_BYTES = 50_000;
const CONCURRENCY = 4;

export function planBatches(items: JudgeItem[], prompt: JudgePrompt = CHUNK_PROMPT): number[][] {
  const encoder = new TextEncoder();
  const batches: number[][] = [];
  let current: number[] = [];
  let bytes = 0;
  items.forEach((item, index) => {
    const size = encoder.encode(item.text).length + prompt.overheadBytes;
    if (current.length > 0 && (current.length >= prompt.maxItemsPerBatch || bytes + size > MAX_BATCH_BYTES)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(index);
    bytes += size;
  });
  if (current.length > 0) batches.push(current);
  return batches;
}

export interface Judgement {
  probabilities: (number | null)[]; // per item, in input order; null = unjudged
  failures: string[];               // one message per failed batch
  requests: number;
}

export interface JudgeOptions {
  transport?: Transport;
  sleep?: Sleep;
}

export function judgeChunks(
  provider: DecisionProvider,
  goal: string,
  items: JudgeItem[],
  options: JudgeOptions = {},
): Promise<Judgement> {
  return judgeItems(provider, goal, items, CHUNK_PROMPT, options);
}

export async function judgeItems(
  provider: DecisionProvider,
  goal: string,
  items: JudgeItem[],
  prompt: JudgePrompt,
  options: JudgeOptions = {},
): Promise<Judgement> {
  const { transport = fetchTransport, sleep = realSleep } = options;
  const probabilities: (number | null)[] = Array(items.length).fill(null);
  const failures: string[] = [];
  let requests = 0;

  const queue = planBatches(items, prompt).map(indexes => ({ indexes, splits: 0 }));

  async function runBatch(indexes: number[], splits = 0): Promise<void> {
    const batchItems = indexes.map(i => items[i]!);
    try {
      requests++;
      const response = await evaluate(provider, buildRequest(provider, goal, batchItems, prompt), transport, sleep);
      parseAnswers(provider, response, indexes.length, prompt).forEach((p, j) => {
        probabilities[indexes[j]!] = p;
      });
    } catch (e) {
      if (e instanceof QuestionLimitError && e.limit < indexes.length && splits < 3) {
        // Split work returns to the same queue, so it cannot bypass the worker bound.
        for (let start = 0; start < indexes.length; start += e.limit) {
          queue.push({ indexes: indexes.slice(start, start + e.limit), splits: splits + 1 });
        }
        return;
      }
      failures.push(e instanceof Error ? e.message : String(e));
    }
  }

  let next = 0;
  async function worker(): Promise<void> {
    while (next < queue.length) {
      const batch = queue[next++]!;
      await runBatch(batch.indexes, batch.splits);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));

  return { probabilities, failures, requests };
}
