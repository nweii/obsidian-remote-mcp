// ABOUTME: Registers vault_search_semantic when a local QMD server is configured: forwards the query to QMD's
// HTTP search endpoint for this vault's collection, then maps QMD's normalized paths back to vault paths and
// returns a result only when a note the access policy allows holds the exact content QMD indexed.
import type { McpServer } from "@modelcontextprotocol/server";
import { createHash } from "node:crypto";
import { z } from "zod";
import * as vault from "./vault.js";
import { structuredResult } from "mcp-server-kit";
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
    console.error("[obsidian-remote-mcp] QMD_URL is set but QMD_COLLECTION is not; vault_search_semantic is disabled.");
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

// QMD 2.5 and earlier stored each document under a normalized path ("handelize" in QMD's store.js):
// emoji become hex code points, runs of anything but letters, numbers and "$" become "-", and "___"
// becomes a folder separator. Their results carry that form, so vault paths are normalized the same way.
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

// Every note the vault access policy lets this server read, keyed by each path QMD may report for it:
// the vault path itself, which current QMD releases index, and the normalized form older releases
// indexed. Built per search so a .mcpignore edit applies to the next call. Distinct notes can share a
// key; all are kept, and content verification picks among them.
async function notesByQmdPath(folder?: string): Promise<Map<string, string[]>> {
  const index = new Map<string, string[]>();
  const add = (key: string, relPath: string) => {
    const existing = index.get(key);
    if (!existing) index.set(key, [relPath]);
    else if (!existing.includes(relPath)) existing.push(relPath);
  };
  for (const relPath of await vault.listNotePaths(folder)) {
    const posix = relPath.split("\\").join("/");
    add(posix, relPath);
    const normalized = qmdPath(posix);
    if (normalized) add(normalized, relPath);
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
  // Vault-relative folder; results outside it are dropped.
  folder?: string;
}

interface QmdResult {
  docid?: string;
  file: string;
  score?: number;
  line?: number;
}

// Passed both as the tool's outputSchema and to structuredResult, so the declared contract and the
// returned payload can't drift apart.
const semanticSearchOutput = z.object({
  items: z.array(z.object({
    path: z.string().describe("Vault-relative path of the matching note"),
    also: z.array(z.string()).optional().describe("Other readable notes at the same QMD path with identical content"),
    score: z.number().optional(),
    line: z.number().optional().describe("The best-matching line"),
    excerpt: z.string().describe("That line and the lines after it, numbered, read from the note itself"),
  })),
});

export type SemanticSearchResult = z.infer<typeof semanticSearchOutput>;
type SemanticSearchHit = SemanticSearchResult["items"][number];

// QMD's docid is the first 6 hex characters of the SHA-256 of the indexed content.
function docidOf(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 6);
}

// The readable notes at this QMD path whose current content is what QMD indexed, so stale results are
// dropped. Six hex characters can collide, so nothing QMD returns about the document's text (title,
// snippet) is passed on: an excluded note can share a readable note's QMD path, and its text would leak.
async function notesHoldingDocid(paths: string[], docid: string | undefined): Promise<{ path: string; content: string }[]> {
  const wanted = docid?.replace(/^#/, "").toLowerCase();
  if (!wanted || !/^[0-9a-f]{6}$/.test(wanted)) return [];
  const matches: { path: string; content: string }[] = [];
  for (const relPath of paths) {
    let content: string;
    try {
      content = await vault.readNote(relPath);
    } catch (e) {
      if (vault.isVaultError(e)) continue;
      throw e;
    }
    if (docidOf(content) === wanted) matches.push({ path: relPath, content });
  }
  return matches;
}

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

// A failure talking to QMD. Its message is written here, never copied from the filesystem.
export class QmdError extends Error {}

// QMD reports a result's file as "collection/path", or, in newer releases, as a qmd:// URI with each
// segment percent-encoded. Returns the path within the collection, or null for another collection.
export function pathInCollection(file: unknown, collection: string): string | null {
  if (typeof file !== "string") return null;
  let display = file;
  if (display.startsWith("qmd://")) {
    try {
      display = display.slice("qmd://".length).split("/").map(decodeURIComponent).join("/");
    } catch {
      return null;
    }
  }
  const prefix = `${collection}/`;
  return display.startsWith(prefix) ? display.slice(prefix.length) : null;
}

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
    if (!res.ok) throw new QmdError(`QMD returned HTTP ${res.status}`);
    body = await res.json() as { results?: QmdResult[] };
  } catch (e) {
    if (e instanceof QmdError) throw e;
    if (controller.signal.aborted) throw new QmdError(`QMD did not answer within ${config.timeoutMs} ms`);
    throw new QmdError(`QMD search failed: could not reach ${config.url} or read its response`);
  } finally {
    clearTimeout(timer);
  }

  const index = await notesByQmdPath(request.folder);
  const items: SemanticSearchHit[] = [];
  for (const r of body.results ?? []) {
    const relPath = pathInCollection(r.file, config.collection);
    const candidates = relPath !== null ? index.get(relPath) : undefined;
    // Results the server can't vouch for are dropped without a trace. QMD indexes notes the access policy
    // hides, and a hidden note can share a QMD path with a readable one, so any count or notice of dropped
    // results would tell a client whether a hidden note contains the searched words.
    if (!candidates) continue;
    const notes = await notesHoldingDocid(candidates, r.docid);
    if (notes.length === 0) continue;
    const [first, ...rest] = notes as [{ path: string; content: string }, ...{ path: string; content: string }[]];
    items.push({
      path: first.path,
      ...(rest.length ? { also: rest.map(n => n.path) } : {}),
      ...(typeof r.score === "number" ? { score: r.score } : {}),
      ...(Number.isInteger(r.line) ? { line: r.line } : {}),
      excerpt: excerptAt(first.content, r.line),
    });
  }
  return { items };
}

