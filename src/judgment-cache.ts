// ABOUTME: Persisted cache of decision-model judgments for vault_skim. Keys hash everything that shapes an
// answer (provider, model, prompt, goal, and the exact text judged), so a repeat costs nothing and an
// edited note is re-judged. Stores only hashes and probabilities, never note text.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  judgeItems,
  type DecisionProvider,
  type JudgeItem,
  type JudgeOptions,
  type JudgePrompt,
  type Judgement,
} from './decision.js';

// Bump when a prompt's question or criteria wording changes, so answers to the old wording are not reused.
const PROMPT_VERSION = 1;
const TTL_MS = 90 * 86_400_000;
const MAX_ENTRIES = 200_000;

interface CacheFile {
  version: 1;
  judgments: Record<string, [number, number]>; // key → [probability, saved-at epoch ms]
}

export class JudgmentCache {
  private data: CacheFile | null = null;
  private loading: Promise<void> | null = null;
  private saving: Promise<void> = Promise.resolve();
  private dirty = false;

  // filePath null keeps the cache in memory only.
  constructor(private readonly filePath: string | null) {}

  private async load(): Promise<CacheFile> {
    if (this.data) return this.data;
    this.loading ??= (async () => {
      if (this.filePath) {
        try {
          const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf-8'));
          if (parsed?.version === 1 && parsed.judgments && typeof parsed.judgments === 'object') {
            this.data = parsed as CacheFile;
            return;
          }
        } catch {
          // Missing or unreadable: start empty.
        }
      }
      this.data = { version: 1, judgments: {} };
    })();
    await this.loading;
    return this.data!;
  }

  async get(key: string): Promise<number | undefined> {
    const entry = (await this.load()).judgments[key];
    if (!entry || Date.now() - entry[1] > TTL_MS) return undefined;
    return entry[0];
  }

  async set(key: string, probability: number): Promise<void> {
    (await this.load()).judgments[key] = [probability, Date.now()];
    this.dirty = true;
  }

  // Prunes expired and excess entries, then writes atomically. Saves are serialized so concurrent
  // calls never interleave partial files. A failed save only costs future cache hits.
  async save(): Promise<void> {
    if (!this.filePath || !this.dirty) return;
    const filePath = this.filePath;
    const data = await this.load();
    this.dirty = false;
    this.saving = this.saving.then(async () => {
      const cutoff = Date.now() - TTL_MS;
      let entries = Object.entries(data.judgments).filter(([, [, savedAt]]) => savedAt >= cutoff);
      if (entries.length > MAX_ENTRIES) entries = entries.sort((a, b) => b[1][1] - a[1][1]).slice(0, MAX_ENTRIES);
      data.judgments = Object.fromEntries(entries);
      const tmp = `${filePath}.${process.pid}.tmp`;
      await fs.mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
      await fs.writeFile(tmp, JSON.stringify(data), 'utf-8');
      await fs.rename(tmp, filePath);
    }).catch(() => {});
    await this.saving;
  }
}

const caches = new Map<string, JudgmentCache>();

// SKIM_CACHE_PATH sets the file (default ./skim-cache.json); "off" disables persistence. Tests keep
// the cache in memory unless they set a path.
export function judgmentCacheFromEnv(env: NodeJS.ProcessEnv = process.env): JudgmentCache {
  const configured = env.SKIM_CACHE_PATH?.trim();
  const filePath = configured === 'off' ? null
    : configured ? path.resolve(configured)
    : env.VAULT_MCP_TEST === '1' ? null
    : path.resolve('./skim-cache.json');
  const key = filePath ?? ':memory:';
  let cache = caches.get(key);
  if (!cache) {
    cache = new JudgmentCache(filePath);
    caches.set(key, cache);
  }
  return cache;
}

export const normalizeGoal = (goal: string) => goal.trim().replace(/\s+/g, ' ').toLowerCase();

function cacheKey(provider: DecisionProvider, prompt: JudgePrompt, goal: string, item: JudgeItem): string {
  return createHash('sha256')
    .update(JSON.stringify([provider.name, provider.model, prompt.kind, PROMPT_VERSION, normalizeGoal(goal), item.source, item.text]))
    .digest('hex');
}

export interface CachedJudgement extends Judgement {
  fromCache: number;
}

// judgeItems, answering from the cache where it can. Unjudged answers are never cached.
export async function judgeWithCache(
  provider: DecisionProvider,
  goal: string,
  items: JudgeItem[],
  prompt: JudgePrompt,
  cache: JudgmentCache,
  options: JudgeOptions = {},
): Promise<CachedJudgement> {
  const keys = items.map(item => cacheKey(provider, prompt, goal, item));
  const probabilities: (number | null)[] = Array(items.length).fill(null);
  const pending: number[] = [];
  for (let i = 0; i < items.length; i++) {
    const hit = await cache.get(keys[i]!);
    if (hit === undefined) pending.push(i);
    else probabilities[i] = hit;
  }
  if (pending.length === 0) return { probabilities, failures: [], requests: 0, fromCache: items.length };

  const fresh = await judgeItems(provider, goal, pending.map(i => items[i]!), prompt, options);
  for (let j = 0; j < pending.length; j++) {
    const p = fresh.probabilities[j];
    if (p === null || p === undefined) continue;
    probabilities[pending[j]!] = p;
    await cache.set(keys[pending[j]!]!, p);
  }
  await cache.save();
  return { probabilities, failures: fresh.failures, requests: fresh.requests, fromCache: items.length - pending.length };
}
