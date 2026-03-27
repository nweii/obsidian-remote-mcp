// ABOUTME: Registers all vault tools on an McpServer - context, read (full/list), outline, read section, frontmatter, links, writes, title search, content search, daily note.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as vault from "./vault.js";

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

export function registerTools(server: McpServer) {
  server.registerTool(
    "vault_context",
    {
      title: "Vault context",
      description:
        "Returns the vault guidance note configured by VAULT_CONTEXT_PATH, or falls back to AGENTS.md / CLAUDE.md when present. Call this at the start of a session to learn vault structure/conventions.",
      inputSchema: z.object({}),
    },
    async () => {
      const contextPath = vault.getContextNotePath();
      if (!contextPath) {
        return {
          content: [
            {
              type: "text",
              text: "No vault context note found. Set VAULT_CONTEXT_PATH, or add AGENTS.md or CLAUDE.md at the vault root.",
            },
          ],
        };
      }
      const content = await vault.readNote(contextPath);
      return { content: [{ type: "text", text: content }] };
    },
  );

  server.registerTool(
    "vault_read",
    {
      title: "Read vault note",
      description:
        'Read full note text (mode full, default) or list one folder level (mode list; path "" = vault root). For # headings only use vault_outline; for one section under a heading use vault_read_section after vault_outline. If you only have a note title, use vault_search_title first.',
      inputSchema: z.object({
        path: z
          .string()
          .describe('Note path when mode is full, or folder path when mode is list (use "" for vault root).'),
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
      try {
        const content = await vault.readNote(path);
        return { content: [{ type: "text", text: content }] };
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err?.code === "EISDIR") {
          return {
            content: [
              {
                type: "text",
                text: `Error: "${path}" is a directory, not a note. Use mode "list" with the same path (or path "") to browse.`,
              },
            ],
            isError: true,
          };
        }
        throw e;
      }
    },
  );

  server.registerTool(
    "vault_outline",
    {
      title: "Note heading outline",
      description:
        "List all markdown headings (# through ######) in one note, one per line with # prefix (like Obsidian CLI `obsidian outline`). Use before vault_read_section to get exact heading text.",
      inputSchema: z.object({
        path: z.string().describe("Relative path to the note"),
      }),
    },
    async ({ path }) => {
      const headings = await vault.getNoteOutline(path);
      if (headings.length === 0) return { content: [{ type: "text", text: "(no headings)" }] };
      return { content: [{ type: "text", text: headings.join("\n") }] };
    },
  );

  server.registerTool(
    "vault_read_section",
    {
      title: "Read note section under heading",
      description:
        "Return the body from one heading through the next same-or-higher-level heading. Pass heading text without # (case-insensitive). Prefer calling vault_outline first and copy the heading text after the #'s.",
      inputSchema: z.object({
        path: z.string().describe("Relative path to the note"),
        heading: z
          .string()
          .describe("Heading text only — no # prefix; must match a heading in the file (see vault_outline)"),
      }),
    },
    async ({ path, heading }) => {
      try {
        const content = await vault.readNoteSection(path, heading);
        return { content: [{ type: "text", text: content }] };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return { content: [{ type: "text", text: message }], isError: true };
      }
    },
  );

  server.registerTool(
    "vault_frontmatter",
    {
      title: "Read note frontmatter",
      description:
        "Read YAML frontmatter from a note without loading the full body. Omit property for all keys; set property to read one key.",
      inputSchema: z.object({
        path: z.string().describe("Relative path to the note"),
        property: z.string().optional().describe("If set, return only this frontmatter key"),
      }),
    },
    async ({ path, property }) => {
      if (property !== undefined && property.length > 0) {
        const value = await vault.getFrontmatterProperty(path, property);
        if (value === undefined) {
          return { content: [{ type: "text", text: `Property "${property}" not found.` }] };
        }
        return {
          content: [
            {
              type: "text",
              text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
            },
          ],
        };
      }
      const frontmatter = await vault.getFrontmatter(path);
      if (frontmatter === null) {
        return { content: [{ type: "text", text: "(no frontmatter)" }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(frontmatter, null, 2) }] };
    },
  );

  server.registerTool(
    "vault_links",
    {
      title: "Get note links",
      description: "Get outgoing [[wikilinks]] from a note with resolved paths, and optionally backlinks (notes that link to it). Use to navigate the graph without reading full content.",
      inputSchema: z.object({
        path: z.string().describe("Relative path to the note"),
        include_backlinks: z.boolean().optional().default(false).describe("Also return notes that link to this one (default false)"),
        backlinks_limit: z.number().optional().default(20).describe("Max backlinks to return (default 20, 0 = no limit)"),
      }),
    },
    async ({ path, include_backlinks, backlinks_limit }) => {
      const links = await vault.getNoteLinks(path);
      const lines: string[] = ["## Outgoing links"];
      if (links.length === 0) {
        lines.push("(none)");
      } else {
        for (const l of links) {
          lines.push(l.path ? `- [[${l.title}]] → ${l.path}` : `- [[${l.title}]] (not found)`);
        }
      }
      if (include_backlinks) {
        const backlinks = await vault.getBacklinks(path, backlinks_limit);
        lines.push("", "## Backlinks");
        if (backlinks.length === 0) {
          lines.push("(none found)");
        } else {
          for (const b of backlinks) lines.push(`- ${b}`);
        }
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  server.registerTool(
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
        return { content: [{ type: "text", text: `Error: file already exists at ${path}` }], isError: true };
      } catch {
        // File does not exist — safe to create
      }
      await vault.writeNote(path, content);
      return { content: [{ type: "text", text: `Created ${path}` }] };
    },
  );

  server.registerTool(
    "vault_update",
    {
      title: "Update vault note",
      description: "Replace the entire content of an existing note. For section-level changes, prefer vault_edit to avoid resending the full note.",
      inputSchema: z.object({
        path: z.string().describe("Relative path to the note"),
        content: z.string().describe("New content to write"),
      }),
    },
    async ({ path, content }) => {
      await vault.writeNote(path, content);
      return { content: [{ type: "text", text: `Updated ${path}` }] };
    },
  );

  server.registerTool(
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

  server.registerTool(
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
        const existing = await vault.readNote(path);
        await vault.writeNote(path, content + existing);
      } else {
        if (!find) {
          return { content: [{ type: "text", text: "Error: find is required for replace operation" }], isError: true };
        }
        const existing = await vault.readNote(path);
        await vault.writeNote(path, existing.replace(find, content));
      }
      return { content: [{ type: "text", text: `Edited ${path} (${operation})` }] };
    },
  );

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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
      const parsed = date ? new Date(date) : undefined;
      const notePath = vault.getDailyNotePath(parsed);
      const dateStr = date ?? new Date().toISOString().split("T")[0];

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
}
