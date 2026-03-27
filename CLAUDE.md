# obsidian-remote-mcp

Remote MCP server exposing an Obsidian vault over HTTP with OAuth 2.1 (authorization code + PKCE).

References:
- MCP specification: [modelcontextprotocol.io/specification](https://modelcontextprotocol.io/specification)
- Claude Code MCP docs for server authors: [code.claude.com/docs/en/mcp#for-mcp-server-authors](https://code.claude.com/docs/en/mcp#for-mcp-server-authors)

## Stack

- **Runtime**: Bun (TypeScript, no build step)
- **Transport**: Streamable HTTP (MCP spec)
- **Auth**: OAuth 2.1 authorization code + PKCE (browser flow for Claude.ai)
- **Deployment**: Docker container on a server or NAS

## File structure

```
src/
  server.ts   — Listens on PORT; uses createApp()
  app.ts      — createApp() — Express routes (OAuth + MCP)
  auth.ts     — OAuth discovery, token issuance, optional client-secret validation, and Bearer validation middleware
  vault.ts    — Vault filesystem operations, frontmatter helpers, vault discovery, and config-derived defaults
  tools.ts    — MCP tool definitions (14 tools: context, read, outline, read section, frontmatter, links, create/update/edit/trash, set frontmatter, search title, search content, daily note)
test/
  server.test.ts — HTTP checks for discovery, GET /mcp, POST initialize
```

## Running locally

```bash
bun install
MCP_CLIENT_ID=dev bun run src/server.ts
```

OAuth discovery: `GET /.well-known/oauth-authorization-server`
Token endpoint: `POST /oauth/token`
MCP endpoint: `POST /mcp` (requires Bearer token)

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MCP_CLIENT_ID` | yes | OAuth client ID |
| `MCP_CLIENT_SECRET` | no | Optional OAuth client secret. If a client sends `client_secret` to `/oauth/token`, it must match this value. PKCE-only clients can omit it. |
| `MCP_BASE_URL` | yes (prod) | Public **site** URL (scheme + host, no `/mcp`). Used in OAuth discovery as the protected `resource` |
| `MCP_ALLOWED_REDIRECT_URIS` | no | Comma-separated allowlist of OAuth redirect URIs. Defaults to Claude's callback URI. |
| `VAULT_PATH` | no | Absolute vault root; overrides Obsidian config when set |
| `OBSIDIAN_VAULT_ID` | when multiple vaults | Which `vaults` entry in `obsidian.json` to use (matches id case-insensitively) |
| `VAULT_DISPLAY_NAME` | no | Optional label shown on the OAuth approval page. Defaults to the resolved vault directory name. |
| `VAULT_CONTEXT_PATH` | no | Relative path for the note returned by `vault_context`. Defaults to `AGENTS.md`, then `CLAUDE.md`. |
| `DAILY_NOTE_PATH_TEMPLATE` | no | Daily note path template. Defaults to `Daily/{YYYY}-{MM}-{DD}.md`. |
| `CORS_ALLOWED_ORIGINS` | no | Comma-separated browser origin allowlist. Defaults to `*`. |
| `TOKEN_STORE_PATH` | no | Path to the persisted bearer token store. Defaults to `./tokens.json`. |
| `VAULT_READ_ONLY` | no | Set to `true` to block all write operations (create, update, edit, trash) |
| `PORT` | no | HTTP port (default: `3456`) |

## Claude.ai custom connector (plain checklist)

1. **Public URL** — In Claude, set the connector to your MCP endpoint, e.g. `https://your-domain.com/mcp` (include `https://`).

2. **`MCP_BASE_URL`** — In your server env, set this to the **same host** as that URL, **without** the `/mcp` path — e.g. `https://your-domain.com`. Do **not** point it at a different subdomain or path than the site users use for the connector; OAuth clients compare this to the connector URL.

3. **Client ID / secret** — Set `MCP_CLIENT_ID` to the connector's client ID. `MCP_CLIENT_SECRET` is optional: set it if you want to support clients that send `client_secret`; PKCE-only clients can leave it unset.

4. **After changing env** — Redeploy or restart the container so discovery (`/.well-known/...`) returns the new `resource` value.

`GET /mcp` returns **405** (not 404) so streamable-HTTP clients that probe for SSE know this server only answers MCP on **POST**.

## Notes

- The server is stateless — a fresh `McpServer` and transport are created per request. This is intentional and correct for this use case.
- If `VAULT_PATH` is unset, the server reads `.config/obsidian/obsidian.json` (walks up from cwd and from the package directory). With a single vault entry that has a `path`, that path is used; with several, set `OBSIDIAN_VAULT_ID` to the vault id. If neither config nor `VAULT_PATH` is available, startup fails.
- The OAuth approval page uses `VAULT_DISPLAY_NAME` when set, otherwise the resolved vault directory name.
- Allowed OAuth redirect targets come from `MCP_ALLOWED_REDIRECT_URIS`, defaulting to Claude's callback URI.
- `vault_context` reads `VAULT_CONTEXT_PATH` when set, otherwise falls back to `AGENTS.md` and then `CLAUDE.md` if present.
- `vault_daily_note` uses `DAILY_NOTE_PATH_TEMPLATE`, with supported tokens `{YYYY}`, `{YY}`, `{MM}`, `{M}`, `{DD}`, `{D}`, `{MMM}`, `{MMMM}`, `{dd}`, `{ddd}`, and `{dddd}`.
- CORS defaults to `*`, but `CORS_ALLOWED_ORIGINS` can restrict browser access to specific origins like `https://claude.ai`.
- All vault paths are validated against the resolved vault root to prevent directory traversal.
- Place a `.mcpignore` file in the vault root to block specific paths from MCP access. One relative path pattern per line; lines starting with `#` are comments. Trailing slashes are stripped — `03-Records/Journaling` blocks that folder and everything inside it.
- Tokens persist to `TOKEN_STORE_PATH` (default `./tokens.json`) and expire after 30 days.

## Tests

```bash
bun test
```

Uses a temporary `VAULT_PATH` and `VAULT_MCP_TEST=1` (see `package.json` `test` script). Covers discovery metadata, `GET /mcp` → 405 with a valid token, and a minimal `POST ... initialize` MCP round-trip.
