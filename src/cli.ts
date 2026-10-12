// ABOUTME: Opt-in tools backed by the first-party `obsidian` CLI: vault_cli_help (commands parsed from
// `obsidian help`) and vault_cli (run one command). Guards keep the CLI from running code on the host
// or reaching around the vault access policy. Also answers backlinks from Obsidian when it can.
import type { McpServer } from "@modelcontextprotocol/server";
import { execFile } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import * as vault from "./vault.js";
import { logToolCall, type ToolResult } from "./log.js";

const TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
// How long an unavailable result stands before the next request probes again. Obsidian may still
// be starting when the server does.
const UNAVAILABLE_RECHECK_MS = 30_000;
// A pass is re-checked this often too, so the CLI's vault name can't drift to another folder
// for long without the server noticing.
const AVAILABLE_RECHECK_MS = 5 * 60_000;
// Backlinks fall back to the server's search, so a slow app shouldn't hold vault_links up.
const BACKLINKS_TIMEOUT_MS = 5_000;

// --- Guards ----------------------------------------------------------------------

// Commands that run code, change the app, or install code. Fixed, with no env override.
const BLOCKED_COMMANDS = new Set(["eval", "devtools", "restart", "reload", "plugins:restrict", "theme:install"]);
const BLOCKED_PREFIXES = ["dev:", "plugin:", "snippet:"];

// Commands that only read. In read-only mode nothing else runs, so a command added by a future CLI
// release stays refused until it is listed here.
const KNOWN_READ_COMMANDS = new Set([
  "help", "version", "aliases", "backlinks", "base:query", "base:views", "bases", "bookmarks", "commands",
  "daily:path", "daily:read", "deadends", "diff", "file", "files", "folder", "folders", "history",
  "history:list", "history:read", "hotkey", "hotkeys", "links", "orphans", "outline", "plugin", "plugins",
  "plugins:enabled", "properties", "property:read", "publish:list", "publish:site", "publish:status",
  "random:read", "read", "recents", "search", "search:context", "snippets", "snippets:enabled", "sync:deleted",
  "sync:history", "sync:read", "sync:status", "tabs", "tag", "tags", "tasks", "template:read", "templates",
  "theme", "themes", "unresolved", "vault", "wordcount", "workspace", "workspaces",
]);

// Command-palette IDs matching this run only when listed by name, never through `*`.
const DESTRUCTIVE_PALETTE_ID = /delete|remove|purge|trash|erase|wipe|destroy|discard|uninstall|reset|clear|overwrite/i;

// Parameters naming a vault location. Each goes through the same path policy as every other tool.
const PATH_PARAMS = ["path", "to", "folder"];

const COMMAND_NAME = /^[a-z][a-z-]*(?::[a-z][a-z-]*)?$/;
const KEY_OR_FLAG = /^[a-z][a-z-]*$/;

export interface CliRequest {
  command: string;
  params?: Record<string, string>;
  flags?: string[];
}

export type CliOutcome = { ok: true; output: string } | { ok: false; error: string; output?: string };

function isBlocked(command: string): boolean {
  return BLOCKED_COMMANDS.has(command) || BLOCKED_PREFIXES.some(prefix => command.startsWith(prefix));
}

function paletteAllowlist(): string[] {
  return (process.env.OBSIDIAN_CLI_COMMANDS ?? "").split(",").map(id => id.trim()).filter(Boolean);
}

// Whether a command may run under the current mode, ignoring its arguments. Shared by the help
// listing, so the list shows only what vault_cli will accept.
function commandRefusal(command: string): string | null {
  if (!COMMAND_NAME.test(command)) return `"${command}" is not a valid command name.`;
  if (isBlocked(command)) return `"${command}" is blocked: it can run code or change the app.`;
  if (vault.isReadOnly() && !KNOWN_READ_COMMANDS.has(command)) {
    return `"${command}" is not on the known-read list, and the vault is in read-only mode.`;
  }
  if (command === "command" && paletteAllowlist().length === 0) {
    return `Command-palette execution is off. The server operator can list allowed command IDs in OBSIDIAN_CLI_COMMANDS.`;
  }
  return null;
}

