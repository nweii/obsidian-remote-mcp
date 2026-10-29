// ABOUTME: Registers vault_semantic_search when a local QMD server is configured: forwards the query to QMD's
// HTTP search endpoint for this vault's collection, then maps QMD's normalized paths back to vault paths and
// returns a result only when a note the access policy allows holds the exact content QMD indexed.
import type { McpServer } from "@modelcontextprotocol/server";
import { createHash } from "node:crypto";
import { z } from "zod";
import * as vault from "./vault.js";
import { registerLogged } from "./log.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

export interface QmdConfig {
  url: string;
  collection: string;
  timeoutMs: number;
}

// The tool needs both settings: without QMD_COLLECTION a search could return documents from other
// collections on the same QMD index, which are outside this vault.
export function loadQmdConfig(env: NodeJS.ProcessEnv = process.env): QmdConfig | null {
  const url = env.QMD_URL?.trim();
  if (!url) return null;
  const collection = env.QMD_COLLECTION?.trim();
  if (!collection) {
    console.error("[obsidian-remote-mcp] QMD_URL is set but QMD_COLLECTION is not; vault_semantic_search is disabled.");
    return null;
  }
  const timeout = Number(env.QMD_TIMEOUT_MS);
  return {
    url: url.replace(/\/+$/, ""),
    collection,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS,
  };
}

// --- QMD's path normalization ------------------------------------------------------

// QMD stores each document under a normalized path ("handelize" in QMD's store.js): emoji become hex
// code points, runs of anything but letters, numbers and "$" become "-", and "___" becomes a folder
// separator. Results carry that form, so the vault's real paths are normalized the same way to match.
function emojiToHex(segment: string): string {
  return segment.replace(/(?:\p{So}\p{Mn}?|\p{Sk})+/gu, run =>
    [...run].filter(c => /\p{So}|\p{Sk}/u.test(c)).map(c => c.codePointAt(0)!.toString(16)).join("-"));
}

export function qmdPath(relPath: string): string | null {
  const segments = relPath.replace(/___/g, "/").split("/");
  const cleaned = segments.map((raw, i) => {
    const segment = emojiToHex(raw);
    const isFile = i === segments.length - 1;
    const ext = isFile ? (segment.match(/(\.[a-z0-9]+)$/i)?.[1] ?? "") : "";
    const name = ext ? segment.slice(0, -ext.length) : segment;
    return name.replace(/[^\p{L}\p{N}$]+/gu, "-").replace(/^-+|-+$/g, "") + ext;
  }).filter(Boolean).join("/");
  return cleaned || null;
}

// Every note the vault access policy lets this server read, keyed by its QMD path. Built per search
// so a .mcpignore edit applies to the next call. Distinct notes can share a QMD path; all are kept.
async function notesByQmdPath(): Promise<Map<string, string[]>> {
  const index = new Map<string, string[]>();
  for (const relPath of await vault.listNotePaths()) {
    const key = qmdPath(relPath.split("\\").join("/"));
    if (!key) continue;
    const existing = index.get(key);
    if (existing) existing.push(relPath);
    else index.set(key, [relPath]);
  }
  return index;
}

// --- Search -----------------------------------------------------------------------

export interface QmdSearch {
  type: "lex" | "vec" | "hyde";
  query: string;
}

export interface SemanticSearchRequest {
  searches: QmdSearch[];
  limit: number;
  intent?: string;
  rerank?: boolean;
}

interface QmdResult {
  docid?: string;
  file: string;
  title?: string;
  score?: number;
  line?: number;
  snippet?: string;
}

export interface SemanticSearchHit {
  path: string;
  // Other readable notes at the same QMD path with identical content.
  also?: string[];
  title?: string;
  score?: number;
  line?: number;
  snippet?: string;
}

export interface SemanticSearchResult {
  results: SemanticSearchHit[];
  // Results this server can't vouch for: from notes it can't read (hidden, excluded by .mcpignore, gone),
  // or from content that no readable note holds any more.
  withheld: number;
}

// QMD's docid is the first 6 hex characters of the SHA-256 of the indexed content.
function docidOf(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 6);
}

