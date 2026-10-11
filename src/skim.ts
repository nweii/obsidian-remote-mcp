// ABOUTME: Registers vault_skim, which sends chunks of selected notes to a decision model and returns
// only the chunks relevant to a goal. Defaults to a dry-run plan; nothing leaves the server until the
// caller confirms with that plan's id. Notes can be withheld by tag or path, from config or per call.

import type { McpServer } from "@modelcontextprotocol/server";
import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import * as vault from "./vault.js";
import { chunkText, type Chunk } from "./chunk.js";
import { judgeChunks, resolveDecisionProvider, type DecisionProvider, type JudgeOptions } from "./decision.js";
import { registerLogged } from "./log.js";

export const DEFAULT_MAX_NOTES = 20;
export const MAX_NOTES_CAP = 100;
export const MAX_CHUNKS = 500;
export const DEFAULT_THRESHOLD = 0.5;
const EXCLUDED_DISPLAY_LIMIT = 20;

// --- Exclusion rules --------------------------------------------------------------

type RuleOrigin = "server config" | "this request";

interface ExclusionRules {
  tags: { pattern: string; origin: RuleOrigin }[];
  paths: { pattern: string; origin: RuleOrigin }[];
}

const splitList = (raw: string | undefined): string[] =>
  (raw ?? "").split(",").map(s => s.trim()).filter(Boolean);

const normalizeTag = (tag: string) => tag.trim().replace(/^#/, "").toLowerCase();
const normalizePath = (p: string) => path.posix.normalize(p.trim().replace(/^\/+|\/+$/g, "") || ".").normalize("NFC");

// Config rules come from SKIM_EXCLUDE_TAGS / SKIM_EXCLUDE_PATHS; request rules are added on top and
// can never remove a config rule.
export function exclusionRules(
  request: { exclude_tags?: string[]; exclude_paths?: string[] },
  env: NodeJS.ProcessEnv = process.env,
): ExclusionRules {
  const tag = (origin: RuleOrigin) => (t: string) => ({ pattern: normalizeTag(t), origin });
  const path = (origin: RuleOrigin) => (p: string) => ({ pattern: normalizePath(p), origin });
  return {
    tags: [
      ...splitList(env.SKIM_EXCLUDE_TAGS).map(tag("server config")),
      ...(request.exclude_tags ?? []).map(tag("this request")),
    ].filter(r => r.pattern !== "" && r.pattern !== "*"),
    paths: [
      ...splitList(env.SKIM_EXCLUDE_PATHS).map(path("server config")),
      ...(request.exclude_paths ?? []).filter(p => p.trim() !== "").map(path("this request")),
    ],
  };
}

// `private` matches only #private; `work/*` matches #work and every tag nested under it.
export function tagMatches(tag: string, pattern: string): boolean {
  const t = normalizeTag(tag);
  if (pattern.endsWith("/*")) {
    const base = pattern.slice(0, -2);
    return t === base || t.startsWith(base + "/");
  }
  return t === pattern;
}

// A path rule matches the path itself or anything under it, case-insensitively.
export function pathMatches(relPath: string, pattern: string): boolean {
  const p = normalizePath(relPath).toLowerCase();
  const rule = normalizePath(pattern).toLowerCase();
  return rule === "." || p === rule || p.startsWith(rule + "/");
}

function pathExclusion(relPath: string, rules: ExclusionRules): string | null {
  const rule = rules.paths.find(r => pathMatches(relPath, r.pattern));
  return rule ? `path ${rule.pattern} (${rule.origin})` : null;
}

function tagExclusion(tags: string[], rules: ExclusionRules): string | null {
  for (const rule of rules.tags) {
    const hit = tags.find(t => tagMatches(t, rule.pattern));
    if (hit) return `tag #${hit} (${rule.origin})`;
  }
  return null;
}

// --- Planning ---------------------------------------------------------------------

export interface SkimRequest {
  goal: string;
  paths?: string[];
  folder?: string;
  query?: string;
  exclude_tags?: string[];
  exclude_paths?: string[];
  max_notes?: number;
}

interface PlannedNote {
  path: string;
  chunks: Chunk[];
  chars: number;
  version: string;
}

export interface SkimPlan {
  goal: string;
  selection: string;
  provider: DecisionProvider;
  notes: PlannedNote[];
  excluded: { path: string; reason: string }[];
  missing: { input: string; reason: string }[];
  moreMatched: boolean;
  chunkCount: number;
  planId: string;
}

async function candidatePaths(req: SkimRequest): Promise<{ selection: string; paths: string[]; missing: SkimPlan["missing"] }> {
  const missing: SkimPlan["missing"] = [];

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
    return { selection: `${req.paths.length} named note(s)`, paths, missing };
  }

  const scope = req.folder ? ` in ${req.folder}` : " across the vault";
  if (req.query) {
    return { selection: `notes matching /${req.query}/${scope}`, paths: await vault.listNotePaths(req.folder), missing };
  }
  return { selection: `every note in ${req.folder}`, paths: await vault.listNotePaths(req.folder), missing };
}

