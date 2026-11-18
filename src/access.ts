// ABOUTME: What each connection may do. Server settings set the limit for every connection; the
// choices made on the approval page when a connection was approved can only narrow it. Defines the
// two scopes the approval page offers and answers whether the current request's connection holds one.
// Behind Cloudflare Access there is no approval page, and ACCESS_SCOPES sets what every connection holds.
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

// The approval page's checkboxes. Each is offered only while the server settings allow it, so nobody
// is asked about a capability that is switched off. A connection holds only the boxes ticked when it
// was approved, so a box that wasn't shown stays withheld until the connection is approved again.
// `cliEnabled` reports whether the CLI tools are turned on.
export function accessScopes(cliEnabled: () => boolean): ScopeDefinition[] {
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
      hint: 'Run plugin and command-palette commands, and change Publish and Sync.',
      offered: cliEnabled,
    },
  ];
}

// MCP_AUTH=access: Cloudflare Access signs connections in instead of the server's own OAuth.
export function accessModeEnabled(): boolean {
  return process.env.MCP_AUTH?.trim().toLowerCase() === 'access';
}

// ACCESS_SCOPES: unset for every scope, "none" for none, or a comma-separated list. Read once at
// startup; an unknown scope stops the server, as one in MCP_STATIC_BEARER_SCOPES does.
export function accessModeScopes(): string[] {
  const value = process.env.ACCESS_SCOPES?.trim();
  if (!value) return [WRITE_SCOPE, CLI_SCOPE];
  if (value.toLowerCase() === 'none') return [];
  const scopes = value.split(',').map(s => s.trim()).filter(Boolean);
  const unknown = scopes.filter(s => s !== WRITE_SCOPE && s !== CLI_SCOPE);
  if (unknown.length) {
    throw new Error(`ACCESS_SCOPES has unknown scope ${unknown.join(', ')}; use ${WRITE_SCOPE}, ${CLI_SCOPE} or none`);
  }
  return scopes;
}

// How a connection without `scope` gets it: reapproval under the server's own OAuth, a setting
// behind Access.
export function grantAdvice(scope: string, label: string, purpose: string): string {
  if (accessModeEnabled()) return `To ${purpose}, the server owner adds ${scope} to ACCESS_SCOPES.`;
  return `To ${purpose}, reconnect and tick "${label}".`;
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
    const cause = accessModeEnabled() ? 'ACCESS_SCOPES leaves out vault:write' : `it was approved without "${WRITE_LABEL}"`;
    return `This connection is read-only: ${cause}. ${grantAdvice(WRITE_SCOPE, WRITE_LABEL, 'allow edits')}`;
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
