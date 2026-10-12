# Server and configuration

- The server is stateless — a fresh `McpServer` and transport are created per request. This is intentional and correct for this use case.
- If `VAULT_PATH` is unset, the server reads `.config/obsidian/obsidian.json` (walks up from cwd and from the package directory). With a single vault entry that has a `path`, that path is used; with several, set `OBSIDIAN_VAULT_ID` to the vault id. If neither config nor `VAULT_PATH` is available, startup fails.
- The OAuth approval page uses `VAULT_DISPLAY_NAME` when set, otherwise the resolved vault directory name.
- Allowed OAuth redirect targets come from `MCP_CLIENT_ALLOWED_REDIRECT_URIS`, defaulting to Claude's callback URI.
- The OAuth approval page must be guarded, and the server refuses to start otherwise: the kit's `createAuth` throws at construction (in `createApp`, so `server.ts` exits before listening) when the approval page is unguarded. Any one of three satisfies the check: `APPROVAL_PASSWORD` (a password on `/authorize`, compared constant-time, re-rendering the page with a 401 on a wrong guess), `MCP_CLIENT_SECRET` (which guards token exchange instead), or `APPROVAL_OPEN=true` (for deployments fronted by a reverse proxy / zero-trust gateway). There is no username — the password is the whole secret.
- MCP defaults to the exact configured site origin; `CORS_ALLOWED_ORIGINS` replaces all defaults with an explicit allowlist, or standalone `*` to accept any origin. No client-specific website origins are built in; OAuth callback permissions do not grant browser-origin access. When restricted, invalid/disallowed Origin headers are refused before MCP handling, including non-preflight requests. Server-to-server clients without Origin remain supported. Origin trust never derives from request Host/forwarded headers; OAuth/discovery retain the SDK behavior.
- Tokens persist to `TOKEN_STORE_PATH` (default `./tokens.json`) and expire after 30 days.

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MCP_CLIENT_ID` | yes | OAuth client ID |
| `MCP_CLIENT_SECRET` | no | Optional OAuth client secret. If set on the server, clients must send the same `client_secret` to `/token`. If unset, PKCE-only clients can sign in without one. |
| `APPROVAL_PASSWORD` | yes\* | Password for the OAuth approval page: `/authorize` requires it before issuing a code. \*The server refuses to start with the approval path unguarded; this, `MCP_CLIENT_SECRET`, or `APPROVAL_OPEN=true` satisfies that check. |
| `APPROVAL_OPEN` | no | Set `true` to allow the click-to-approve approval page when a reverse proxy / zero-trust gateway already guards `/authorize`. Satisfies the startup guard in place of an approval password. |
| `MCP_BASE_URL` | yes (prod) | Public **site** URL (scheme + host, no `/mcp`). Used in OAuth discovery as the protected `resource` |
| `MCP_CLIENT_ALLOWED_REDIRECT_URIS` | no | Comma-separated allowlist of OAuth redirect URIs for the configured client. Defaults to Claude's callback URI. |
| `MCP_DCR_ENABLED` | no | `true` opens `/register` so clients that can't be pre-configured (e.g. ChatGPT) register themselves. The approval password stays the gate, so requires `APPROVAL_PASSWORD`. Default off. |
| `MCP_DCR_ALLOWED_REDIRECT_URIS` | no | Optional hardening for DCR: allowlist of callbacks self-registering clients may use (exact or host-scoped `https://host/*`). Setting it also enables DCR. |
| `VAULT_PATH` | no | Absolute vault root; overrides Obsidian config when set |
| `OBSIDIAN_VAULT_ID` | when multiple vaults | Which `vaults` entry in `obsidian.json` to use (matches id case-insensitively) |
| `VAULT_DISPLAY_NAME` | no | Optional label shown on the OAuth approval page. Defaults to the resolved vault directory name. |
| `VAULT_CONTEXT_PATH` | no | Relative path for the note returned by `vault_context`. Defaults to `AGENTS.md`, then `CLAUDE.md`. |
| `DAILY_NOTE_PATH_TEMPLATE` | no | Daily-cadence path template for `vault_periodic_note`. Defaults to `Daily/{YYYY}-{MM}-{DD}.md`. |
| `WEEKLY_NOTE_PATH_TEMPLATE` | no | Weekly-cadence path template. Opt-in; `period: weekly` errors until set. |
| `MONTHLY_NOTE_PATH_TEMPLATE` | no | Monthly-cadence path template. Opt-in; `period: monthly` errors until set. |
| `QUARTERLY_NOTE_PATH_TEMPLATE` | no | Quarterly-cadence path template. Opt-in; `period: quarterly` errors until set. |
| `YEARLY_NOTE_PATH_TEMPLATE` | no | Yearly-cadence path template. Opt-in; `period: yearly` errors until set. |
| `VAULT_ATTACHMENT_MAX_BYTES` | no | Max bytes `vault_read_attachment` will read before rejecting. Defaults to `10485760` (10 MB). |
| `CORS_ALLOWED_ORIGINS` | no | Exact comma-separated HTTP(S) browser-origin allowlist for `/mcp`. Unset/empty allows only the MCP_BASE_URL origin (local fallback http://localhost:PORT). An explicit list replaces those defaults. A standalone `*` opts into any origin; partial/mixed wildcards, `null` entries, paths, and credentials are refused at startup. Requests without Origin remain authenticated normally. |
| `TOKEN_STORE_PATH` | no | Path to the persisted bearer token store. Defaults to `./tokens.json`. |
| `LOG_ENABLED` | no | Set to `false` to disable tool-call logging and skip registering `vault_feedback`. Defaults to `true`. |
| `LOG_DIR` | no | Directory for JSONL logs (`tool-calls.jsonl`, `feedback.jsonl`). Defaults to `./logs`. Created on first write. Skipped when `VAULT_MCP_TEST=1` or `LOG_ENABLED=false`. |
| `MCP_STATIC_BEARER_TOKEN` | no | Optional fixed secret: requests to `/mcp` with `Authorization: Bearer <same value>` are allowed (for clients that cannot use browser OAuth). Long random string; use HTTPS. Works alongside normal OAuth tokens. |
| `VAULT_READ_ONLY` | no | Set to `true` to block all write operations. Write-only tools (create, update, edit, edit section, set and batch frontmatter, trash) are not advertised at all; tools that read or write depending on their arguments (`vault_periodic_note`, `vault_clip_url`, and `vault_move`, whose default dry run only plans) stay listed and refuse the write. |
| `HEALTH_TOKEN` | no | Dedicated bearer for `GET /health`. Default-closed: unset → the route 404s. Sent as `Authorization: Bearer`; separate from the OAuth and static-bearer secrets. |
| `PORT` | no | HTTP port (default: `3456`) |
| `HOST` | no | Bind address (default: `0.0.0.0`). Use `127.0.0.1` for a process behind a proxy on the same host; in Docker, restrict the published port instead. |

## Claude.ai custom connector

1. **Public URL** — In Claude, set the connector to your MCP endpoint, e.g. `https://your-domain.com/mcp` (include `https://`).

2. **`MCP_BASE_URL`** — In your server env, set this to the **same host** as that URL, **without** the `/mcp` path — e.g. `https://your-domain.com`. Do **not** point it at a different subdomain or path than the site users use for the connector; OAuth clients compare this to the connector URL.

3. **Client ID / secret** — Set `MCP_CLIENT_ID` to the connector's client ID. `MCP_CLIENT_SECRET` is optional, but if you set it on the server, Claude must send the same value.

4. **After changing env** — Redeploy or restart the container so discovery (`/.well-known/...`) returns the new `resource` value.

`GET /mcp` returns **405** (not 404) so streamable-HTTP clients that probe for SSE know this server only answers MCP on **POST**.