function computePlanId(goal: string, provider: DecisionProvider, notes: PlannedNote[]): string {
  const fingerprint = JSON.stringify({
    goal,
    provider: provider.name,
    model: provider.model,
    notes: notes.map(n => [n.path, n.version]),
  });
  return createHash("sha256").update(fingerprint).digest("hex").slice(0, 12);
}

export async function planSkim(req: SkimRequest, provider: DecisionProvider, env: NodeJS.ProcessEnv = process.env): Promise<SkimPlan> {
  const rules = exclusionRules(req, env);
  const maxNotes = Math.min(MAX_NOTES_CAP, Math.max(1, req.max_notes ?? DEFAULT_MAX_NOTES));
  const { selection, paths, missing } = await candidatePaths(req);
  // Match as vault_search_content does, but only after skim path exclusions have been applied.
  const query = !(req.paths && req.paths.length > 0) && req.query ? new RegExp(req.query, "i") : null;

  const notes: PlannedNote[] = [];
  const excluded: SkimPlan["excluded"] = [];
  let moreMatched = false;
  const seen = new Set<string>();

  for (const relPath of paths) {
    // Path rules are checked before the note is read.
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
    const byTag = tagExclusion(vault.getNoteTags(content), rules);
    if (byTag) {
      excluded.push({ path: relPath, reason: byTag });
      continue;
    }
    if (notes.length >= maxNotes) {
      moreMatched = true;
      break;
    }
    const chunks = chunkText(content);
    if (chunks.length === 0) continue;
    notes.push({ path: notePath, chunks, chars: chunks.reduce((n, c) => n + c.text.length, 0), version: vault.versionOf(content) });
  }

  return {
    goal: req.goal,
    selection,
    provider,
    notes,
    excluded,
    missing,
    moreMatched,
    chunkCount: notes.reduce((n, note) => n + note.chunks.length, 0),
    planId: computePlanId(req.goal, provider, notes),
  };
}

// --- Rendering ------------------------------------------------------------------

const fmtChars = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export function formatPlan(plan: SkimPlan, maxNotes: number): string {
  const host = new URL(plan.provider.endpoint).host;
  const totalChars = plan.notes.reduce((n, note) => n + note.chars, 0);
  const lines: string[] = [];

  if (plan.notes.length === 0) {
    lines.push("Nothing to send: no notes remain after exclusions.");
  } else {
    lines.push(
      "Dry run: nothing has been sent. Show this plan to the user and get their approval before confirming.",
      "",
      `Goal: ${plan.goal}`,
      `Selection: ${plan.selection}`,
      `Would send ${plan.chunkCount} chunk(s), ${fmtChars(totalChars)} chars, from ${plan.notes.length} note(s) to ${plan.provider.label} (${plan.provider.model}, ${host}).`,
      "",
      "Notes:",
      ...plan.notes.map(n => `- ${n.path} (${n.chunks.length} chunk(s), ${fmtChars(n.chars)} chars)`),
    );
  }

  if (plan.excluded.length > 0) {
    lines.push("", `Withheld (${plan.excluded.length}):`);
    lines.push(...plan.excluded.slice(0, EXCLUDED_DISPLAY_LIMIT).map(e => `- ${e.path}: ${e.reason}`));
    if (plan.excluded.length > EXCLUDED_DISPLAY_LIMIT) {
      lines.push(`- …and ${plan.excluded.length - EXCLUDED_DISPLAY_LIMIT} more`);
    }
  }
  if (plan.missing.length > 0) {
    lines.push("", "Not found or unreadable:", ...plan.missing.map(m => `- ${m.input}: ${m.reason}`));
  }
  if (plan.moreMatched) {
    lines.push("", `More notes matched than max_notes (${maxNotes}). Narrow with folder or query, or raise max_notes (up to ${MAX_NOTES_CAP}).`);
  }
  if (plan.chunkCount > MAX_CHUNKS) {
    lines.push("", `This is more than the ${MAX_CHUNKS}-chunk limit per call. Narrow the selection before confirming.`);
  } else if (plan.notes.length > 0) {
    lines.push("", `After the user approves, call vault_skim again with the same arguments plus confirm: "${plan.planId}".`);
  }
  return lines.join("\n");
}

