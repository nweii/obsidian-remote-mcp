// ABOUTME: Registers all vault tools on an McpServer - context, read, outline, read_section, links, create, update, edit, trash, find, search, daily note.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as vault from "./vault.js";

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
      description: "Read full note content by path. Use vault_find first if you only have a title.",
      inputSchema: z.object({
        path: z.string().describe('Relative path to the note (e.g. "Projects/plan.md")'),
      }),
    },
    async ({ path }) => {
      const content = await vault.readNote(path);
      return { content: [{ type: "text", text: content }] };
    },
  );

  server.registerTool(
    "vault_frontmatter",
    {
      title: "Read note frontmatter",
      description: "Read all YAML frontmatter properties from a note without loading the full body.",
      inputSchema: z.object({
        path: z.string().describe("Relative path to the note"),
      }),
    },
    async ({ path }) => {
      const frontmatter = await vault.getFrontmatter(path);
      if (frontmatter === null) {
        return { content: [{ type: "text", text: "(no frontmatter)" }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(frontmatter, null, 2) }] };
    },
  );

  server.registerTool(
    "vault_frontmatter_property",
    {
      title: "Read note frontmatter property",
      description: "Read one frontmatter property from a note by name.",
      inputSchema: z.object({
        path: z.string().describe("Relative path to the note"),
        name: z.string().describe("Frontmatter property name"),
      }),
    },
    async ({ path, name }) => {
      const value = await vault.getFrontmatterProperty(path, name);
      if (value === undefined) {
        return { content: [{ type: "text", text: `Property "${name}" not found.` }] };
      }
      return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
    },
  );

  server.registerTool(
    "vault_outline",
    {
      title: "Get note outline",
      description: "Get the heading structure of a note (all # lines). Use before vault_read_section to see what sections exist without loading full content.",
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
      title: "Read vault note section",
      description: "Read a single heading section from a note instead of the full content. Use vault_outline first to see available headings.",
      inputSchema: z.object({
        path: z.string().describe("Relative path to the note"),
        heading: z.string().describe("Heading text to find (case-insensitive, without # prefix)"),
      }),
    },
    async ({ path, heading }) => {
      const content = await vault.readNoteSection(path, heading);
      return { content: [{ type: "text", text: content }] };
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
    "vault_find",
    {
      title: "Find note by title",
      description: "Find notes by title (matches filenames without .md, case-insensitive). Use this to resolve a title to a path before reading or editing. Try this before vault_search_content.",
      inputSchema: z.object({
        title: z.string().describe("Note title or partial title to search for"),
        exact: z.boolean().optional().default(false).describe("If true, requires a full filename match (default false = partial match)"),
        limit: z.number().optional().default(50).describe("Max matching notes to return (default 50, 0 = no limit)"),
      }),
    },
    async ({ title, exact, limit }) => {
      const results = await vault.findByTitle(title, exact, limit);
      if (results.length === 0) {
        return { content: [{ type: "text", text: `No notes found matching "${title}".` }] };
      }
      const hitLimit = limit > 0 && results.length === limit;
      const text = results.map((r) => r.path).join("\n");
      return { content: [{ type: "text", text: hitLimit ? `${text}\n\n(limit of ${limit} reached — increase limit or use a more specific title)` : text }] };
    },
  );

  server.registerTool(
    "vault_search_content",
    {
      title: "Search vault content",
      description: "Regex search across note content. Use folder to scope — the vault is large. Try vault_find first if searching by title.",
      inputSchema: z.object({
        query: z.string().describe("Regex pattern to search for"),
        folder: z.string().optional().describe('Scope to a subfolder (e.g. "02-Notes"). Strongly recommended.'),
        limit: z.number().optional().default(20).describe("Max matching files to return (default 20, 0 = no limit). Walk stops early."),
        case_sensitive: z.boolean().optional().default(false).describe("Case-sensitive match (default false)"),
      }),
    },
    async ({ query, folder, limit, case_sensitive }) => {
      const results = await vault.searchContent(query, { folder, limit, caseSensitive: case_sensitive });
      if (results.length === 0) {
        return { content: [{ type: "text", text: "No matches found." }] };
      }
      const hitLimit = results.length === limit;
      const text = results.map((r) => `${r.path}:\n${r.matches.map((m) => `  ${m}`).join("\n")}`).join("\n\n");
      return { content: [{ type: "text", text: hitLimit ? `${text}\n\n(limit of ${limit} reached — use folder to narrow the search)` : text }] };
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
