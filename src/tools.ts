// ABOUTME: Registers all vault tools on an McpServer - context, read (full/list), outline, read section, read attachment, frontmatter, links, writes, move/rename, title search, content search, tags, periodic note, clip URL, feedback.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as vault from "./vault.js";
import { frontmatterValueToString } from "./frontmatter.js";
import { registerClipTool } from "./clip.js";
import { registerLogged, logFeedback, isLoggingEnabled, type ToolResult } from "./log.js";
import { parseLocalYmd, localYmd } from "./date.js";

// Hard cap on the folder-tree walk inside vault_context. The tree is a bonus orientation
// section; if filesystem traversal stalls (slow disk, network mount, huge vault) we'd rather
// return the context note quickly than block on the bonus.
const TREE_TIMEOUT_MS = 1500;

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<{ ok: true; value: T } | { ok: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<{ ok: false }>(resolve => {
    timer = setTimeout(() => resolve({ ok: false }), ms);
  });
  try {
    return await Promise.race([
      promise.then(value => ({ ok: true as const, value })),
      timeoutPromise,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Build the collision-warning text for a resolved reference, or return null if
// the resolution was unambiguous. Paths are wrapped in backticks so commas inside
// filenames don't make the list ambiguous.
function buildResolveWarning(
  reference: vault.ResolvedReference,
  input: string,
): string | null {
  if (!reference.candidates || reference.candidates.length <= 1) return null;
  const others = reference.candidates.slice(1).map((p) => `- \`${p}\``).join("\n");
  return `Note: "${input}" matched ${reference.candidates.length} notes by title; used \`${reference.path}\`.\nOther matches:\n${others}`;
}

// Prepend the collision warning as a separate content block so agents parsing
// the note body (frontmatter extraction, word counts, etc.) don't see it bleed
// into the content.
function withResolveWarning(
  result: ToolResult,
  reference: vault.ResolvedReference,
  input: string,
): ToolResult {
  const warning = buildResolveWarning(reference, input);
  if (!warning) return result;
  return {
    ...result,
    content: [{ type: "text" as const, text: warning }, ...result.content],
  };
}

// Wrap vault.resolveNoteReference so handlers can short-circuit on resolver
// errors with a consistent isError tool result. Only known resolver-layer
// rejections (policy violations, EISDIR, missed lookup, empty input) become
// friendly isError results; unexpected throws (e.g. EACCES during walk) bubble
// up so the SDK records them with a stack instead of muting them into agent
// text. eisdirHint is appended to the "is a directory" message for vault_read,
// which has a folder-browsing alternative (mode "list").
async function resolveOrError(
  input: string,
  opts: { eisdirHint?: string } = {},
): Promise<{ ok: true; ref: vault.ResolvedReference } | { ok: false; result: ToolResult }> {
  try {
    const ref = await vault.resolveNoteReference(input);
    return { ok: true, ref };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    const message = e instanceof Error ? e.message : String(e);
    const isResolverError =
      e instanceof vault.VaultPolicyError ||
      code === "EISDIR" ||
      (e instanceof Error &&
        (message === "Empty note reference" || message.startsWith("Could not resolve")));
    if (!isResolverError) throw e;
    const text = code === "EISDIR" && opts.eisdirHint ? `${message}${opts.eisdirHint}` : message;
    return { ok: false, result: { content: [{ type: "text" as const, text }], isError: true } };
  }
}

// vault_update takes the same path/bare-title input as vault_read, and vault_read versions the
// note against its *resolved* path. updateNote must operate on that same resolved path or the
// version check silently won't apply (and a brand-new file could be written at the unresolved
// path). Resolve to an existing note when possible; fall back to the literal input only when
// the note genuinely doesn't exist (e.g. creating a new one). Every other failure — policy
// violations, EISDIR, transient FS errors during the resolver walk — propagates, matching
// resolveOrError on the read path; swallowing them could write a stray file at the wrong path.
async function resolveForWrite(input: string): Promise<string> {
  try {
    const ref = await vault.resolveNoteReference(input);
    return ref.path;
  } catch (e) {
    const isNotFound =
      e instanceof Error &&
      (e.message === "Empty note reference" || e.message.startsWith("Could not resolve"));
    if (!isNotFound) throw e;
    return input;
  }
}

// vault_move takes explicit vault-relative paths, not bare titles — a move is a mutation and
// title resolution adds an ambiguity layer exactly where it isn't wanted. A bare title has no
// file extension; an explicit path always points at a file with one (e.g. `Notes/Foo.md`,
// `attachments/img.png`). Returns the rejection text if the input looks like a bare title,
// or null if it's an acceptable path.
function rejectBareTitle(input: string): string | null {
  const base = input.split("/").pop() ?? input;
  if (base.includes(".")) return null;
  return `Error: "${input}" looks like a bare title, not a vault-relative path. vault_move needs explicit paths with extensions (e.g. "Notes/Foo.md"); call vault_search_title to find the path first.`;
}

// The .base flags and skipped-bare-link warnings shared by the dry-run plan and the write report.
// Both forms need to surface these the same way, so they live in one helper.
function formatMoveCaveats(
  baseFilesToReview: string[],
  skippedLinks: vault.SkippedLink[],
): string {
  const lines: string[] = [];
  if (baseFilesToReview.length > 0) {
    lines.push("", "Base files to review by hand (never auto-edited):");
    for (const p of baseFilesToReview) lines.push(`- \`${p}\``);
  }
  if (skippedLinks.length > 0) {
    lines.push("", "Skipped ambiguous bare-name links (resolve by hand):");
    for (const s of skippedLinks) lines.push(`- \`${s.path}\`: ${s.link} — ${s.reason}`);
  }
  return lines.join("\n");
}

// Render the dry-run plan: the move, every file's rewrites, and the caveats. The plan ends with
// an explicit "nothing was written" line and how to apply it, so an agent knows the next step.
function formatMovePlan(plan: vault.RewritePlan): string {
  const kind = plan.isRename ? "rename" : "move";
  const lines: string[] = [`Dry run — planned ${kind} of \`${plan.from}\` to \`${plan.to}\`. Nothing was written.`];

  if (plan.files.length === 0) {
    lines.push("", "No links to rewrite.");
  } else {
    const total = plan.files.reduce((n, f) => n + f.rewrites.length, 0);
    lines.push("", `Would rewrite ${total} link(s) across ${plan.files.length} file(s):`);
    for (const file of plan.files) {
      lines.push(`- \`${file.path}\``);
      for (const r of file.rewrites) lines.push(`    ${r.before} → ${r.after}`);
    }
  }

  lines.push(formatMoveCaveats(plan.baseFilesToReview, plan.skippedLinks));
  lines.push("", "To apply, call vault_move again with dry_run: false.");
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

// Render the write-mode report: the move plus the files modified, any per-file rewrite failures
// (the move already landed, so these are stale links to fix by hand), and the same caveats.
function formatMoveReport(result: vault.RewriteResult): string {
  const lines: string[] = [`Moved \`${result.from}\` to \`${result.to}\`.`];

  if (result.modified.length === 0) {
    lines.push("", "No files needed link rewrites.");
  } else {
    lines.push("", `Rewrote links in ${result.modified.length} file(s):`);
    for (const p of result.modified) lines.push(`- \`${p}\``);
  }

  if (result.failures.length > 0) {
    lines.push("", "Failed to rewrite (links left stale — fix by hand):");
    for (const f of result.failures) lines.push(`- \`${f.path}\`: ${f.error}`);
  }

  lines.push(formatMoveCaveats(result.baseFilesToReview, result.skippedLinks));
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

async function titleSearchToolResult(title: string, exact: boolean, limit: number) {
  const results = await vault.findByTitle(title, exact, limit);
  if (results.length === 0) {
    return { content: [{ type: "text" as const, text: `No notes found matching "${title}".` }] };
  }
  const hitLimit = limit > 0 && results.length === limit;
  const text = results.map((r) => r.path).join("\n");
  return {
    content: [
      {
        type: "text" as const,
        text: hitLimit ? `${text}\n\n(limit of ${limit} reached — increase limit or use a more specific title)` : text,
      },
    ],
  };
}

// Max entries accepted by the batch tools (vault_batch_read, vault_batch_frontmatter_update).
const BATCH_MAX = 50;

// Accepted shapes for a frontmatter property value, shared by the single and batch setters.
const frontmatterValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.unknown()),
  z.record(z.string(), z.unknown()),
]);

// Render a parsed frontmatter value for display. Arrays are joined element-wise, nested objects
// are JSON, and scalars (including js-yaml Dates) go through frontmatterValueToString, so a date
// renders as the same YYYY-MM-DD that vault_search_frontmatter matched on.
function renderFrontmatterValue(v: unknown): string {
  if (Array.isArray(v)) return v.map(renderFrontmatterValue).join(", ");
  if (v !== null && typeof v === "object" && !(v instanceof Date)) return JSON.stringify(v);
  return frontmatterValueToString(v);
}

// Render a note's frontmatter as compact `key: value` lines for batch read — enough to triage
// which notes to open.
function renderFrontmatterBlock(fm: Record<string, unknown> | null): string {
  if (!fm || Object.keys(fm).length === 0) return "(no frontmatter)";
  return Object.entries(fm).map(([k, v]) => `${k}: ${renderFrontmatterValue(v)}`).join("\n");
}

export async function registerTools(server: McpServer) {
  // Optional: vault_clip_url. Wrapped in try/catch so a failure in the optional clip layer
  // can never break registration of the core vault tools.
  try {
    await registerClipTool(server, vault.getVaultRoot());
  } catch (err) {
    console.error(
      "[obsidian-remote-mcp] vault_clip_url registration failed; continuing with core tools.",
      err instanceof Error ? err.message : err,
    );
  }

  registerLogged(server,
    "vault_context",
    {
      title: "Vault context",
      description:
        "Returns the vault guidance note configured by VAULT_CONTEXT_PATH (falls back to AGENTS.md / CLAUDE.md), followed by a tree of vault folders for orientation. Call at the start of a session to learn vault structure/conventions.",
      inputSchema: z.object({
        max_depth: z
          .number()
          .optional()
          .default(3)
          .describe("Max folder tree depth (default 3, 0 = no tree)."),
      }),
    },
    async ({ max_depth }) => {
      const contextPath = vault.getContextNotePath();
      const sections: string[] = [];
      if (contextPath) {
        sections.push(await vault.readNote(contextPath));
      } else {
        sections.push(
          "No vault context note found. Set VAULT_CONTEXT_PATH, or add AGENTS.md or CLAUDE.md at the vault root.",
        );
      }
      if (max_depth > 0) {
        try {
          const result = await withTimeout(vault.getFolderTree(max_depth), TREE_TIMEOUT_MS);
          if (result.ok && result.value.length > 0) {
            sections.push(`## Vault folders\n\n${result.value.join("\n")}`);
          } else if (!result.ok) {
            sections.push(
              `## Vault folders\n\n_Folder tree skipped — took longer than ${TREE_TIMEOUT_MS}ms to build._`,
            );
          }
        } catch (e) {
          // Tree is a bonus; don't fail the whole call if directory walk errors out.
          sections.push(
            `## Vault folders\n\n_Folder tree failed: ${e instanceof Error ? e.message : String(e)}_`,
          );
        }
      }
      return { content: [{ type: "text", text: sections.join("\n\n") }] };
    },
  );

  registerLogged(server,
    "vault_read",
    {
      title: "Read vault note",
      description:
        'Read full note text (mode full, default) or list one folder level (mode list; path "" = vault root). In full mode, path accepts a vault-relative path (e.g. "Notes/Foo.md") or a bare note title (e.g. "Foo"); ambiguous titles return the first match with a warning. For # headings only use vault_outline; for one section under a heading use vault_read_section after vault_outline.',
      inputSchema: z.object({
        path: z
          .string()
          .describe('In full mode: a vault-relative path or a bare note title. In list mode: a folder path (use "" for vault root).'),
        mode: z
          .enum(["full", "list"])
          .optional()
          .default("full")
          .describe("full — entire .md file; list — immediate children of path (directory only)"),
        list_limit: z
          .number()
          .optional()
          .default(200)
          .describe('When mode is list: max entries (default 200, 0 = no limit).'),
      }),
    },
    async ({ path, mode, list_limit }) => {
      if (mode === "list") {
        const entries = await vault.listVaultFolder(path, list_limit);
        if (entries.length === 0) {
          return { content: [{ type: "text", text: "(empty folder)" }] };
        }
        const hitLimit = list_limit > 0 && entries.length === list_limit;
        const lines = entries.map((e) => `${e.kind === "directory" ? "dir " : "file "}${e.path}`);
        return {
          content: [
            {
              type: "text",
              text: hitLimit ? `${lines.join("\n")}\n\n(limit of ${list_limit} reached)` : lines.join("\n"),
            },
          ],
        };
      }
      const out = await resolveOrError(path, {
        eisdirHint: ` Use mode "list" with the same path (or path "") to browse.`,
      });
      if (!out.ok) return out.result;
      const content = await vault.readNote(out.ref.path);
      // Hand back a version for the note so vault_update can detect concurrent edits.
      // Kept as its own content block so it never bleeds into the note body the agent parses.
      const version = vault.versionOf(content);
      const result = withResolveWarning({ content: [{ type: "text", text: content }] }, out.ref, path);
      result.content.push({
        type: "text",
        text: `(version: ${version} — pass as base_version to vault_update to avoid clobbering a concurrent edit)`,
      });
      return result;
    },
  );

  registerLogged(server,
    "vault_batch_read",
    {
      title: "Read several notes at once",
      description:
        'Read multiple notes in one call. Each entry is a vault-relative path or a bare note title (resolved like vault_read); entries that can\'t be resolved are reported under "Not found" without failing the others. Set include_content false to return only each note\'s frontmatter — cheap triage to pick which notes to open before reading bodies.',
      inputSchema: z.object({
        paths: z.array(z.string()).min(1).max(BATCH_MAX).describe(`Vault-relative paths or bare note titles (1–${BATCH_MAX})`),
        include_content: z
          .boolean()
          .optional()
          .default(true)
          .describe("Include each note's full body (default true). false returns frontmatter only."),
      }),
    },
    async ({ paths, include_content }) => {
      const { found, missing } = await vault.readNotesBatch(paths, include_content);
      const blocks: string[] = [];
      for (const item of found) {
        const lines = [`=== ${item.path} ===`];
        if (include_content) lines.push(`(version: ${item.version})`);
        lines.push(renderFrontmatterBlock(item.frontmatter));
        if (include_content && item.content !== undefined) lines.push("", item.content.trimEnd());
        blocks.push(lines.join("\n"));
      }
      if (missing.length > 0) {
        blocks.push(["Not found:", ...missing.map((m) => `- ${m.reference}: ${m.error}`)].join("\n"));
      }
      blocks.push(`(${found.length} found, ${missing.length} missing)`);
      return { content: [{ type: "text", text: blocks.join("\n\n") }] };
    },
  );

  registerLogged(server,
    "vault_outline",
    {
      title: "Note heading outline",
      description:
        "List all markdown headings (# through ######) in one note, one per line with # prefix (like Obsidian CLI `obsidian outline`). Use before vault_read_section to get exact heading text.",
      inputSchema: z.object({
        path: z.string().describe("Vault-relative path or bare note title"),
      }),
    },
    async ({ path }) => {
      const out = await resolveOrError(path);
      if (!out.ok) return out.result;
      const headings = await vault.getNoteOutline(out.ref.path);
      const body =
        headings.length === 0
          ? { content: [{ type: "text" as const, text: "(no headings)" }] }
          : { content: [{ type: "text" as const, text: headings.join("\n") }] };
      return withResolveWarning(body, out.ref, path);
    },
  );

  registerLogged(server,
    "vault_read_section",
    {
      title: "Read note section under heading",
      description:
        "Return the body from one heading through the next same-or-higher-level heading. Pass heading text without # (case-insensitive). Prefer calling vault_outline first and copy the heading text after the #'s. If the heading text matches more than one section in the note, all matching sections are returned, each prefixed with a `<!-- match N of M (line X) -->` label so the caller can tell them apart.",
      inputSchema: z.object({
        path: z.string().describe("Vault-relative path or bare note title"),
        heading: z
          .string()
          .describe("Heading text only — no # prefix; must match a heading in the file (see vault_outline)"),
      }),
    },
    async ({ path, heading }) => {
      const out = await resolveOrError(path);
      if (!out.ok) return out.result;
      try {
        const content = await vault.readNoteSection(out.ref.path, heading);
        return withResolveWarning({ content: [{ type: "text", text: content }] }, out.ref, path);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const hint = message.startsWith("Heading ")
          ? " — call vault_outline first and copy heading text exactly (without # prefix)."
          : "";
        // If the title was ambiguous, prepend the warning so the agent knows the
        // heading miss may belong to a different candidate than expected.
        const warning = buildResolveWarning(out.ref, path);
        const text = warning ? `${warning}\n\n${message}${hint}` : `${message}${hint}`;
        return { content: [{ type: "text", text }], isError: true };
      }
    },
  );

  registerLogged(server,
    "vault_read_attachment",
    {
      title: "Read vault attachment",
      description:
        "Read a binary attachment from the vault by vault-relative path (e.g. \"Attachments/diagram.png\"). Image types (png, jpg, gif, webp) come back as an image content block clients can render; other types (pdf and the like) come back as base64 with mime type and size. Files over the size cap are rejected — pass stat_only first to check size and mime without pulling the payload. Read-only: uploading attachments is out of scope.",
      inputSchema: z.object({
        path: z.string().describe("Vault-relative path to the attachment (with extension)"),
        stat_only: z
          .boolean()
          .optional()
          .default(false)
          .describe("Return only size and mime type, without reading the file's bytes."),
      }),
    },
    async ({ path, stat_only }) => {
      try {
        const att = await vault.readAttachment(path, stat_only);
        const sizeKb = (att.bytes / 1024).toFixed(1);
        if (stat_only) {
          return {
            content: [
              { type: "text", text: `${path}\nmime: ${att.mimeType}\nsize: ${att.bytes} bytes (${sizeKb} KB)` },
            ],
          };
        }
        if (att.isImage) {
          // Image content block so clients render the attachment. The base64 payload lives only
          // in the result, never in the args the logger records, so it doesn't land in the log.
          return {
            content: [{ type: "image", data: att.data!, mimeType: att.mimeType }],
          };
        }
        // Non-image: hand back the base64 plus mime/size so the agent knows what it got.
        return {
          content: [
            { type: "text", text: `${path}\nmime: ${att.mimeType}\nsize: ${att.bytes} bytes (${sizeKb} KB)` },
            { type: "text", text: att.data! },
          ],
        };
      } catch (e) {
        const code = (e as NodeJS.ErrnoException)?.code;
        const message = e instanceof Error ? e.message : String(e);
        if (
          e instanceof vault.VaultPolicyError ||
          e instanceof vault.AttachmentTooLargeError ||
          code === "EISDIR" ||
          code === "ENOENT"
        ) {
          const text = code === "ENOENT" ? `Attachment not found: ${path}` : message;
          return { content: [{ type: "text", text }], isError: true };
        }
        throw e;
      }
    },
  );

  registerLogged(server,
    "vault_frontmatter",
    {
      title: "Read note frontmatter",
      description:
        "Read YAML frontmatter from a note without loading the full body. Omit property for all keys; set property to read one key.",
      inputSchema: z.object({
        path: z.string().describe("Vault-relative path or bare note title"),
        property: z.string().optional().describe("If set, return only this frontmatter key"),
      }),
    },
    async ({ path, property }) => {
      const out = await resolveOrError(path);
      if (!out.ok) return out.result;
      if (property !== undefined && property.length > 0) {
        const value = await vault.getFrontmatterProperty(out.ref.path, property);
        const body =
          value === undefined
            ? { content: [{ type: "text" as const, text: `Property "${property}" not found.` }] }
            : {
                content: [
                  {
                    type: "text" as const,
                    text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
                  },
                ],
              };
        return withResolveWarning(body, out.ref, path);
      }
      const frontmatter = await vault.getFrontmatter(out.ref.path);
      const body =
        frontmatter === null
          ? { content: [{ type: "text" as const, text: "(no frontmatter)" }] }
          : { content: [{ type: "text" as const, text: JSON.stringify(frontmatter, null, 2) }] };
      return withResolveWarning(body, out.ref, path);
    },
  );

  registerLogged(server,
    "vault_links",
    {
      title: "Get note links",
      description: "Get outgoing [[wikilinks]] from a note with resolved paths, and optionally backlinks (notes that link to it). Use to navigate the graph without reading full content.",
      inputSchema: z.object({
        path: z.string().describe("Vault-relative path or bare note title"),
        include_backlinks: z.boolean().optional().default(false).describe("Also return notes that link to this one (default false)"),
        backlinks_limit: z.number().optional().default(20).describe("Max backlinks to return (default 20, 0 = no limit)"),
      }),
    },
    async ({ path, include_backlinks, backlinks_limit }) => {
      const out = await resolveOrError(path);
      if (!out.ok) return out.result;
      const links = await vault.getNoteLinks(out.ref.path);
      const lines: string[] = ["## Outgoing links"];
      if (links.length === 0) {
        lines.push("(none)");
      } else {
        for (const l of links) {
          lines.push(l.path ? `- [[${l.title}]] → ${l.path}` : `- [[${l.title}]] (not found)`);
        }
      }
      if (include_backlinks) {
        const backlinks = await vault.getBacklinks(out.ref.path, backlinks_limit);
        lines.push("", "## Backlinks");
        if (backlinks.length === 0) {
          lines.push("(none found)");
        } else {
          for (const b of backlinks) lines.push(`- ${b}`);
        }
      }
      return withResolveWarning({ content: [{ type: "text", text: lines.join("\n") }] }, out.ref, path);
    },
  );

  registerLogged(server,
    "vault_create",
    {
      title: "Create vault note",
      description: "Create a new note. Fails if the file already exists. Follow vault conventions — call vault_context if unsure about folder or frontmatter.",
      inputSchema: z.object({
        path: z.string().describe("Relative path for the new note"),
        content: z.string().describe("Initial note content"),
      }),
    },
    async ({ path, content }) => {
      try {
        await vault.createNote(path, content);
      } catch (err) {
        if (err instanceof vault.NoteExistsError) {
          return { content: [{ type: "text", text: `Error: file already exists at ${path}. To replace it, use vault_update; to modify part of it, use vault_edit.` }], isError: true };
        }
        throw err;
      }
      return { content: [{ type: "text", text: `Created ${path}` }] };
    },
  );

  registerLogged(server,
    "vault_update",
    {
      title: "Update vault note",
      description: "Replace the entire content of an existing note. For section-level changes, prefer vault_edit to avoid resending the full note. Pass base_version (from your last vault_read of this note) so the write is rejected instead of silently overwriting a concurrent edit by another session.",
      inputSchema: z.object({
        path: z.string().describe("Relative path to the note"),
        content: z.string().describe("New content to write"),
        base_version: z
          .string()
          .optional()
          .describe("Version string from your last vault_read of this note. When set, the update is rejected if the note changed since you read it (re-read and reapply your change). Omit only when intentionally overwriting whatever is on disk."),
      }),
    },
    async ({ path, content, base_version }) => {
      try {
        const targetPath = await resolveForWrite(path);
        const result = await vault.updateNote(targetPath, content, base_version);
        return { content: [{ type: "text", text: `Updated ${targetPath}. New version: ${result.version}` }] };
      } catch (e) {
        if (e instanceof vault.ConcurrentEditError) {
          return { content: [{ type: "text", text: e.message }], isError: true };
        }
        throw e;
      }
    },
  );

  registerLogged(server,
    "vault_set_frontmatter_property",
    {
      title: "Set note frontmatter property",
      description:
        "Set one YAML frontmatter property on a note. Splices over just the target key's lines, so untouched keys keep their on-disk form (including bare YYYY-MM-DD dates, quoting style, blank lines, comments). " +
        "Pass arrays as JSON arrays (e.g. `[\"[[A]]\", \"[[B]]\"]`) so they render as a YAML sequence — a JSON-stringified array sent as a string is parsed defensively but the array shape is preferred.",
      inputSchema: z.object({
        path: z.string().describe("Relative path to the note"),
        name: z.string().describe("Frontmatter property name"),
        value: frontmatterValueSchema.describe(
          "Value to store. Pass arrays as JSON arrays (renders as YAML sequence), objects as JSON objects, scalars as strings/numbers/booleans. null is allowed.",
        ),
      }),
    },
    async ({ path, name, value }) => {
      await vault.setFrontmatterProperty(path, name, value);
      return { content: [{ type: "text", text: `Set frontmatter property "${name}" on ${path}` }] };
    },
  );

  registerLogged(server,
    "vault_batch_frontmatter_update",
    {
      title: "Set frontmatter on several notes",
      description:
        "Set frontmatter properties on multiple notes in one call. Each update is { path, fields } where fields maps property → value; every property is spliced in place so untouched keys keep their on-disk form. Per note, all fields are written in one locked read-modify-write. One note failing (e.g. missing file) is reported and does not stop the others. Paths are explicit vault-relative paths.",
      inputSchema: z.object({
        updates: z
          .array(
            z.object({
              path: z.string().describe("Relative path to the note"),
              fields: z.record(z.string(), frontmatterValueSchema).describe("Property → value map to set on this note"),
            }),
          )
          .min(1)
          .max(BATCH_MAX)
          .describe(`Per-note frontmatter updates (1–${BATCH_MAX})`),
      }),
    },
    async ({ updates }) => {
      const outcomes = await vault.updateFrontmatterBatch(updates);
      const ok = outcomes.filter((o) => o.updated);
      const failed = outcomes.filter((o) => !o.updated);
      const lines: string[] = [];
      if (ok.length > 0) lines.push(`Updated ${ok.length} note(s):`, ...ok.map((o) => `- ${o.path}`));
      if (failed.length > 0) {
        if (lines.length > 0) lines.push("");
        lines.push("Failed:", ...failed.map((o) => `- ${o.path}: ${o.error}`));
      }
      // Flag the call as an error only when nothing succeeded; a partial success is a normal
      // result that lists which notes failed.
      return { content: [{ type: "text", text: lines.join("\n") }], ...(ok.length === 0 ? { isError: true } : {}) };
    },
  );

  registerLogged(server,
    "vault_edit",
    {
      title: "Edit vault note",
      description: "Partially edit a note: append, prepend, or find-and-replace. Prefer over vault_update for section-level changes.",
      inputSchema: z.object({
        path: z.string().describe("Relative path to the note"),
        operation: z.enum(["append", "prepend", "replace"]).describe("append — add to end; prepend — add to start; replace — swap exact text"),
        content: z.string().describe("Content to add, or replacement text for a replace operation"),
        find: z.string().optional().describe("Exact text to replace — required for replace operation"),
      }),
    },
    async ({ path, operation, content, find }) => {
      if (operation === "append") {
        await vault.appendNote(path, content);
      } else if (operation === "prepend") {
        await vault.prependToNote(path, content);
      } else {
        if (!find) {
          return { content: [{ type: "text", text: "Error: find is required for replace operation — pass the exact text to swap. For section-scoped edits, prefer vault_update after vault_read." }], isError: true };
        }
        await vault.replaceInNote(path, find, content);
      }
      return { content: [{ type: "text", text: `Edited ${path} (${operation})` }] };
    },
  );

  registerLogged(server,
    "vault_edit_section",
    {
      title: "Edit a note section under a heading",
      description:
        "Edit just one section of a note (heading line through the next same-or-higher heading). Operations: append — add to end of section, before the next heading; prepend — add right after the heading line, before existing body; replace — replace the section body and keep the heading line. Call vault_outline first to get exact heading text. If the heading text matches more than one section in the note, this tool refuses to guess and returns an AmbiguousHeadingError listing each candidate — use vault_edit with a find-anchored replace on unique text instead.",
      inputSchema: z.object({
        path: z.string().describe("Relative path to the note"),
        heading: z
          .string()
          .describe("Heading text only — no # prefix; must match a heading in the file (see vault_outline)"),
        operation: z
          .enum(["append", "prepend", "replace"])
          .describe("append — add to end of section; prepend — add right after heading line; replace — replace section body (keeps heading)"),
        content: z.string().describe("Content to add, or replacement body for a replace operation"),
      }),
    },
    async ({ path, heading, operation, content }) => {
      try {
        await vault.editNoteSection(path, heading, operation, content);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        // Ambiguous-heading errors carry their own recovery guidance — don't append
        // the "call vault_outline first" hint, which only fits the missing-heading case.
        if (e instanceof vault.AmbiguousHeadingError) {
          return { content: [{ type: "text", text: message }], isError: true };
        }
        const hint = message.startsWith("Heading ")
          ? " — call vault_outline first and copy heading text exactly (without # prefix)."
          : "";
        return { content: [{ type: "text", text: `${message}${hint}` }], isError: true };
      }
      return { content: [{ type: "text", text: `Edited ${path} section "${heading}" (${operation})` }] };
    },
  );

  registerLogged(server,
    "vault_trash",
    {
      title: "Trash vault note",
      description: "Move a note to .trash (recoverable). Prefixes with a timestamp to avoid collisions.",
      inputSchema: z.object({
        path: z.string().describe("Relative path to the note"),
      }),
    },
    async ({ path }) => {
      await vault.trashNote(path);
      return { content: [{ type: "text", text: `Moved ${path} to .trash` }] };
    },
  );

  registerLogged(server,
    "vault_move",
    {
      title: "Move or rename a vault file",
      description:
        "Move or rename a file within the vault and rewrite the wikilinks that point at it. source and destination are explicit vault-relative paths (with extension) — bare titles are not resolved; call vault_search_title first to find the path. Works on any file type (notes, canvases, bases, attachments). Creates missing parent folders and fails if a file already exists at the destination. dry_run defaults to true: it shows the full rewrite plan and writes nothing. Pass dry_run: false to move the file and apply the rewrites. A pure move (same name, new folder) leaves bare [[Name]] links alone; a rename rewrites every form. .base files are never edited, only flagged for review.",
      inputSchema: z.object({
        source: z.string().describe("Explicit vault-relative path of the file to move (with extension)"),
        destination: z.string().describe("Explicit vault-relative path to move the file to (with extension)"),
        dry_run: z.boolean().optional().default(true).describe("If true (default), return the rewrite plan and write nothing. Pass false to move the file and rewrite links."),
      }),
    },
    async ({ source, destination, dry_run }) => {
      const bareTitle = rejectBareTitle(source) ?? rejectBareTitle(destination);
      if (bareTitle) {
        return { content: [{ type: "text", text: bareTitle }], isError: true };
      }

      // Dry run: plan only, write nothing — not even the move. The plan reports every file it
      // would touch, .base files to review, and ambiguous links it would skip.
      if (dry_run) {
        try {
          const plan = await vault.planReferenceRewrite(source, destination);
          return { content: [{ type: "text", text: formatMovePlan(plan) }] };
        } catch (e) {
          if (e instanceof vault.VaultPolicyError) {
            return { content: [{ type: "text", text: e.message }], isError: true };
          }
          throw e;
        }
      }

      // Write mode: plan, move the file (the near-infallible step), then apply the rewrites (the
      // many-failure-point step). Planning before the move means link matching sees the file at its
      // old path; the rewrite recomputes against current text under each file's lock.
      try {
        const plan = await vault.planReferenceRewrite(source, destination);
        await vault.moveFile(source, destination);
        const result = await vault.applyReferenceRewrite(plan);
        return { content: [{ type: "text", text: formatMoveReport(result) }] };
      } catch (e) {
        if (e instanceof vault.NoteExistsError) {
          return { content: [{ type: "text", text: `Error: file already exists at ${destination}. Choose a different destination or trash the existing file first.` }], isError: true };
        }
        if (e instanceof vault.VaultPolicyError) {
          return { content: [{ type: "text", text: e.message }], isError: true };
        }
        throw e;
      }
    },
  );

  registerLogged(server,
    "vault_search_title",
    {
      title: "Search vault by note title",
      description:
        "Find notes by filename (partial or exact match). Returns relative paths — use before vault_read when you know a title fragment but not the path.",
      inputSchema: z.object({
        title: z.string().describe("Note title or partial title (filename without .md)"),
        exact: z.boolean().optional().default(false).describe("If true, require full filename match"),
        limit: z.number().optional().default(50).describe("Max matches (default 50, 0 = no limit)"),
      }),
    },
    async ({ title, exact, limit }) => titleSearchToolResult(title, exact, limit),
  );

  registerLogged(server,
    "vault_search_content",
    {
      title: "Search vault note contents",
      description:
        "Regex search across markdown bodies. Prefer folder to scope large vaults. Returns paths with matching line snippets.",
      inputSchema: z.object({
        query: z.string().describe("Regex pattern to search for in .md files"),
        folder: z.string().optional().describe('Limit search to this subfolder (e.g. "02-Notes"). Strongly recommended in large vaults.'),
        limit: z.number().optional().default(20).describe("Max files with matches (default 20, 0 = no limit)"),
        case_sensitive: z.boolean().optional().default(false).describe("Case-sensitive regex (default false)"),
      }),
    },
    async ({ query, folder, limit, case_sensitive }) => {
      const results = await vault.searchContent(query, { folder, limit, caseSensitive: case_sensitive });
      if (results.length === 0) {
        return { content: [{ type: "text", text: "No matches found." }] };
      }
      const hitLimit = limit > 0 && results.length === limit;
      const text = results.map((r) => `${r.path}:\n${r.matches.map((m) => `  ${m}`).join("\n")}`).join("\n\n");
      return {
        content: [
          {
            type: "text",
            text: hitLimit ? `${text}\n\n(limit of ${limit} reached — use folder to narrow the search)` : text,
          },
        ],
      };
    },
  );

  registerLogged(server,
    "vault_search_frontmatter",
    {
      title: "Search vault by frontmatter property",
      description:
        "Find notes by a frontmatter (YAML property) value. match_type: exact = equals (for a list property, matches when any element equals the value); contains = case-insensitive substring (per element for lists); exists = the property is present, value ignored. Date properties match by their YYYY-MM-DD calendar date (e.g. exact: 2026-01-15). Use folder to scope large vaults. Returns matching paths with the property's value.",
      inputSchema: z.object({
        field: z.string().describe("Frontmatter property name (top-level key)"),
        value: z.string().optional().describe("Value to match. Required for exact/contains; ignored for exists."),
        match_type: z.enum(["exact", "contains", "exists"]).optional().default("exact").describe("How to match the value (default exact)"),
        folder: z.string().optional().describe('Limit the scan to this subfolder (e.g. "02-Notes").'),
        limit: z.number().optional().default(20).describe("Max matching notes (default 20, 0 = no limit)"),
      }),
    },
    async ({ field, value, match_type, folder, limit }) => {
      if (match_type !== "exists" && (value === undefined || value === "")) {
        return {
          content: [{ type: "text", text: `Error: value is required for match_type "${match_type}". Pass a value, or use match_type "exists" to match any note that has the "${field}" property.` }],
          isError: true,
        };
      }
      const results = await vault.searchFrontmatter(field, { value, matchType: match_type, folder, limit });
      if (results.length === 0) {
        return { content: [{ type: "text", text: "No matching notes found." }] };
      }
      const text = results.map((r) => `${r.path}\t${field}: ${renderFrontmatterValue(r.frontmatter[field])}`).join("\n");
      const hitLimit = limit > 0 && results.length === limit;
      return {
        content: [
          {
            type: "text",
            text: hitLimit ? `${text}\n\n(limit of ${limit} reached — increase limit or pass a folder to narrow)` : text,
          },
        ],
      };
    },
  );

  registerLogged(server,
    "vault_tags",
    {
      title: "List vault tags or notes by tag",
      description:
        "Without a tag, list every tag in the vault with note counts, sorted by count descending (capped by limit, with a truncation warning when the cap is hit). With a tag, return the paths of notes carrying it. Counts both frontmatter `tags` (YAML array or comma string) and inline `#tag`, including nested tags like `parent/child`. Matching is case-insensitive and displays first-seen casing; nested tags are exact — querying `parent` does not match `parent/child`. Use folder to scope large vaults.",
      inputSchema: z.object({
        tag: z.string().optional().describe('A tag to look up (with or without leading #). Omit to list all tags with counts.'),
        folder: z.string().optional().describe('Limit the scan to this subfolder (e.g. "02-Notes").'),
        limit: z.number().optional().default(100).describe("When listing all tags: max tags to return (default 100, 0 = no limit)."),
      }),
    },
    async ({ tag, folder, limit }) => {
      if (tag !== undefined && tag.trim().length > 0) {
        const paths = await vault.getNotesByTag(tag, { folder });
        if (paths.length === 0) {
          return { content: [{ type: "text", text: `No notes found with tag "${tag.trim().replace(/^#/, "")}".` }] };
        }
        return { content: [{ type: "text", text: paths.join("\n") }] };
      }
      const tags = await vault.getAllTags({ folder });
      if (tags.length === 0) {
        return { content: [{ type: "text", text: "No tags found." }] };
      }
      const capped = limit > 0 ? tags.slice(0, limit) : tags;
      const lines = capped.map((t) => `${t.tag}\t${t.noteCount}`);
      const text = lines.join("\n");
      const truncated = limit > 0 && tags.length > limit;
      return {
        content: [
          {
            type: "text",
            text: truncated
              ? `${text}\n\n(showing top ${limit} of ${tags.length} tags — increase limit or pass a folder to narrow)`
              : text,
          },
        ],
      };
    },
  );

  registerLogged(server,
    "vault_periodic_note",
    {
      title: "Get or create periodic note",
      description: `Get or create a daily, weekly, monthly, quarterly, or yearly note using the cadence's configured path template. The optional date is bucketed into the week, month, quarter, or year that contains it. Defaults to today.`,
      inputSchema: z.object({
        period: z.enum(["daily", "weekly", "monthly", "quarterly", "yearly"]).describe("Which cadence of note to get or create"),
        date: z.string().optional().describe("Date in YYYY-MM-DD format, bucketed into its containing period (defaults to today)"),
        create_if_missing: z.boolean().optional().default(true).describe("Create the note if it does not exist (default true)"),
        template: z.string().optional().describe("Content to use when creating a new note"),
      }),
    },
    async ({ period, date, create_if_missing, template }) => {
      let parsed: Date | undefined;
      if (date !== undefined) {
        const p = parseLocalYmd(date);
        if (!p) {
          return {
            content: [{ type: "text", text: `Error: invalid date "${date}". Expected YYYY-MM-DD (e.g. 2026-04-25).` }],
            isError: true,
          };
        }
        parsed = p;
      }
      const notePath = vault.getPeriodicNotePath(period, parsed);
      if (notePath === null) {
        const envVar = vault.getPeriodicNoteTemplateEnvVar(period);
        return {
          content: [{ type: "text", text: `Error: no ${period} note template configured. Set the ${envVar} environment variable.` }],
          isError: true,
        };
      }
      const dateStr = date ?? localYmd(new Date());

      try {
        const content = await vault.readNote(notePath);
        return { content: [{ type: "text", text: `Path: ${notePath}\n\n${content}` }] };
      } catch {
        if (!create_if_missing) {
          return { content: [{ type: "text", text: `No ${period} note found at ${notePath}` }] };
        }
        const noteContent = template ?? `# ${dateStr}\n\n`;
        await vault.writeNote(notePath, noteContent);
        return { content: [{ type: "text", text: `Created: ${notePath}\n\n${noteContent}` }] };
      }
    },
  );

  if (!isLoggingEnabled()) return;

  registerLogged(server,
    "vault_feedback",
    {
      title: "Submit feedback about vault tools",
      description:
        "Call when you can't accomplish a vault task with the existing tools, when a tool's behavior surprised you, or when an error message wasn't actionable. Records your goal, what you tried, and where you got stuck so the vault owner can improve the tools. Optional: name a missing tool that would have helped.",
      inputSchema: z.object({
        goal: z.string().describe("What you were trying to accomplish (one sentence)"),
        attempted: z.string().describe("What tools/args you tried"),
        stuck_on: z.string().describe("What blocked you — error message, missing capability, or surprising behavior"),
        suggested_tool: z.string().optional().describe("Optional: name and brief description of a tool that would have helped"),
      }),
    },
    async ({ goal, attempted, stuck_on, suggested_tool }) => {
      logFeedback({ goal, attempted, stuck_on, suggested_tool });
      return { content: [{ type: "text", text: "Feedback recorded. Thanks." }] };
    },
  );
}