// The readable notes at this QMD path whose current content is what QMD indexed. A path match alone
// isn't enough: an excluded note can normalize to the same QMD path as a readable one, and the result's
// snippet would then come from the excluded note.
async function notesHoldingDocid(paths: string[], docid: string | undefined): Promise<string[]> {
  const wanted = docid?.replace(/^#/, "").toLowerCase();
  if (!wanted || !/^[0-9a-f]{6}$/.test(wanted)) return [];
  const matches: string[] = [];
  for (const relPath of paths) {
    let content: string;
    try {
      content = await vault.readNote(relPath);
    } catch (e) {
      if (vault.isVaultError(e)) continue;
      throw e;
    }
    if (docidOf(content) === wanted) matches.push(relPath);
  }
  return matches;
}

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export async function semanticSearch(
  config: QmdConfig,
  request: SemanticSearchRequest,
  fetcher: Fetcher = fetch,
): Promise<SemanticSearchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  let body: { results?: QmdResult[] };
  try {
    const res = await fetcher(`${config.url}/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        searches: request.searches,
        collections: [config.collection],
        limit: request.limit,
        intent: request.intent,
        rerank: request.rerank,
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`QMD returned HTTP ${res.status}`);
    body = await res.json() as { results?: QmdResult[] };
  } catch (e) {
    if (controller.signal.aborted) throw new Error(`QMD did not answer within ${config.timeoutMs} ms`);
    throw new Error(`QMD search failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
  }

  const prefix = `${config.collection}/`;
  const index = await notesByQmdPath();
  const results: SemanticSearchHit[] = [];
  let withheld = 0;
  for (const r of body.results ?? []) {
    const candidates = typeof r.file === "string" && r.file.startsWith(prefix) ? index.get(r.file.slice(prefix.length)) : undefined;
    const paths = candidates ? await notesHoldingDocid(candidates, r.docid) : [];
    if (paths.length === 0) {
      withheld++;
      continue;
    }
    const [first, ...rest] = paths as [string, ...string[]];
    results.push({
      path: first,
      ...(rest.length ? { also: rest } : {}),
      title: r.title,
      score: r.score,
      line: r.line,
      snippet: r.snippet,
    });
  }
  return { results, withheld };
}

function formatResults({ results, withheld }: SemanticSearchResult): string {
  const lines = results.map((r, i) => {
    const head = `${i + 1}. ${r.path}${r.line ? `:${r.line}` : ""}${r.score !== undefined ? ` (score ${r.score})` : ""}`;
    const also = r.also ? `\n   Same content at: ${r.also.join(", ")}` : "";
    const snippet = r.snippet ? `\n${r.snippet.split("\n").map(l => `   ${l}`).join("\n")}` : "";
    return head + also + snippet;
  });
  const note = withheld ? `\n\n${withheld} result(s) withheld: from notes this server can't read, or changed since QMD indexed them.` : "";
  return (lines.length ? lines.join("\n\n") : "No results.") + note;
}

// --- Registration --------------------------------------------------------------------

export function registerQmdTool(server: McpServer, options: { config?: QmdConfig | null; fetcher?: Fetcher } = {}) {
  const config = options.config !== undefined ? options.config : loadQmdConfig();
  if (!config) return;

  registerLogged(server,
    "vault_semantic_search",
    {
      annotations: { readOnlyHint: true, openWorldHint: false },
      title: "Search notes by meaning",
      description:
        "Search the vault through its QMD index, combining keyword (BM25) and semantic (vector) retrieval with reranking. " +
        "Use it when the wording in the notes is unknown or a concept matters more than exact terms; use vault_search_content for exact text or regex. " +
        "Each search is a typed sub-query: lex = keywords (supports \"quoted phrases\" and -negation), vec = a natural-language question, hyde = a 50-100 word passage that reads like the answer. " +
        "The first sub-query weighs double. lex + vec gives the best recall. " +
        "Results are vault paths with the best-matching line and a snippet; read more with vault_read or vault_read_section.",
      inputSchema: z.object({
        searches: z.array(z.object({
          type: z.enum(["lex", "vec", "hyde"]),
          query: z.string().min(1),
        })).min(1).max(10).describe("Typed sub-queries. The first gets twice the weight."),
        limit: z.number().int().min(1).max(MAX_LIMIT).optional().default(DEFAULT_LIMIT).describe(`Max results (default ${DEFAULT_LIMIT}, up to ${MAX_LIMIT}).`),
        intent: z.string().optional().describe("Background that disambiguates the query without being searched itself."),
        rerank: z.boolean().optional().describe("Rerank with QMD's model (QMD's default: on). Off is faster."),
      }),
    },
    async ({ searches, limit, intent, rerank }) => {
      try {
        const result = await semanticSearch(config, { searches, limit, intent, rerank }, options.fetcher);
        return { content: [{ type: "text" as const, text: formatResults(result) }] };
      } catch (e) {
        if (vault.isVaultError(e)) return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    },
  );
}
