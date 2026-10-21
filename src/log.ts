// ABOUTME: Configures the kit's audit logger for this vault — the log directory, the argument names
// that carry note content (always redacted), and the enable/test-suppression gates — and re-exports
// the wired helpers (registerLogged, logFeedback, isLoggingEnabled, …) the tool layer calls. Also writes
// decision-model usage (requests, tokens, cost, resolved models) under the same gates.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createAuditLog, currentCaller } from 'mcp-server-kit';

// Arg names whose values may contain note bodies, frontmatter values, or other personal text.
// Matched at any depth in the args tree. Always redacted regardless of length, so logs retain shape
// (which tool, what arg keys) without recording vault content. `fields` is
// vault_batch_frontmatter_update's per-note property map, whose values are frontmatter content;
// redacting the whole map keeps the sibling `path` visible while no value reaches disk.
const REDACTED_FIELDS = ['content', 'value', 'template', 'find', 'fields'];

function loggingEnabled(): boolean {
  const v = process.env.LOG_ENABLED?.trim().toLowerCase();
  if (v === 'false' || v === '0' || v === 'no') return false;
  return true;
}

const logDir = () => process.env.LOG_DIR ?? './logs';

export const { registerLogged, logToolCall, logFeedback, summarizeArgs, isLoggingEnabled } = createAuditLog({
  logDir: logDir(),
  redactedFields: REDACTED_FIELDS,
  enabled: loggingEnabled,
  suppressWrites: () => process.env.VAULT_MCP_TEST === '1',
});

export interface DecisionUsageLog {
  tool: string;
  provider: string;
  model: string;              // configured model or alias
  resolved_models: string[];  // versions the provider reported answering with
  requests: number;
  from_cache: number;         // judgments answered from the cache, with no request
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;    // only providers that report cost directly
}

// One line per call that used a decision model, in LOG_DIR/decision-usage.jsonl. Holds counts and model
// names, never note text or the goal.
export function logDecisionUsage(entry: DecisionUsageLog): void {
  if (process.env.VAULT_MCP_TEST === '1' || !loggingEnabled()) return;
  const caller = currentCaller();
  const record = {
    ts: new Date().toISOString(),
    ...(caller ? { client: caller.clientId, ...(caller.clientName ? { client_name: caller.clientName } : {}) } : {}),
    ...entry,
  };
  try {
    mkdirSync(logDir(), { recursive: true });
    appendFileSync(join(logDir(), 'decision-usage.jsonl'), JSON.stringify(record) + '\n');
  } catch (err) {
    console.error('[log] failed to write decision-usage.jsonl:', err);
  }
}

export type { ToolContent, ToolResult } from 'mcp-server-kit';