const EXCERPT_LINES = 3;

// The line QMD matched and the two after it, numbered, from content this server read itself.
function excerptAt(content: string, line: number | undefined): string {
  const lines = content.split("\n");
  const start = Number.isInteger(line) && line! >= 1 && line! <= lines.length ? line! - 1 : 0;
  return lines.slice(start, start + EXCERPT_LINES).map((text, i) => `${start + i + 1}: ${text}`).join("\n");
}

function formatResults({ items }: SemanticSearchResult): string {
  const lines = items.map((r, i) => {
    const head = `${i + 1}. ${r.path}${r.line ? `:${r.line}` : ""}${r.score !== undefined ? ` (score ${r.score})` : ""}`;
    const also = r.also ? `\n   Same content at: ${r.also.join(", ")}` : "";
    const excerpt = r.excerpt ? `\n${r.excerpt.split("\n").map(l => `   ${l}`).join("\n")}` : "";
    return head + also + excerpt;
  });
  return lines.length ? lines.join("\n\n") : "No results.";
}

// --- Registration --------------------------------------------------------------------

// The server builds a fresh McpServer per request; reading the config and its log line happen once.
let configOnce: QmdConfig | null | undefined;

export function registerQmdTool(server: McpServer, options: { config?: QmdConfig | null; fetcher?: Fetcher } = {}) {
  if (options.config === undefined && configOnce === undefined) configOnce = loadQmdConfig();
  const config = options.config !== undefined ? options.config : configOnce;
  if (!config) return;

  registerLogged(server,
    "vault_search_semantic",
    {
      annotations: { readOnlyHint: true, openWorldHint: false },
      title: "Search notes by meaning",
      description:
        "Find notes by meaning through the vault's QMD index, which combines keyword and vector retrieval with reranking. " +
        "Use it when the wording in the notes is unknown or a concept matters more than exact terms. Use vault_search_content for exact text or regex, and vault_skim to pull passages from notes already chosen. " +
        "Pass query for most searches. For finer control, pass searches instead: typed sub-queries where lex = keywords (supports \"quoted phrases\" and -negation), vec = a natural-language question, hyde = a 50-100 word passage that reads like the answer; the first weighs double. " +
        "Results are vault paths with the best-matching line and the lines after it; read more with vault_read or vault_read_section.",
      inputSchema: z.object({
        query: z.string().min(1).optional().describe("What to look for, in words. Searched as keywords and as a question."),
        searches: z.array(z.object({
          type: z.enum(["lex", "vec", "hyde"]),
          query: z.string().min(1),
        })).min(1).max(10).optional().describe("Typed sub-queries, used instead of query. The first gets twice the weight."),
        folder: z.string().optional().describe('Only return notes in this folder (e.g. "02-Notes"). Applied after QMD ranks, so a narrow folder can return fewer results than limit.'),
        limit: z.number().int().min(1).max(MAX_LIMIT).optional().default(DEFAULT_LIMIT).describe(`Max results (default ${DEFAULT_LIMIT}, up to ${MAX_LIMIT}).`),
        intent: z.string().optional().describe("Background that disambiguates the query without being searched itself."),
        rerank: z.boolean().optional().describe("Rerank with QMD's model (QMD's default: on). Off is faster."),
      }),
      outputSchema: semanticSearchOutput,
    },
    async ({ query, searches, folder, limit, intent, rerank }) => {
      const typed = searches ?? (query ? [{ type: "lex" as const, query }, { type: "vec" as const, query }] : undefined);
      if (!typed) return { content: [{ type: "text" as const, text: "Error: pass query or searches." }], isError: true };
      try {
        const result = await semanticSearch(config, { searches: typed, limit, intent, rerank, folder }, options.fetcher);
        return structuredResult(semanticSearchOutput, result, formatResults);
      } catch (e) {
        // QMD failures and vault errors carry messages written for the caller; anything else propagates.
        if (e instanceof QmdError || vault.isVaultError(e)) {
          return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
        }
        throw e;
      }
    },
  );
}