export interface SkimRunOptions extends JudgeOptions {
  threshold?: number;
  maxChunksPerNote?: number;
}

export async function runSkim(plan: SkimPlan, options: SkimRunOptions = {}): Promise<string> {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const items = plan.notes.flatMap(note =>
    note.chunks.map(c => ({ source: note.path, lines: `${c.startLine}-${c.endLine}`, text: c.text })),
  );
  const judgement = await judgeChunks(plan.provider, plan.goal, items, options);

  let offset = 0;
  let keptChunks = 0;
  let keptChars = 0;
  let totalChars = 0;
  const sections: string[] = [];
  const nothing: string[] = [];

  for (const note of plan.notes) {
    const scored = note.chunks.map((chunk, i) => ({ chunk, p: judgement.probabilities[offset + i] ?? null }));
    offset += note.chunks.length;
    totalChars += note.chars;

    // Unjudged chunks (p === null) are always kept: a failed request must never silently drop text.
    let kept = scored.filter(s => s.p === null || s.p >= threshold);
    if (options.maxChunksPerNote && options.maxChunksPerNote > 0) {
      const unjudged = kept.filter(s => s.p === null);
      const judged = kept.filter(s => s.p !== null).sort((a, b) => b.p! - a.p!).slice(0, options.maxChunksPerNote);
      kept = [...unjudged, ...judged];
    }
    kept.sort((a, b) => a.chunk.startLine - b.chunk.startLine);

    if (kept.length === 0) {
      nothing.push(note.path);
      continue;
    }
    const chars = kept.reduce((n, s) => n + s.chunk.text.length, 0);
    keptChunks += kept.length;
    keptChars += chars;
    sections.push(
      [
        `## ${note.path}: kept ${kept.length} of ${note.chunks.length} chunk(s)`,
        ...kept.map(({ chunk, p }) =>
          `\n[${note.path}:${chunk.startLine}-${chunk.endLine} · ${p === null ? "unjudged" : `p=${p.toFixed(2)}`}]\n${chunk.text}`,
        ),
      ].join("\n"),
    );
  }

  const saved = totalChars > 0 ? Math.round((1 - keptChars / totalChars) * 100) : 0;
  const header = [
    `Skimmed ${plan.notes.length} note(s) with ${plan.provider.label} (${plan.provider.model}): kept ${keptChunks} of ${plan.chunkCount} chunk(s), ${fmtChars(totalChars)} → ${fmtChars(keptChars)} chars (${saved}% saved). Chunks are cited as path:start-end lines; use vault_read for surrounding context.`,
  ];
  if (judgement.failures.length > 0) {
    header.push(`Warning: ${judgement.failures.length} request(s) failed (${[...new Set(judgement.failures)].join("; ")}). Their chunks are included unjudged.`);
  }
  const body = [header.join("\n"), ...sections];
  if (nothing.length > 0) body.push(`## Nothing relevant in ${nothing.length} note(s)\n${nothing.map(p => `- ${p}`).join("\n")}`);
  if (sections.length === 0) body.push("No chunk passed the threshold. Rephrase the goal or lower threshold.");
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
    console.error(`[obsidian-remote-mcp] vault_skim disabled: ${e instanceof Error ? e.message : String(e)}`);
    providerOnce = null;
  }
  return providerOnce;
}

