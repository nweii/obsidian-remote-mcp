# Server reference

[README](../README.md) · [Setup](setup.md) · [Authentication and vault settings](configuration.md) · [Client setup](../clients.md)

## Health endpoint

`GET /health` lets an uptime monitor check whether the server is running and can reach the vault folder. It returns `404` until you set `HEALTH_TOKEN` to a long random string. Configure the monitor to send that value as `Authorization: Bearer …`. A wrong or missing token returns `401`.

<details>
<summary>Response details and uptime-monitor setup</summary>

`HEALTH_TOKEN` grants access only to the health response below. You can replace it without changing `MCP_CLIENT_SECRET`, `MCP_STATIC_BEARER_TOKEN`, or any OAuth client configuration.

```json
{ "ok": true, "version": "1.0.0", "uptime_seconds": 1234.5 }
```

- `ok` is `true` when the vault is accessible, or `false` with HTTP `503` when it is not. Monitors can alert on the status code.
- `version` comes from `package.json`, so you can check which version is running.
- `uptime_seconds` reports process uptime. Repeated resets indicate the server is restarting.

The response contains no vault name, paths, or counts.

```bash
# generate a token
openssl rand -base64 48
```

In Uptime Kuma, choose **HTTP(s)**, enter `https://mcp.example.com/health`, and accept status code `200`. Under **HTTP Options**, add the header `Authorization: Bearer YOUR_HEALTH_TOKEN`.

</details>

## Environment variables