function paletteRefusal(id: string | undefined): string | null {
  if (!id) return `"command" needs an id parameter.`;
  const allowed = paletteAllowlist();
  if (allowed.includes(id)) return null;
  if (allowed.includes("*") && !DESTRUCTIVE_PALETTE_ID.test(id)) return null;
  return `Command ID "${id}" is not allowed by OBSIDIAN_CLI_COMMANDS.`;
}

function argumentRefusal(params: Record<string, string>, flags: string[]): string | null {
  for (const key of [...Object.keys(params), ...flags]) {
    if (!KEY_OR_FLAG.test(key)) return `"${key}" is not a valid parameter or flag name (lowercase letters and hyphens).`;
    if (key === "vault") return `The vault is fixed by the server; "vault" can't be passed.`;
  }
  for (const value of Object.values(params)) {
    if (value.includes("\0")) return "Parameter values can't contain NUL characters.";
  }
  if (params.name !== undefined && /[/\\]/.test(params.name)) {
    return `"name" takes a plain name; pass a location with path= instead.`;
  }
  return null;
}

const notFound = (value: string): CliOutcome => ({ ok: false, error: `Not found: ${value}` });

// The vault root, however it is spelled. It is a valid folder for listings but overlaps the
// policy file, so the write check would refuse it.
const isVaultRoot = (value: string) => path.posix.normalize(value.trim().replace(/^\/+/, "") || ".") === ".";

// Checks every path-like parameter against the vault policy, with the write checks (which also
// protect .mcpignore) since a command may write there. file= (Obsidian's own name resolution)
// becomes path= resolved by the server, so Obsidian can't pick a protected note the server
// wouldn't. A command that may write can't target a folder through path=, since that would act on
// descendants this check never sees; vault_move and vault_trash handle folders. A protected
// location gets the same answer as a missing one.
async function applyPathPolicy(
  command: string,
  params: Record<string, string>,
): Promise<{ ok: true; params: Record<string, string> } | { ok: false; outcome: CliOutcome }> {
  const out = { ...params };
  if (out.file !== undefined) {
    if (out.path !== undefined) return { ok: false, outcome: { ok: false, error: "Pass file or path, not both." } };
    try {
      out.path = (await vault.resolveNoteReference(out.file)).path;
    } catch {
      return { ok: false, outcome: notFound(out.file) };
    }
    delete out.file;
  }
  for (const key of PATH_PARAMS) {
    const value = out[key];
    if (value === undefined || isVaultRoot(value) && key !== "to" && KNOWN_READ_COMMANDS.has(command)) continue;
    let abs: string;
    try {
      abs = vault.resolveSafeWritePath(value);
    } catch (e) {
      if (e instanceof vault.VaultPolicyError) return { ok: false, outcome: notFound(value) };
      throw e;
    }
    if (key === "path" && !KNOWN_READ_COMMANDS.has(command) && isDirectory(abs)) {
      return { ok: false, outcome: { ok: false, error: `vault_cli can't run "${command}" on a folder. Use vault_move or vault_trash for folders.` } };
    }
  }
  return { ok: true, params: out };
}

function isDirectory(abs: string): boolean {
  try {
    return statSync(abs).isDirectory();
  } catch {
    return false;
  }
}

function exists(abs: string): boolean {
  try {
    statSync(abs);
    return true;
  } catch {
    return false;
  }
}

// --- Process -----------------------------------------------------------------------

interface CliConfig {
  binary: string | null;
  vaultName: string;
  root: string;
}

function findOnPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

function cliConfig(): CliConfig {
  const root = vault.getVaultRoot();
  return {
    binary: process.env.OBSIDIAN_CLI_PATH?.trim() || findOnPath("obsidian"),
    vaultName: process.env.OBSIDIAN_CLI_VAULT?.trim() || path.basename(root),
    root,
  };
}

// The CLI may print app-update lines before a command's output. Only leading lines of that shape
// are removed, so note text that happens to start with a timestamp further down is kept.
const STARTUP_NOISE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} (?:Loading|Checking|Downloading|Installing|Updat)/i;

function stripStartupNoise(output: string): string {
  const lines = output.split("\n");
  let start = 0;
  while (start < lines.length && STARTUP_NOISE.test(lines[start]!)) start++;
  return lines.slice(start).join("\n").replace(/\n+$/, "");
}

type ExecResult = { ok: true; stdout: string } | { ok: false; error: string; output: string };