export function registerSkimTool(server: McpServer, options: { provider?: DecisionProvider | null } & JudgeOptions = {}) {
  const provider = options.provider !== undefined ? options.provider : loadProviderOnce();
  if (!provider) return;

  registerLogged(server,
    "vault_skim",
    {
      annotations: { readOnlyHint: true, openWorldHint: true },
      title: "Skim notes for a goal",
      description:
        `Returns only the parts of notes relevant to a goal, so long notes or many notes can be checked without reading them whole. Notes are split into ~2,000-char chunks and each chunk is judged by an external decision model (${provider.label}, ${provider.model}); kept chunks come back cited as path:start-end. ` +
        "Select notes with paths (paths or titles), or query (regex, as vault_search_content) optionally scoped by folder, or folder alone. " +
        "This sends note text to a third-party API, so it always plans first: a call without confirm sends nothing and returns a plan (goal, selection, the notes that would be sent, the notes withheld and why, provider). Show that plan to the user and get their explicit approval, then call again with the same arguments plus confirm set to the plan id. If the notes changed in between, the confirm is refused with a fresh plan. " +
        "Notes tagged or located under the server's configured exclusions are always withheld; exclude_tags and exclude_paths withhold more for this call. Prefer vault_outline + vault_read_section for a single well-structured note.",
      inputSchema: z.object({
        goal: z.string().min(1).describe("What the reader is trying to find out or accomplish. Specific goals filter better."),
        paths: z.array(z.string()).optional().describe("Notes to skim, as vault-relative paths or bare titles. Takes precedence over query and folder."),
        query: z.string().optional().describe("Regex; skim the notes whose text matches it (as vault_search_content)."),
        folder: z.string().optional().describe('Limit query to this folder, or with no query, skim every note in it (e.g. "03-Records/Working").'),
        exclude_tags: z.array(z.string()).optional().describe('Also withhold notes carrying these tags, for this call. "work/*" covers #work and its nested tags.'),
        exclude_paths: z.array(z.string()).optional().describe("Also withhold notes at or under these vault-relative paths, for this call."),
        max_notes: z.number().int().optional().default(DEFAULT_MAX_NOTES).describe(`Max notes to send (default ${DEFAULT_MAX_NOTES}, up to ${MAX_NOTES_CAP}).`),
        threshold: z.number().min(0).max(1).optional().default(DEFAULT_THRESHOLD).describe("Keep chunks with P(relevant) at or above this (default 0.5). Lower it if nothing comes back."),
        max_chunks_per_note: z.number().int().optional().describe("Keep at most this many chunks per note, best first."),
        confirm: z.string().optional().describe("The plan id from a prior dry run the user approved. Omit to get a plan."),
      }),
    },
    async ({ goal, paths, query, folder, exclude_tags, exclude_paths, max_notes, threshold, max_chunks_per_note, confirm }) => {
      if (!(paths && paths.length > 0) && !query && !folder) {
        return {
          content: [{ type: "text" as const, text: "Error: pass paths, query, or folder to choose which notes to skim." }],
          isError: true,
        };
      }
      if (query) {
        try {
          new RegExp(query);
        } catch (e) {
          return { content: [{ type: "text" as const, text: `Error: invalid query regex: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
        }
      }

      let plan: SkimPlan;
      try {
        plan = await planSkim({ goal, paths, query, folder, exclude_tags, exclude_paths, max_notes }, provider);
      } catch (e) {
        // Policy refusals and a missing folder are caller errors; nothing has been sent either way.
        const message = e instanceof Error ? e.message : String(e);
        return { content: [{ type: "text" as const, text: `Error: could not plan the skim: ${message}` }], isError: true };
      }
      const planText = formatPlan(plan, Math.min(MAX_NOTES_CAP, Math.max(1, max_notes)));

      if (!confirm) return { content: [{ type: "text" as const, text: planText }] };

      if (confirm.trim() !== plan.planId) {
        return {
          content: [{ type: "text" as const, text: `Refused: confirm "${confirm}" does not match the current plan (the arguments or the notes changed). Nothing was sent. Get approval for this plan instead:\n\n${planText}` }],
          isError: true,
        };
      }
      if (plan.notes.length === 0 || plan.chunkCount > MAX_CHUNKS) {
        return { content: [{ type: "text" as const, text: `Nothing was sent.\n\n${planText}` }], isError: true };
      }

      const text = await runSkim(plan, {
        threshold,
        maxChunksPerNote: max_chunks_per_note,
        transport: options.transport,
        sleep: options.sleep,
      });
      return { content: [{ type: "text" as const, text }] };
    },
  );
}
