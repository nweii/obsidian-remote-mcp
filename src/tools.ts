// ABOUTME: Registers all vault tools on an McpServer - context, read (full/list), outline, read section, frontmatter, links, writes, title search, content search, daily note, clip URL, feedback.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as vault from "./vault.js";
import { registerClipTool } from "./clip.js";
import { logFeedback, isLoggingEnabled } from "./log.js";
import { parseLocalYmd, localYmd } from "./date.js";
import { registerLogged, type ToolResult } from "./register-logged.js";

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

// vault_update takes the same path/bare-title input as vault_read, and vault_read records the
// note's version against its *resolved* path. updateNote must operate on that same resolved
// path or the version/merge guarantee silently won't apply (and a brand-new file could be
// written at the unresolved path). Resolve to an existing note when possible; fall back to the
// literal input when it doesn't resolve (e.g. creating a new note). Policy/EISDIR errors
// propagate as before.
async function resolveForWrite(input: string): Promise<string> {
  try {
    const ref = await vault.resolveNoteReference(input);
    return ref.path;
  } catch (e) {
    if (e instanceof vault.VaultPolicyError) throw e;
    if ((e as NodeJS.ErrnoException)?.code === "EISDIR") throw e;
    return input;
  }
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
        text: `(version: ${version} — to update this note safely, pass base_version: "${version}" to vault_update so it rejects the write instead of overwriting a concurrent edit by another session.)`,
      });
      return result;
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
        "Return the body from one heading through the next same-or-higher-level heading. Pass heading text without # (case-insensitive). Prefer calling vault_outline first and copy the heading text after the #'s.",
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
        await vault.readNote(path);
        return { content: [{ type: "text", text: `Error: file already exists at ${path}. To replace it, use vault_update; to modify part of it, use vault_edit.` }], isError: true };
      } catch {
        // File does not exist — safe to create
      }
      await vault.writeNote(path, content);
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
      description: "Set one YAML frontmatter property on a note without rewriting the body.",
      inputSchema: z.object({
        path: z.string().describe("Relative path to the note"),
        name: z.string().describe("Frontmatter property name"),
        value: z.any().describe("Value to store. Strings, numbers, booleans, arrays, and objects are supported."),
      }),
    },
    async ({ path, name, value }) => {
      await vault.setFrontmatterProperty(path, name, value);
      return { content: [{ type: "text", text: `Set frontmatter property "${name}" on ${path}` }] };
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
        "Edit just one section of a note (heading line through the next same-or-higher heading). Operations: append — add to end of section, before the next heading; prepend — add right after the heading line, before existing body; replace — replace the section body and keep the heading line. Call vault_outline first to get exact heading text.",
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
    "vault_daily_note",
    {
      title: "Get or create daily note",
      description: `Get or create a daily note using the configured path template (${vault.getDailyNoteTemplate()}). Defaults to today.`,
      inputSchema: z.object({
        date: z.string().optional().describe("Date in YYYY-MM-DD format (defaults to today)"),
        create_if_missing: z.boolean().optional().default(true).describe("Create the note if it does not exist (default true)"),
        template: z.string().optional().describe("Content to use when creating a new daily note"),
      }),
    },
    async ({ date, create_if_missing, template }) => {
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
      const notePath = vault.getDailyNotePath(parsed);
      const dateStr = date ?? localYmd(new Date());

      try {
        const content = await vault.readNote(notePath);
        return { content: [{ type: "text", text: `Path: ${notePath}\n\n${content}` }] };
      } catch {
        if (!create_if_missing) {
          return { content: [{ type: "text", text: `No daily note found at ${notePath}` }] };
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
