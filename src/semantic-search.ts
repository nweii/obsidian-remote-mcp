// ABOUTME: Registers vault_search_semantic, which finds notes by meaning through a decision model: it ranks
// candidate notes from short note cards, then returns only the passages of the best notes that bear on a
// goal. Judgments are cached. Notes under the external-API exclusions, or excluded per call, are never sent.

import type { McpServer } from "@modelcontextprotocol/server";
import path from "node:path";
import { z } from "zod";
import * as vault from "./vault.js";
import { chunkText, type Chunk } from "./chunk.js";
import { CHUNK_PROMPT, resolveDecisionProvider, type DecisionProvider, type JudgeOptions, type JudgePrompt } from "./decision.js";
import { parseFrontmatter, splitFrontmatter } from "./frontmatter.js";
import { contentExclusion, exclusionRules, pathExclusion } from "./api-exclusions.js";
import { judgeWithCache, judgmentCacheFromEnv, type JudgmentCache } from "./judgment-cache.js";
import { registerLogged } from "./log.js";

export const DEFAULT_MAX_NOTES = 10;
export const MAX_NOTES_CAP = 100;
export const MAX_CHUNKS = 500;
export const MAX_CANDIDATES = 20_000;
export const DEFAULT_THRESHOLD = 0.5;
const EXCLUDED_DISPLAY_LIMIT = 20;
const OTHER_RELEVANT_LIMIT = 20;
const EXCERPT_CHARS = 400;

// --- Selection --------------------------------------------------------------------

export interface SemanticSearchRequest {
  goal: string;
  paths?: string[];
  folder?: string;
  query?: string;
  exclude_tags?: string[];
  exclude_paths?: string[];
}

export interface Candidate {
  path: string;
  description: string | null;
  card: string; // what the note stage judges: title, folder, tags, and description or opening text
}

export interface Selection {
  label: string;
  named: boolean; // notes were named with paths
  candidates: Candidate[];
  excluded: { path: string; reason: string }[];
  missing: { input: string; reason: string }[];
}

export class SearchScopeError extends Error {}

async function candidatePaths(req: SemanticSearchRequest): Promise<{ label: string; named: boolean; paths: string[]; missing: Selection["missing"] }> {
  const missing: Selection["missing"] = [];

  if (req.paths && req.paths.length > 0) {
    const paths: string[] = [];
    for (const input of req.paths) {
      try {
        const resolved = await vault.resolveNoteReference(input);
        if (!paths.includes(resolved.path)) paths.push(resolved.path);
      } catch (e) {
        missing.push({ input, reason: e instanceof Error ? e.message : String(e) });
      }
    }
    return { label: `${req.paths.length} named note(s)`, named: true, paths, missing };
  }

  const scope = req.folder ? ` in ${req.folder}` : " across the vault";
  const label = req.query ? `notes matching /${req.query}/${scope}` : req.folder ? `every note in ${req.folder}` : "every note in the vault";
  return { label, named: false, paths: await vault.listNotePaths(req.folder), missing };
}