// argv only, never a shell. The vault always comes first, as the CLI requires.
function exec(config: CliConfig, args: string[], timeout = TIMEOUT_MS): Promise<ExecResult> {
  return new Promise(resolve => {
    if (!config.binary) {
      resolve({ ok: false, error: "The obsidian CLI was not found on PATH.", output: "" });
      return;
    }
    execFile(
      config.binary,
      [`vault=${config.vaultName}`, ...args],
      { timeout, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true, encoding: "utf-8" },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ ok: true, stdout: stripStartupNoise(stdout) });
          return;
        }
        const output = stripStartupNoise([stdout, stderr].filter(Boolean).join("\n"));
        const err = error as NodeJS.ErrnoException & { killed?: boolean };
        let message: string;
        if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") message = `output exceeded ${MAX_OUTPUT_BYTES} bytes`;
        else if (err.killed) message = `timed out after ${timeout} ms`;
        else if (typeof err.code === "number") message = `exited with code ${err.code}`;
        else message = `could not start (${err.code ?? "unknown error"})`;
        resolve({ ok: false, error: `obsidian ${args[0]} ${message}.`, output });
      },
    );
  });
}

// --- Availability ------------------------------------------------------------------

export type Availability = { ok: true } | { ok: false; reason: string };

let probeCache: { key: string; result: Availability; at: number } | null = null;

export function resetCliAvailability(): void {
  probeCache = null;
}

async function probe(config: CliConfig): Promise<Availability> {
  if (!config.binary) return { ok: false, reason: "the obsidian CLI was not found (set OBSIDIAN_CLI_PATH or add it to PATH)" };
  const result = await exec(config, ["vault", "info=path"], PROBE_TIMEOUT_MS);
  if (!result.ok) return { ok: false, reason: `the CLI could not reach Obsidian (${result.error})` };
  let same = false;
  try {
    same = realpathSync(result.stdout.trim()) === realpathSync(config.root);
  } catch {
    same = false;
  }
  if (!same) {
    return { ok: false, reason: `the CLI reached a different vault than the server's. Set OBSIDIAN_CLI_VAULT to the vault's name in Obsidian` };
  }
  return { ok: true };
}

// Whether the CLI works for the server's vault. A result is kept until a call fails or it ages
// out, then probed again. The gate is a working CLI, not the presence of the desktop app.
async function cliReachable(config: CliConfig): Promise<Availability> {
  const key = [config.binary, config.vaultName, config.root].join("\n");
  const ttl = probeCache?.result.ok ? AVAILABLE_RECHECK_MS : UNAVAILABLE_RECHECK_MS;
  const fresh = probeCache?.key === key && Date.now() - probeCache.at < ttl;
  if (!fresh) probeCache = { key, result: await probe(config), at: Date.now() };
  return probeCache!.result;
}

const envIsTrue = (name: string) => process.env[name]?.trim().toLowerCase() === "true";

function optedIn(): boolean {
  return envIsTrue("OBSIDIAN_CLI_ENABLED");
}

// CLI output can't be filtered by path, so the tools stay off while .mcpignore hides anything,
// unless the operator acknowledges that.
function mcpignoreRefusal(): string | null {
  if (!vault.hasIgnoreRules()) return null;
  if (envIsTrue("OBSIDIAN_CLI_MCPIGNORE_ACK")) return null;
  return ".mcpignore has rules, and CLI output can't be filtered by them. Set OBSIDIAN_CLI_MCPIGNORE_ACK=true to accept that.";
}

// Whether vault_cli and vault_cli_help should be offered and may run.
export async function cliToolsAvailability(): Promise<Availability> {
  if (!optedIn()) return { ok: false, reason: "OBSIDIAN_CLI_ENABLED is not true" };
  const ignored = mcpignoreRefusal();
  if (ignored) return { ok: false, reason: ignored };
  return cliReachable(cliConfig());
}

const unavailable = (reason: string): CliOutcome => ({ ok: false, error: `The Obsidian CLI is unavailable: ${reason}.` });

// Runs a command; on failure, probes again so an app that went away is reported as such rather
// than as the command's own error.
async function execChecked(config: CliConfig, args: string[]): Promise<CliOutcome> {
  const result = await exec(config, args);
  if (result.ok) return { ok: true, output: result.stdout };
  probeCache = null;
  const reachable = await cliReachable(config);
  if (!reachable.ok) return unavailable(reachable.reason);
  return { ok: false, error: `Error: ${result.error}`, output: result.output };
}