The [quick start](../README.md#1-run-the-server) shows the startup settings. Settings are grouped by feature.

### Server and vault

| Variable | Required | Description |
|----------|----------|-------------|
| `MCP_CLIENT_ID` | yes | OAuth client ID |
| `MCP_BASE_URL` | yes (prod) | Public **site** URL (scheme + host, no `/mcp`). Used in OAuth discovery as the protected `resource` |
| `VAULT_PATH` | no | Absolute vault root; overrides Obsidian config when set |
| `OBSIDIAN_VAULT_ID` | when multiple vaults | Which `vaults` entry in `obsidian.json` to use (matches id case-insensitively) |
| `VAULT_DISPLAY_NAME` | no | Optional label shown on the OAuth approval page. Defaults to the resolved vault directory name. |
| `HOST` | no | Bind address, default `0.0.0.0`. Use `127.0.0.1` behind a proxy on the same host. In Docker, restrict the published port instead. |
| `PORT` | no | HTTP port, default `3456` |

### Sign-in and client credentials

| Variable | Required | Description |
|----------|----------|-------------|
| `APPROVAL_PASSWORD` | yes* | Password required before the approval page issues a code. The server requires this, `MCP_CLIENT_SECRET`, or `APPROVAL_OPEN=true` before it starts. |
| `APPROVAL_OPEN` | no | Set `true` to allow the click-to-approve approval page when a reverse proxy / zero-trust gateway already guards `/authorize`. Satisfies the startup guard in place of an approval password. |
| `MCP_CLIENT_SECRET` | no | OAuth secret for clients using the configured `MCP_CLIENT_ID`. Set the same value in those clients. If unset, token exchange relies on PKCE. |
| `MCP_CLIENT_ALLOWED_REDIRECT_URIS` | no | Comma-separated OAuth callback URLs for the configured client. Replaces the built-in callbacks listed in [OAuth setup](configuration.md#oauth-browser-sign-in). |
| `MCP_DCR_ENABLED` | no | `true` opens `/register` so clients that can't be pre-configured (e.g. ChatGPT) register themselves. The approval password stays the gate, so requires `APPROVAL_PASSWORD`. Default off. |
| `MCP_DCR_ALLOWED_REDIRECT_URIS` | no | Allowed callbacks for self-registering clients. Accepts exact URLs or host-scoped patterns such as `https://host/*`. Setting it also enables DCR. |
| `TOKEN_STORE_PATH` | no | Path to the persisted bearer token store. Defaults to `./tokens.json`. |
| `MCP_STATIC_BEARER_TOKEN` | no | API key sent as `Authorization: Bearer <value>`. Use a long random string over HTTPS. Works alongside OAuth. Calls are logged as `static-bearer`. |
| `MCP_STATIC_BEARER_SCOPES` | no | Narrows `MCP_STATIC_BEARER_TOKEN`: a comma-separated list of the scopes it keeps (`vault:write`, `vault:cli`), or `none` for reading only. Unset gives full access. An unknown scope stops the server at startup. |

### Access restrictions

| Variable | Required | Description |
|----------|----------|-------------|
| `VAULT_READ_ONLY` | no | Set `true` to block edits for every connection. Write-only tools are omitted. Tools that can read or write remain listed but refuse writes. See [read-only behavior](tools.md#read-only-connections). |
| `CORS_ALLOWED_ORIGINS` | no | Exact comma-separated HTTP(S) browser-origin allowlist for `/mcp`. Unset/empty allows only the MCP_BASE_URL origin (local fallback http://localhost:PORT). An explicit list replaces those defaults. A standalone `*` opts into any origin; partial/mixed wildcards, `null` entries, paths, and credentials are refused at startup. Requests without Origin remain authenticated normally. |

### Note conventions

| Variable | Required | Description |
|----------|----------|-------------|
| `VAULT_CONTEXT_PATH` | no | Relative path for the note returned by `vault_context`. Defaults to `AGENTS.md`, then `CLAUDE.md`. |
| `DAILY_NOTE_PATH_TEMPLATE` | no | Daily-cadence path template for `vault_periodic_note`. Overrides the Periodic Notes and core Daily notes config; without either, defaults to `Daily/{YYYY}-{MM}-{DD}.md`. |
| `WEEKLY_NOTE_PATH_TEMPLATE` | no | Weekly-cadence path template. Overrides the Periodic Notes config; `period: weekly` errors when neither sets it. |
| `MONTHLY_NOTE_PATH_TEMPLATE` | no | Monthly-cadence path template, with the same precedence as weekly. |
| `QUARTERLY_NOTE_PATH_TEMPLATE` | no | Quarterly-cadence path template, with the same precedence as weekly. |
| `YEARLY_NOTE_PATH_TEMPLATE` | no | Yearly-cadence path template, with the same precedence as weekly. |
| `OBSIDIAN_CONFIG_DIR` | no | The vault's Obsidian config folder, relative to the vault root, read for periodic-note settings. Defaults to `.obsidian`. |
| `PERIODIC_WEEK_START` | no | First day of locale weeks (`gggg`, `ww` tokens) as a day name, such as `monday`. Overrides a week start set in the Calendar or Periodic Notes plugin; defaults to Sunday. |

### Attachments and clipping

| Variable | Required | Description |
|----------|----------|-------------|
| `VAULT_ATTACHMENT_MAX_BYTES` | no | Max bytes `vault_read_attachment` will read before rejecting. Defaults to `10485760` (10 MB). |
| `WEB_CLIPPER_SETTINGS_PATH` | no | Web Clipper settings export used by `vault_clip_url`, absolute or vault-relative. Unset, the newest `obsidian-web-clipper-settings*.json` within four folder levels of the vault root is used, whether or not `.mcpignore` hides it. |

### Decision models

| Variable | Required | Description |
|----------|----------|-------------|
| `DECISION_PROVIDER` | no | Decision-model provider: `typesafe` (default), `openrouter`, or `openai`. Used by `vault_search_semantic`, which is registered only when that provider's key is set. An unknown value disables the tool and logs why. |
| `TYPESAFE_API_KEY` / `OPENROUTER_API_KEY` / `OPENAI_API_KEY` | no | Credential for the chosen provider. |
| `DECISION_MODEL` | no | Overrides the provider's default decision model (`jev-latest`, `typesafe/jev-1.13`, `gpt-6-luna`). |
| `SKIM_PROVIDER` / `SKIM_MODEL` | no | Supported aliases. Each is used when the corresponding `DECISION_*` setting is unset or blank. If both specify different values, the `DECISION_*` value wins and the server warns once per setting per process. |

Provider names ignore case and surrounding whitespace. Model names ignore surrounding whitespace. When migrating an existing provider and model override, rename both settings together so an old model override does not accompany a different provider. The API key names stay the same.

The Web Clipper interpreter uses its own settings export. Decision-model settings do not configure that interpreter.

### Semantic search

| Variable | Required | Description |
|----------|----------|-------------|
| `EXTERNAL_API_EXCLUDE_PATHS` | no | Comma-separated vault-relative path rules whose notes (and everything under them) are never sent to an external model API (by any feature that sends note text, such as `vault_search_semantic`). Connected clients can still read them; use `.mcpignore` to hide notes from clients too. Rules use `.mcpignore` syntax, so `*`, `?` and `**` wildcards work. |
| `SEMANTIC_CACHE_PATH` | no | File for cached decision-model judgments (default `./semantic-cache.json`). Stores hashes and probabilities only. `off` keeps the cache in memory. |
| `SKIM_EXCLUDE_PATHS` / `SKIM_CACHE_PATH` | no | Supported aliases. Path rules from both forms combine; for the cache path, `SEMANTIC_CACHE_PATH` wins. |
| `SKIM_EXCLUDE_TAGS` | no | Retired; tag exclusions are not supported. While it is set, `vault_search_semantic` stays unregistered and the server logs why. |

### Obsidian CLI

| Variable | Required | Description |
|----------|----------|-------------|
| `OBSIDIAN_CLI_ENABLED` | no | `true` offers `vault_cli` and `vault_cli_help` when the `obsidian` CLI reaches this vault, and routes `vault_links` backlinks through Obsidian. Default off. |
| `OBSIDIAN_CLI_PATH` | no | Path to the `obsidian` binary. Defaults to a lookup on `PATH`. |
| `OBSIDIAN_CLI_VAULT` | no | The vault name passed to the CLI as `vault=`. Defaults to the vault folder's name. |
| `OBSIDIAN_CLI_COMMANDS` | no | Comma-separated command-palette IDs `vault_cli` may run through `command`. `*` allows all except destructive-looking IDs, which must be listed by name. Unset, palette execution is off. |
| `OBSIDIAN_CLI_MCPIGNORE_ACK` | no | `true` keeps the CLI tools on while `.mcpignore` has rules, accepting that CLI output can't be filtered by them. |

### Logging and monitoring

| Variable | Required | Description |
|----------|----------|-------------|
| `LOG_ENABLED` | no | Set to `false` to disable tool-call logging and skip registering `vault_feedback`. Defaults to `true`. |
| `LOG_DIR` | no | Directory for JSONL logs (`tool-calls.jsonl`, `feedback.jsonl`). Defaults to `./logs`. Created on first write. Skipped when `VAULT_MCP_TEST=1` or `LOG_ENABLED=false`. |
| `HEALTH_TOKEN` | no | Token for `GET /health`, sent as `Authorization: Bearer YOUR_HEALTH_TOKEN`. Unset returns `404`. Separate from client credentials. See [health monitoring](#health-endpoint). |

## Request handling

The MCP transport is stateless. Each request creates a fresh `McpServer` and transport. `GET /mcp` and `DELETE /mcp` return `405`; tool requests use `POST`.

### Approval and permissions

`createAuth` rejects an unguarded approval page during `createApp`, before the server starts listening. Set one of the [approval protections](configuration.md#password-gate). An incorrect approval password returns `401`. There is no username.

`src/access.ts` defines `vault:write` for **Edit notes** and `vault:cli` for **Control the Obsidian app**. The CLI permission is offered when `OBSIDIAN_CLI_ENABLED=true`, even if Obsidian is temporarily unreachable. Each request uses the caller recorded by the kit's `currentCaller()`.

Server settings limit the permissions a connection can receive. The approval choices can only narrow those permissions. See [connection permissions](configuration.md#choosing-what-each-connection-can-do) for reapproval and older-token behavior.

Tokens persist in `TOKEN_STORE_PATH` and expire after 30 days. Browser-origin checks apply before MCP requests are handled. OAuth and discovery endpoints retain the SDK's CORS behavior. See [browser origins](configuration.md#browser-origins-cors).

## Dependency updates

`bunfig.toml` enforces a three-day minimum release age for registry packages and frozen-lockfile installations. Git dependencies are exempt from the release-age check.

Review source changes when updating the locked `mcp-server-kit`, `web-clipper-headless`, or transitive `obsidian-clipper` commits. Run `bun audit` after dependency changes. The root overrides pin patched versions where upstream dependencies still request vulnerable releases.