function plainExcerpt(body: string): string {
  return body
    .replace(/^(```+|~~~+)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, EXCERPT_CHARS);
}

export function noteCard(notePath: string, content: string): Candidate {
  let frontmatter: Record<string, unknown> | null = null;
  try {
    frontmatter = parseFrontmatter(content);
  } catch {
    frontmatter = null; // malformed YAML: still judged on title and body
  }
  const title = typeof frontmatter?.title === "string" && frontmatter.title.trim()
    ? frontmatter.title.trim()
    : path.posix.basename(notePath, ".md");
  const description = typeof frontmatter?.description === "string" && frontmatter.description.trim()
    ? frontmatter.description.trim()
    : null;
  const folder = path.posix.dirname(notePath);
  let tags: string[] = [];
  try {
    tags = vault.getNoteTags(content);
  } catch {
    tags = []; // malformed frontmatter; inline tags still appear in the opening text
  }
  const lines = [`Title: ${title}`];
  if (folder !== ".") lines.push(`Folder: ${folder}`);
  if (tags.length) lines.push(`Tags: ${tags.join(", ")}`);
  lines.push(description ? `Description: ${description}` : `Opening text: ${plainExcerpt(splitFrontmatter(content).body)}`);
  return { path: notePath, description, card: lines.join("\n") };
}

// Every note that may be sent for this request, with the notes withheld and why. Path rules are checked
// before a note is read; tag rules after.
export async function selectNotes(req: SemanticSearchRequest, env: NodeJS.ProcessEnv = process.env): Promise<Selection> {
  const rules = exclusionRules(req, env);
  const { label, named, paths, missing } = await candidatePaths(req);
  // Match as vault_search_content does, but only after path exclusions have been applied.
  const query = !named && req.query ? vault.compileSearchPattern(req.query, "i") : null;

  const candidates: Candidate[] = [];
  const excluded: Selection["excluded"] = [];
  const seen = new Set<string>();

  for (const relPath of paths) {
    const byPath = pathExclusion(relPath, rules);
    if (byPath) {
      excluded.push({ path: relPath, reason: byPath });
      continue;
    }
    let notePath: string;
    try {
      notePath = await vault.canonicalNotePath(relPath);
    } catch (e) {
      missing.push({ input: relPath, reason: e instanceof Error ? e.message : String(e) });
      continue;
    }
    const byTarget = pathExclusion(notePath, rules);
    if (byTarget) {
      excluded.push({ path: relPath, reason: byTarget });
      continue;
    }
    if (seen.has(notePath)) continue;
    seen.add(notePath);
    let content: string;
    try {
      content = await vault.readNote(notePath);
    } catch (e) {
      missing.push({ input: relPath, reason: e instanceof Error ? e.message : String(e) });
      continue;
    }
    if (query && !content.split("\n").some(line => query.test(line))) continue;
    const byTag = contentExclusion(content, rules);
    if (byTag) {
      excluded.push({ path: relPath, reason: byTag });
      continue;
    }
    if (candidates.length >= MAX_CANDIDATES) {
      throw new SearchScopeError(`More than ${MAX_CANDIDATES} notes are in scope. Narrow with folder, query, or paths.`);
    }
    candidates.push(noteCard(notePath, content));
  }

  return { label, named, candidates, excluded, missing };
}

// --- Judging ----------------------------------------------------------------------

// Note cards are short, so the criteria travel once per request in the state, and many notes share a request.
export const NOTE_PROMPT: JudgePrompt = {
  kind: "note",
  collection: "notes",
  question: id => `Would note \`${id}\` in \`notes\` help someone pursuing \`goal\`, as defined by \`criteria\`? Judge only that one note.`,
  criteria: {
    true: "The note is about what the goal is after, or holds information that serves it, even when it uses different words.",
    false: "The note only shares incidental words or a loosely related topic with the goal, or would not help with it.",
  },
  criteriaInState: true,
  maxItemsPerBatch: 100,
  overheadBytes: 160,
};

export interface RankedNote {
  candidate: Candidate;
  p: number | null; // null when the note stage was skipped or the note went unjudged
}

export interface SemanticSearchOptions extends JudgeOptions {
  maxNotes?: number;
  passages?: boolean;
  threshold?: number;
  maxChunksPerNote?: number;
  cache?: JudgmentCache;
  env?: NodeJS.ProcessEnv;
}

interface Usage {
  requests: number;
  fromCache: number;
  failures: string[];
}

interface NotePassages {
  path: string;
  p: number | null;
  total: number;
  chars: number;
  kept: { chunk: Chunk; p: number | null }[];
}

// Reads each note again, re-checks its tags against the rules (the note may have changed since
// selection), and keeps the chunks that bear on the goal.
async function readPassages(
  provider: DecisionProvider,
  req: SemanticSearchRequest,
  notes: RankedNote[],
  options: SemanticSearchOptions,
  cache: JudgmentCache,
  usage: Usage,
): Promise<{ skims: NotePassages[]; overChunkLimit: number }> {
  const rules = exclusionRules(req, options.env);
  const planned: { note: RankedNote; chunks: Chunk[] }[] = [];
  let chunkCount = 0;
  let overChunkLimit = 0;
  for (const note of notes) {
    let content: string;
    try {
      content = await vault.readNote(note.candidate.path);
    } catch {
      continue;
    }
    if (contentExclusion(content, rules)) continue;
    const chunks = chunkText(content);
    if (chunks.length === 0) continue;
    if (chunkCount + chunks.length > MAX_CHUNKS) {
      overChunkLimit++;
      continue;
    }
    chunkCount += chunks.length;
    planned.push({ note, chunks });
  }

  const items = planned.flatMap(({ note, chunks }) =>
    chunks.map(c => ({ source: note.candidate.path, lines: `${c.startLine}-${c.endLine}`, text: c.text })),
  );
  const judgement = await judgeWithCache(provider, req.goal, items, CHUNK_PROMPT, cache, options);
  usage.requests += judgement.requests;
  usage.fromCache += judgement.fromCache;
  usage.failures.push(...judgement.failures);

  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  let offset = 0;
  const skims = planned.map(({ note, chunks }) => {
    const scored = chunks.map((chunk, i) => ({ chunk, p: judgement.probabilities[offset + i] ?? null }));
    offset += chunks.length;
    // Unjudged chunks (p === null) are always kept: a failed request must never silently drop text.
    let kept = scored.filter(s => s.p === null || s.p >= threshold);
    if (options.maxChunksPerNote && options.maxChunksPerNote > 0) {
      const unjudged = kept.filter(s => s.p === null);
      const judged = kept.filter(s => s.p !== null).sort((a, b) => b.p! - a.p!).slice(0, options.maxChunksPerNote);
      kept = [...unjudged, ...judged];
    }
    kept.sort((a, b) => a.chunk.startLine - b.chunk.startLine);
    return {
      path: note.candidate.path,
      p: note.p,
      total: chunks.length,
      chars: chunks.reduce((n, c) => n + c.text.length, 0),
      kept,
    };
  });
  return { skims, overChunkLimit };
}

// --- Running and rendering ---------------------------------------------------------

const fmtChars = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const fmtP = (p: number | null) => (p === null ? "unjudged" : p.toFixed(2));

function noteLine(note: RankedNote): string {
  const line = `- ${fmtP(note.p)}  ${note.candidate.path}`;
  return note.candidate.description ? `${line}: ${note.candidate.description}` : line;
}

// Ranks notes when the selection is larger than max_notes or only a ranking was asked for, then reads
// the best notes for passages. A selection that fits within max_notes is read directly.
export async function runSemanticSearch(req: SemanticSearchRequest, provider: DecisionProvider, options: SemanticSearchOptions = {}): Promise<string> {
  const env = options.env ?? process.env;
  const cache = options.cache ?? judgmentCacheFromEnv(env);
  const maxNotes = Math.min(MAX_NOTES_CAP, Math.max(1, options.maxNotes ?? DEFAULT_MAX_NOTES));
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const passages = options.passages ?? true;
  const usage: Usage = { requests: 0, fromCache: 0, failures: [] };

  const selection = await selectNotes(req, env);
  const lines: string[] = [];
  const ranks = !passages || selection.candidates.length > maxNotes;

  let chosen: RankedNote[] = selection.candidates.map(candidate => ({ candidate, p: null }));
  let others: RankedNote[] = [];
  let closest: RankedNote[] = [];
  let unjudgedNotes = 0;
  if (ranks && selection.candidates.length > 0) {
    const judgement = await judgeWithCache(
      provider, req.goal, selection.candidates.map(c => ({ source: c.path, text: c.card })), NOTE_PROMPT, cache, options,
    );
    usage.requests += judgement.requests;
    usage.fromCache += judgement.fromCache;
    usage.failures.push(...judgement.failures);
    const ranked = selection.candidates
      .map((candidate, i) => ({ candidate, p: judgement.probabilities[i] ?? null }))
      .filter(note => {
        if (note.p === null) unjudgedNotes++;
        return note.p !== null;
      })
      .sort((a, b) => b.p! - a.p! || a.candidate.path.localeCompare(b.candidate.path));
    const relevant = ranked.filter(note => note.p! >= threshold);
    chosen = relevant.slice(0, maxNotes);
    others = relevant.slice(maxNotes);
    if (relevant.length === 0) closest = ranked.slice(0, 3);
    lines.push(`Ranked ${selection.candidates.length} note(s) (${selection.label}) with ${provider.label} (${provider.model}): ${relevant.length} relevant at p ≥ ${threshold}.`);
  } else {
    lines.push(`Selected ${selection.candidates.length} note(s) (${selection.label}) for ${provider.label} (${provider.model}).`);
  }

  if (selection.candidates.length === 0) lines.push("No notes to judge after exclusions.");

  let skims: NotePassages[] = [];
  let overChunkLimit = 0;
  if (passages && chosen.length > 0) {
    ({ skims, overChunkLimit } = await readPassages(provider, req, chosen, options, cache, usage));
  }

  if (passages && skims.length > 0) {
    const total = skims.reduce((n, s) => n + s.total, 0);
    const kept = skims.reduce((n, s) => n + s.kept.length, 0);
    const chars = skims.reduce((n, s) => n + s.chars, 0);
    const keptChars = skims.reduce((n, s) => n + s.kept.reduce((m, k) => m + k.chunk.text.length, 0), 0);
    const saved = chars > 0 ? Math.round((1 - keptChars / chars) * 100) : 0;
    lines.push(`Read ${skims.length} note(s) for passages: kept ${kept} of ${total} chunk(s), ${fmtChars(chars)} → ${fmtChars(keptChars)} chars (${saved}% saved). Chunks are cited as path:start-end lines; use vault_read for surrounding context.`);
  }
  if (usage.requests > 0 || usage.fromCache > 0) {
    lines.push(`${usage.requests} request(s) to ${provider.label}; ${usage.fromCache} judgment(s) reused from cache.`);
  }
  if (usage.failures.length > 0) {
    lines.push(`Warning: ${usage.failures.length} request(s) failed (${[...new Set(usage.failures)].join("; ")}).${passages ? " Their chunks are included unjudged." : ""}`);
  }
  if (unjudgedNotes > 0) lines.push(`Warning: ${unjudgedNotes} note(s) could not be ranked and are left out.`);
  if (overChunkLimit > 0) lines.push(`${overChunkLimit} more note(s) were not read for passages: the ${MAX_CHUNKS}-chunk limit per call was reached. Lower max_notes or narrow the selection.`);

  const body = [lines.join("\n")];
  if (selection.excluded.length > 0) {
    const withheld = [`Withheld ${selection.excluded.length} note(s) by exclusion rules.`];
    if (selection.named) {
      withheld.push(...selection.excluded.slice(0, EXCLUDED_DISPLAY_LIMIT).map(e => `- ${e.path}: ${e.reason}`));
      if (selection.excluded.length > EXCLUDED_DISPLAY_LIMIT) withheld.push(`- …and ${selection.excluded.length - EXCLUDED_DISPLAY_LIMIT} more`);
    }
    body.push(withheld.join("\n"));
  }
  if (selection.missing.length > 0) {
    body.push(["Not found or unreadable:", ...selection.missing.map(m => `- ${m.input}: ${m.reason}`)].join("\n"));
  }

  if (!passages) {
    if (chosen.length > 0) body.push(["## Relevant notes", ...chosen.map(noteLine)].join("\n"));
    if (others.length > 0) body.push(`${others.length} more relevant note(s) beyond max_notes.`);
  } else {
    const nothing: string[] = [];
    for (const skim of skims) {
      if (skim.kept.length === 0) {
        nothing.push(skim.path);
        continue;
      }
      const rank = skim.p === null ? "" : ` (p=${fmtP(skim.p)})`;
      body.push([
        `## ${skim.path}${rank}: kept ${skim.kept.length} of ${skim.total} chunk(s)`,
        ...skim.kept.map(({ chunk, p }) => `\n[${skim.path}:${chunk.startLine}-${chunk.endLine} · ${p === null ? "unjudged" : `p=${p.toFixed(2)}`}]\n${chunk.text}`),
      ].join("\n"));
    }
    if (nothing.length > 0) body.push(`## Nothing relevant in ${nothing.length} note(s)\n${nothing.map(p => `- ${p}`).join("\n")}`);
    if (others.length > 0) {
      body.push([
        `## Other relevant notes (passages not returned)`,
        ...others.slice(0, OTHER_RELEVANT_LIMIT).map(noteLine),
        ...(others.length > OTHER_RELEVANT_LIMIT ? [`- …and ${others.length - OTHER_RELEVANT_LIMIT} more`] : []),
      ].join("\n"));
    }
    if (skims.length > 0 && skims.every(s => s.kept.length === 0)) body.push("No chunk passed the threshold. Rephrase the goal or lower threshold.");
  }
  if (closest.length > 0) body.push(["No note reached the threshold. Closest:", ...closest.map(noteLine)].join("\n"));
  return body.join("\n\n");
}

// --- Tool registration ------------------------------------------------------------

// The server builds a fresh McpServer per request; provider resolution and its log line happen once.
let providerOnce: DecisionProvider | null | undefined;

function loadProviderOnce(): DecisionProvider | null {
  if (providerOnce !== undefined) return providerOnce;
  try {
    providerOnce = resolveDecisionProvider();
  } catch (e) {
    console.error(`[obsidian-remote-mcp] vault_search_semantic disabled: ${e instanceof Error ? e.message : String(e)}`);
    providerOnce = null;
  }
  return providerOnce;
}

export function registerSemanticSearchTool(server: McpServer, options: { provider?: DecisionProvider | null; cache?: JudgmentCache } & JudgeOptions = {}) {
  const provider = options.provider !== undefined ? options.provider : loadProviderOnce();
  if (!provider) return;

  registerLogged(server,
    "vault_search_semantic",
    {
      annotations: { readOnlyHint: true, openWorldHint: true },
      title: "Search notes by meaning",
      description:
        `Finds notes by meaning and returns only the passages relevant to a goal, judged by an external decision model (${provider.label}, ${provider.model}). ` +
        "It works in two stages. First it ranks candidate notes from a short card (title, folder, tags, and description or opening text). Then it splits the best notes into ~2,000-char chunks and keeps the ones that bear on the goal, cited as path:start-end. " +
        "With no selection it searches the whole vault; narrow with folder, query (regex, as vault_search_content), or paths (paths or titles). A selection that fits within max_notes skips ranking and is read directly. passages: false returns only the ranked notes, which is faster. " +
        "Judgments are cached, so repeating a call costs nothing. Note text is sent to the provider; notes under the server's configured exclusions are never sent, and exclude_tags and exclude_paths withhold more for this call. " +
        "Use vault_search_content for exact words or names, and vault_outline + vault_read_section for a single well-structured note.",
      inputSchema: z.object({
        goal: z.string().min(1).describe("What the reader is trying to find out or accomplish. Specific goals filter better."),
        paths: z.array(z.string()).optional().describe("Notes to consider, as vault-relative paths or bare titles. Takes precedence over query and folder."),
        query: z.string().optional().describe("Regex; consider only notes whose text matches it (as vault_search_content)."),
        folder: z.string().optional().describe('Consider only notes in this folder (e.g. "03-Records/Working").'),
        exclude_tags: z.array(z.string()).optional().describe('Also withhold notes carrying these tags, for this call. "work/*" covers #work and its nested tags.'),
        exclude_paths: z.array(z.string()).optional().describe('Also withhold notes at or under these vault-relative paths, for this call. Wildcards as in .mcpignore: "**/Private" covers every Private folder.'),
        max_notes: z.number().int().optional().default(DEFAULT_MAX_NOTES).describe(`Most notes to return (default ${DEFAULT_MAX_NOTES}, up to ${MAX_NOTES_CAP}).`),
        passages: z.boolean().optional().default(true).describe("Return relevant passages from the best notes (default). False returns only the ranked notes."),
        threshold: z.number().min(0).max(1).optional().default(DEFAULT_THRESHOLD).describe("Keep notes and chunks with P(relevant) at or above this (default 0.5). Lower it if nothing comes back."),
        max_chunks_per_note: z.number().int().optional().describe("Keep at most this many chunks per note, best first."),
      }),
    },
    async ({ goal, paths, query, folder, exclude_tags, exclude_paths, max_notes, passages, threshold, max_chunks_per_note }) => {
      try {
        const text = await runSemanticSearch({ goal, paths, query, folder, exclude_tags, exclude_paths }, provider, {
          maxNotes: max_notes,
          passages,
          threshold,
          maxChunksPerNote: max_chunks_per_note,
          cache: options.cache,
          transport: options.transport,
          sleep: options.sleep,
        });
        return { content: [{ type: "text" as const, text }] };
      } catch (e) {
        // Caller errors become results; nothing has been sent for them.
        if (e instanceof SearchScopeError) return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
        if (!vault.isVaultError(e)) throw e;
        return { content: [{ type: "text" as const, text: `Error: could not select notes: ${e.message}` }], isError: true };
      }
    },
  );
}