// --- Running and help ----------------------------------------------------------------

export async function runCli(request: CliRequest): Promise<CliOutcome> {
  const params = request.params ?? {};
  const flags = request.flags ?? [];
  const refusal =
    commandRefusal(request.command) ??
    (request.command === "command" ? paletteRefusal(params.id) : null) ??
    argumentRefusal(params, flags);
  if (refusal) return { ok: false, error: refusal };

  const policed = await applyPathPolicy(request.command, params);
  if (!policed.ok) return policed.outcome;

  const available = await cliToolsAvailability();
  if (!available.ok) return unavailable(available.reason);

  const args = [request.command, ...Object.entries(policed.params).map(([k, v]) => `${k}=${v}`), ...flags];
  const outcome = await execChecked(cliConfig(), args);
  // A failure naming a missing note answers exactly as a protected one does, so the difference
  // can't confirm that a protected note exists.
  if (!outcome.ok && policed.params.path !== undefined && !isVaultRoot(policed.params.path) &&
      !exists(vault.resolveSafeWritePath(policed.params.path))) {
    return notFound(policed.params.path);
  }
  return outcome;
}

interface HelpEntry {
  name: string;
  lines: string[];
}

// `obsidian help` lists commands at a two-space indent, with their parameters indented further
// beneath them. Section headings and other text are dropped.
function parseHelp(text: string): HelpEntry[] {
  const entries: HelpEntry[] = [];
  for (const line of text.split("\n")) {
    const command = /^ {2}([a-z][a-z:-]*)(?:\s|$)/.exec(line);
    if (command) entries.push({ name: command[1]!, lines: [line.slice(2).trimEnd()] });
    else if (/^ {3,}\S/.test(line) && entries.length > 0) entries.at(-1)!.lines.push(line.slice(2).trimEnd());
  }
  return entries;
}

// Lists the commands vault_cli will run in the current mode, or shows help for one of them.
export async function cliHelp(command?: string): Promise<CliOutcome> {
  if (command !== undefined) {
    const refusal = commandRefusal(command);
    if (refusal) return { ok: false, error: refusal };
  }
  const available = await cliToolsAvailability();
  if (!available.ok) return unavailable(available.reason);
  const result = await execChecked(cliConfig(), command === undefined ? ["help"] : ["help", command]);
  if (!result.ok || command !== undefined) return result;
  const entries = parseHelp(result.output).filter(e => commandRefusal(e.name) === null);
  if (entries.length === 0) return { ok: false, error: "Could not read any commands from `obsidian help`." };
  return { ok: true, output: entries.map(e => e.lines.join("\n")).join("\n") };
}

// --- Backlinks -----------------------------------------------------------------------

function backlinkPaths(output: string): string[] {
  const parsed: unknown = JSON.parse(output);
  if (!Array.isArray(parsed)) throw new Error("backlinks output is not a list");
  return parsed.map(item => {
    if (typeof item === "string") return item;
    const candidate = item && typeof item === "object" ? ((item as Record<string, unknown>).path ?? (item as Record<string, unknown>).file) : undefined;
    if (typeof candidate !== "string") throw new Error("backlinks entry has no path");
    return candidate;
  });
}

function isAllowedPath(relPath: string): boolean {
  try {
    vault.resolveSafePath(relPath);
    return true;
  } catch (e) {
    if (e instanceof vault.VaultPolicyError) return false;
    throw e;
  }
}

export interface BacklinksResult {
  paths: string[];
  source: "obsidian" | "server";
}

// Backlinks from Obsidian's own link resolution when the CLI is on and reachable, otherwise (or
// when the call fails) from the server's index. Obsidian's answer is filtered through the path
// policy, so it needs no .mcpignore acknowledgment.
export async function resolveBacklinks(relPath: string, limit: number): Promise<BacklinksResult> {
  vault.resolveSafePath(relPath);
  if (optedIn()) {
    const config = cliConfig();
    if ((await cliReachable(config)).ok) {
      const result = await exec(config, ["backlinks", `path=${relPath}`, "format=json"], BACKLINKS_TIMEOUT_MS);
      try {
        if (!result.ok) throw new Error(result.error);
        const paths = backlinkPaths(result.stdout).filter(p => p !== relPath && isAllowedPath(p));
        return { paths: limit > 0 ? paths.slice(0, limit) : paths, source: "obsidian" };
      } catch {
        probeCache = null;
      }
    }
  }
  return { paths: await vault.getBacklinks(relPath, limit), source: "server" };
}

