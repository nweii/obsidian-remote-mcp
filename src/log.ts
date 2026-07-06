// ABOUTME: Configures the kit's audit logger for this vault — the log directory, the argument names
// that carry note content (always redacted), and the enable/test-suppression gates — and re-exports
// the wired helpers (registerLogged, logFeedback, isLoggingEnabled, …) the tool layer calls.
import { createAuditLog } from 'mcp-server-kit';

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

export const { registerLogged, logToolCall, logFeedback, summarizeArgs, isLoggingEnabled } = createAuditLog({
  logDir: process.env.LOG_DIR ?? './logs',
  redactedFields: REDACTED_FIELDS,
  enabled: loggingEnabled,
  suppressWrites: () => process.env.VAULT_MCP_TEST === '1',
});

export type { ToolContent, ToolResult } from 'mcp-server-kit';
