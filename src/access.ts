// ABOUTME: What each connection may do. Server settings set the limit for every connection; the
// choices made on the approval page when a connection was approved can only narrow it. Defines the
// two scopes the approval page offers and answers whether the current request's connection holds one.
import { currentCaller } from 'mcp-server-kit';
import type { ScopeDefinition } from 'mcp-server-kit';

// Creating, editing, moving and trashing notes, and Obsidian CLI commands that write.
export const WRITE_SCOPE = 'vault:write';
// The vault_cli and vault_cli_help tools.
export const CLI_SCOPE = 'vault:cli';

// The approval page's own wording, shared with the errors that point people back to it.
export const WRITE_LABEL = 'Edit notes';
export const CLI_LABEL = 'Control the Obsidian app';

export const SCOPES_PROMPT = 'Every connection can read your notes. Also allow this one to:';

// The approval page's checkboxes. Each is offered only while the server allows it, so nobody is asked
// about a capability that is switched off; `cliOffered` reports whether the CLI tools are on.
export function accessScopes(cliOffered: () => Promise<boolean>): ScopeDefinition[] {
  return [
    {
      id: WRITE_SCOPE,
      label: WRITE_LABEL,
      hint: 'Create, edit, move and trash notes.',
      offered: () => !serverReadOnly(),
    },
    {
      id: CLI_SCOPE,
      label: CLI_LABEL,
      hint: 'Run plugin and command-palette commands, and change Publish and Sync. If editing is off, it can only run commands that read.',
      offered: cliOffered,
    },
  ];
}

// VAULT_READ_ONLY=true: no connection may write.
export function serverReadOnly(): boolean {
  return process.env.VAULT_READ_ONLY === 'true';
}

// Whether the connection making the current request holds the scope. True outside a request, where
// only the server settings apply.
export function connectionGranted(scope: string): boolean {
  const caller = currentCaller();
  return caller === undefined || caller.scopes.includes(scope);
}

// Why writes are refused right now, or null when they are allowed.
export function readOnlyReason(): string | null {
  if (serverReadOnly()) return 'Vault is in read-only mode (VAULT_READ_ONLY=true)';
  if (!connectionGranted(WRITE_SCOPE)) {
    return `This connection is read-only: it was approved without "${WRITE_LABEL}". To allow edits, reconnect and tick "${WRITE_LABEL}".`;
  }
  return null;
}

// MCP_STATIC_BEARER_SCOPES: unset for every scope, "none" for none, or a comma-separated list.
export function staticBearerScopes(): string[] | undefined {
  const value = process.env.MCP_STATIC_BEARER_SCOPES?.trim();
  if (!value) return undefined;
  if (value.toLowerCase() === 'none') return [];
  return value.split(',').map(s => s.trim()).filter(Boolean);
}