// --- Tool registration -----------------------------------------------------------------

// Like registerLogged, but the audit log records the command, parameter keys and flags only.
// Parameter values can hold note text or search terms, which stay out of the log.
function registerCliTool<T>(
  server: McpServer,
  name: string,
  def: Record<string, unknown>,
  summarize: (args: T) => Record<string, unknown>,
  handler: (args: T) => Promise<ToolResult>,
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server.registerTool as any)(name, def, async (args: T) => {
    const start = Date.now();
    let result: ToolResult | undefined;
    try {
      result = await handler(args);
      return result;
    } finally {
      const ok = result !== undefined && result.isError !== true;
      const first = result?.content?.[0];
      logToolCall({
        tool: name,
        args: summarize(args),
        ok,
        duration_ms: Date.now() - start,
        error: ok ? undefined : first?.type === "text" ? first.text : "threw",
      });
    }
  });
}

// The error goes in the first block (the one the audit log records); CLI output, which can quote
// note text, goes in a second.
function toResult(outcome: CliOutcome): ToolResult {
  if (outcome.ok) return { content: [{ type: "text", text: outcome.output || "(no output)" }] };
  const content: ToolResult["content"] = [{ type: "text", text: outcome.error }];
  if (outcome.output) content.push({ type: "text", text: outcome.output });
  return { content, isError: true };
}

// Tools register on every request, so the operator log notes only changes in availability.
let lastLoggedAvailability: string | null = null;

function logAvailability(available: Availability): void {
  const line = available.ok
    ? `vault_cli enabled: agents can run Obsidian commands, including creating, editing, moving and deleting notes and changing Obsidian Publish${vault.isReadOnly() ? " (read-only mode: known-read commands only)" : ""}`
    : `vault_cli not offered: ${available.reason}`;
  if (line === lastLoggedAvailability) return;
  lastLoggedAvailability = line;
  console.error(`[obsidian-remote-mcp] ${line}`);
}

export async function registerCliTools(server: McpServer): Promise<void> {
  if (!optedIn()) return;
  const available = await cliToolsAvailability();
  logAvailability(available);
  if (!available.ok) return;

  registerCliTool<{ command?: string }>(server,
    "vault_cli_help",
    {
      annotations: { readOnlyHint: true, openWorldHint: false },
      title: "List Obsidian CLI commands",
      description:
        "Lists the Obsidian CLI commands vault_cli can run, with their parameters, or shows help for one command. Use before vault_cli to find a command for something the other vault tools don't cover (Bases queries, tasks, file history, sync, bookmarks, unresolved links, word counts).",
      inputSchema: z.object({
        command: z.string().optional().describe("Show help for this command only"),
      }),
    },
    args => ({ command: args.command ?? null }),
    async ({ command }) => toResult(await cliHelp(command)),
  );

  registerCliTool<CliRequest>(server,
    "vault_cli",
    {
      annotations: { readOnlyHint: vault.isReadOnly(), destructiveHint: !vault.isReadOnly(), openWorldHint: false },
      title: "Run an Obsidian CLI command",
      description:
        "Runs one Obsidian CLI command against this vault, answered by the Obsidian app with its own link resolution, search and plugins. Call vault_cli_help first for the commands and their parameters. Pass parameters as params (key → value) and bare flags as flags. Target notes with path= (vault-relative) or file= (a name, resolved by the server). The vault is fixed by the server.",
      inputSchema: z.object({
        command: z.string().describe("Command name, e.g. search, tasks, base:query"),
        params: z.record(z.string(), z.string()).optional().describe("Parameters as key → value, e.g. { \"query\": \"meeting\" }"),
        flags: z.array(z.string()).optional().describe("Bare flags, e.g. [\"counts\"]"),
      }),
    },
    args => ({ command: args.command, param_keys: Object.keys(args.params ?? {}), flags: args.flags ?? [] }),
    async request => toResult(await runCli(request)),
  );
}
