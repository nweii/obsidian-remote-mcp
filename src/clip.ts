// ABOUTME: Registers the vault_clip_url tool conditionally — if web-clipper-headless is installed,
// the tool is exposed; if not, registration is skipped silently. Tool returns rendered content
// (or a needs_interpretation shape for the chat-flow path); caller writes via vault_create.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { registerLogged } from "./register-logged.js";

// Local interface declarations for web-clipper-headless. The package's own .ts source isn't
// directly consumable by this tsconfig; we treat its module surface as opaque and shim the
// shape we use here.
interface ClipperRenderedResult {
  status: "rendered";
  filename: string;
  fullContent: string;
  template: { name: string; path?: string };
  matchedBy: "explicit" | "trigger";
  resolvedSlots: Record<string, string>;
}
interface ClipperNeedsInterpretation {
  status: "needs_interpretation";
  unresolvedSlots: Array<{
    key: string;
    prompt: string;
    filterChain?: string;
    location: { kind: string; propertyName?: string };
  }>;
  pageContent: {
    url: string;
    title?: string;
    body: string;
    suspiciousPhrasesDetected?: string[];
  };
  preparedState: unknown;
  template: { name: string };
}
type ClipperResult = ClipperRenderedResult | ClipperNeedsInterpretation;

interface ClipperLib {
  installPolyfills(): void;
  renderFromSettings(opts: {
    url: string;
    settingsPath: string;
    templateName?: string;
    useInterpreter?: boolean;
    slotOverrides?: Record<string, string>;
    variableOverrides?: Record<string, string>;
  }): Promise<ClipperResult & { template: ClipperRenderedResult["template"] }>;
}

async function tryLoadClipper(): Promise<ClipperLib | null> {
  try {
    const mod = (await import("web-clipper-headless")) as unknown as ClipperLib;
    if (typeof mod.installPolyfills !== "function") return null;
    mod.installPolyfills();
    return mod;
  } catch {
    return null;
  }
}

async function resolveSettingsPath(vaultRoot: string): Promise<string | null> {
  const fromEnv = process.env.WEB_CLIPPER_SETTINGS_PATH?.trim();
  if (fromEnv) return path.isAbsolute(fromEnv) ? fromEnv : path.join(vaultRoot, fromEnv);

  const candidates = await scanVaultForSettings(vaultRoot);
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0]!.path;
}

async function scanVaultForSettings(
  root: string,
  depth = 4
): Promise<Array<{ path: string; mtime: number }>> {
  const results: Array<{ path: string; mtime: number }> = [];
  async function walk(dir: string, remaining: number): Promise<void> {
    if (remaining < 0) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, remaining - 1);
      } else if (
        entry.isFile() &&
        /obsidian-web-clipper-settings.*\.json$/.test(entry.name)
      ) {
        try {
          const stat = await fs.stat(full);
          results.push({ path: full, mtime: stat.mtimeMs });
        } catch {
          // ignore
        }
      }
    }
  }
  await walk(root, depth);
  return results;
}

export async function registerClipTool(server: McpServer, vaultRoot: string): Promise<void> {
  const clipper = await tryLoadClipper();
  if (!clipper) {
    console.error(
      "[obsidian-remote-mcp] web-clipper-headless not available; skipping vault_clip_url registration. Run `bun install && bun run setup:clipper` if you want this tool."
    );
    return;
  }

  registerLogged(
    server,
    "vault_clip_url",
    {
      title: "Clip URL using a Web Clipper template",
      description:
        "Fetch a URL, render it through one of your Obsidian Web Clipper templates, and return the resulting Markdown note (frontmatter + body). Caller writes the note via vault_create. " +
          "If template_name is omitted, the template is auto-matched against the URL via each template's `triggers` array (URL prefix, regex, or schema:@Type) — same as the browser extension. Explicit template_name overrides auto-match. " +
          "When use_server_interpreter is true the server runs the LLM interpreter for any {{\"prompt\"}} slots in the template; otherwise the response shape is `needs_interpretation` and the caller fills slots itself, then calls again with slot_overrides. " +
          "variable_overrides patches caller-supplied values onto defuddle's auto-extracted variables — use for pages where defuddle can't see the rendered body (e.g. X/Twitter URLs where you've fetched the thread via another tool and want to inject its markdown as `content`).",
      inputSchema: z.object({
        url: z.string().url().describe("Public URL to clip. Auth-walled pages will fail to extract."),
        template_name: z
          .string()
          .optional()
          .describe(
            "Template name from your Web Clipper settings JSON. If omitted, auto-match by triggers."
          ),
        use_server_interpreter: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "If true, server runs the LLM interpreter for any unresolved slots. If false, returns `needs_interpretation` for the caller to handle."
          ),
        slot_overrides: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            "Pre-resolved interpreter slot values, keyed by slot key from a prior `needs_interpretation` response. Skips LLM dispatch for those slots."
          ),
        variable_overrides: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            "Corrective values patched onto defuddle's variables before template compilation. Keys are bare variable names like `content`, `title`, `author`. Defuddle still runs for everything not overridden; trigger matching is unaffected. Use this when a sibling tool produced cleaner body text than defuddle can extract from a JS-rendered page."
          ),
      }),
    },
    async ({ url, template_name, use_server_interpreter, slot_overrides, variable_overrides }) => {
      const settingsPath = await resolveSettingsPath(vaultRoot);
      if (!settingsPath) {
        return errorResponse(
          "No Web Clipper settings JSON found. Set WEB_CLIPPER_SETTINGS_PATH (relative to vault root or absolute), or place a file matching `*obsidian-web-clipper-settings*.json` somewhere in the vault."
        );
      }

      try {
        const result = await clipper.renderFromSettings({
          url,
          settingsPath,
          templateName: template_name,
          useInterpreter: use_server_interpreter,
          slotOverrides: slot_overrides,
          variableOverrides: variable_overrides,
        });

        if (result.status === "rendered") {
          const suggested = result.template.path
            ? path.posix.join(result.template.path, result.filename + ".md")
            : result.filename + ".md";

          const payload = {
            status: "rendered",
            filename: result.filename,
            suggested_path: suggested,
            template_used: result.template.name,
            matched_by: result.matchedBy,
            content: result.fullContent,
          };
          return {
            content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
          };
        }

        const payload = {
          status: "needs_interpretation",
          template: result.template.name,
          unresolved_slots: result.unresolvedSlots.map((s) => ({
            key: s.key,
            location: describeLocation(s.location),
            prompt: s.prompt,
            filters: s.filterChain ?? null,
          })),
          page_content: {
            source: "external_url",
            trusted: false,
            url: result.pageContent.url,
            title: result.pageContent.title ?? null,
            body: result.pageContent.body,
            suspicious_phrases_detected: result.pageContent.suspiciousPhrasesDetected ?? [],
          },
          prepared_state: result.preparedState,
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const errorName = err instanceof Error ? err.name : "";
        // Tag known structured error classes so the calling agent can act on them
        // (TemplateRequiresUserInputError, TemplateMatchFailedError, MissingProviderError)
        // without parsing the message string.
        const tag = errorName.endsWith("Error") ? errorName : "Error";
        return errorResponse(`[${tag}] ${message}`);
      }
    }
  );
}

function errorResponse(text: string) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text }],
  };
}

function describeLocation(loc: { kind: string; propertyName?: string }): string {
  if (loc.kind === "property") return `property:${loc.propertyName}`;
  return loc.kind;
}
