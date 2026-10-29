// ABOUTME: Registers vault_search_semantic when a local QMD server is configured: forwards the query to QMD's
// HTTP search endpoint for this vault's collection, then returns a result only when a note the access policy
// allows sits at the reported path and still holds the content QMD indexed.
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

// --- Readable notes --------------------------------------------------------------

// Every note the vault access policy lets this server read, keyed by the path QMD reports for it: the
// vault path with forward slashes. Built per search so a .mcpignore edit applies to the next call.
async function readableNotes(folder?: string): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  for (const relPath of await vault.listNotePaths(folder)) index.set(relPath.split("\\").join("/"), relPath);
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

// The note's content when it is what QMD indexed, so stale results are dropped; null otherwise.
async function contentHoldingDocid(relPath: string, docid: string | undefined): Promise<string | null> {
  const wanted = docid?.replace(/^#/, "").toLowerCase();
  if (!wanted || !/^[0-9a-f]{6}$/.test(wanted)) return null;
  let content: string;
  try {
    content = await vault.readNote(relPath);
  } catch (e) {
    if (vault.isVaultError(e)) return null;
    throw e;
  }
  return docidOf(content) === wanted ? content : null;
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

  const index = await readableNotes(request.folder);
  const items: SemanticSearchHit[] = [];
  for (const r of body.results ?? []) {
    const qmdPath = pathInCollection(r.file, config.collection);
    const relPath = qmdPath !== null ? index.get(qmdPath) : undefined;
    // Results the server can't vouch for are dropped without a trace. QMD indexes notes the access policy
    // hides, so any count or notice of dropped results would tell a client whether a hidden note contains
    // the searched words.
    if (relPath === undefined) continue;
    const content = await contentHoldingDocid(relPath, r.docid);
    if (content === null) continue;
    items.push({
      path: relPath,
      ...(typeof r.score === "number" ? { score: r.score } : {}),
      ...(Number.isInteger(r.line) ? { line: r.line } : {}),
      excerpt: excerptAt(content, r.line),
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
    const excerpt = r.excerpt ? `\n${r.excerpt.split("\n").map(l => `   ${l}`).join("\n")}` : "";
    return head + excerpt;
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
      // Blank text would match arbitrary notes, so it is refused before QMD is asked.
      const plain = query?.trim();
      const trimmed = searches?.map(s => ({ type: s.type, query: s.query.trim() }));
      const blank = trimmed?.findIndex(s => s.query === "") ?? -1;
      if (blank !== -1) {
        return { content: [{ type: "text" as const, text: `Error: searches[${blank}].query is blank. Give each sub-query some words.` }], isError: true };
      }
      const typed = trimmed ?? (plain ? [{ type: "lex" as const, query: plain }, { type: "vec" as const, query: plain }] : undefined);
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
