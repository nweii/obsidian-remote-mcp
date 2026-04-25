// ABOUTME: Append-only JSONL logger for tool calls and agent feedback. Writes to LOG_DIR (default ./logs).
import { mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';

const LOG_DIR = process.env.LOG_DIR ?? './logs';
const TOOL_CALLS_FILE = 'tool-calls.jsonl';
const FEEDBACK_FILE = 'feedback.jsonl';

export function isLoggingEnabled(): boolean {
  const v = process.env.LOG_ENABLED?.trim().toLowerCase();
  if (v === 'false' || v === '0' || v === 'no') return false;
  return true;
}

let dirEnsured = false;

function ensureDir() {
  if (dirEnsured) return;
  try {
    mkdirSync(LOG_DIR, { recursive: true });
  } catch (err) {
    console.error('[log] failed to create log dir:', err);
  }
  dirEnsured = true; // even on failure: avoid retrying mkdir on every call
}

function appendJsonl(filename: string, record: Record<string, unknown>) {
  if (process.env.VAULT_MCP_TEST === '1') return;
  if (!isLoggingEnabled()) return;
  ensureDir();
  try {
    appendFileSync(join(LOG_DIR, filename), JSON.stringify(record) + '\n');
  } catch (err) {
    console.error(`[log] failed to write ${filename}:`, err);
  }
}

// Arg names whose values may contain note bodies, frontmatter values, or other
// personal text. Matched at any depth in the args tree. Always redacted
// regardless of length, so logs retain shape (which tool, what arg keys)
// without recording vault content.
const REDACTED_FIELDS = new Set(['content', 'value', 'template', 'find']);

function redactValue(v: unknown): string {
  if (typeof v === 'string') return `<redacted:${v.length}chars>`;
  if (v === null || v === undefined) return '<redacted>';
  return `<redacted:${typeof v}>`;
}

// Truncate string fields over 80 chars so logs stay readable and small.
// Numbers, booleans, and short strings pass through unchanged.
// Fields named in REDACTED_FIELDS at the top level of args are always redacted.
export function summarizeArgs(args: unknown): unknown {
  if (args === null || args === undefined) return args;
  if (typeof args === 'string') return args.length > 80 ? `<str:${args.length}chars>` : args;
  if (Array.isArray(args)) return args.map((v) => summarizeArgs(v));
  if (typeof args === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) {
      out[k] = REDACTED_FIELDS.has(k) ? redactValue(v) : summarizeArgs(v);
    }
    return out;
  }
  return args;
}

export interface ToolCallLog {
  tool: string;
  args: unknown;
  ok: boolean;
  duration_ms: number;
  error?: string; // suggestion text returned to the client, or thrown error message
}

export function logToolCall(entry: ToolCallLog) {
  appendJsonl(TOOL_CALLS_FILE, {
    ts: new Date().toISOString(),
    tool: entry.tool,
    args: summarizeArgs(entry.args),
    ok: entry.ok,
    duration_ms: entry.duration_ms,
    ...(entry.error ? { error: entry.error } : {}),
  });
}

export interface FeedbackLog {
  goal: string;
  attempted: string;
  stuck_on: string;
  suggested_tool?: string;
}

export function logFeedback(entry: FeedbackLog) {
  appendJsonl(FEEDBACK_FILE, {
    ts: new Date().toISOString(),
    ...entry,
  });
}
