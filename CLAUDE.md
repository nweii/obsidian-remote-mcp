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
  tools.ts    — MCP tool definitions (context, read, batch read, outline, read section, read attachment, frontmatter, links, create/update/edit/edit section/trash, set frontmatter, batch set frontmatter, move/rename, search title, search content, search frontmatter, tags, periodic note, clip URL, feedback)
  lock.ts     — Per-path async mutex; serializes read-modify-write so concurrent edits to one note can't interleave
  log.ts      — Append-only JSONL logger for tool calls and agent feedback (LOG_DIR, default ./logs)
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
| `MCP_CLIENT_SECRET` | no | Optional OAuth client secret. If set on the server, clients must send the same `client_secret` to `/oauth/token`. If unset, PKCE-only clients can sign in without one. |
| `VAULT_OAUTH_PASSWORD` | no | Opt-in password gate for the OAuth approval page. When set, `/authorize` requires a username + password before issuing a code. Unset (default) keeps the click-to-approve page unchanged. A reverse proxy / zero-trust gateway in front of the endpoint is the stronger option; this is the low-config alternative. |
| `VAULT_OAUTH_USERNAME` | no | Username for the password gate. Defaults to `obsidian`. Only consulted when `VAULT_OAUTH_PASSWORD` is set. |
| `MCP_BASE_URL` | yes (prod) | Public **site** URL (scheme + host, no `/mcp`). Used in OAuth discovery as the protected `resource` |
| `MCP_ALLOWED_REDIRECT_URIS` | no | Comma-separated allowlist of OAuth redirect URIs. Defaults to Claude's callback URI. |
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
| `CORS_ALLOWED_ORIGINS` | no | Comma-separated browser origin allowlist. Defaults to `*`. |
| `TOKEN_STORE_PATH` | no | Path to the persisted bearer token store. Defaults to `./tokens.json`. |
| `LOG_ENABLED` | no | Set to `false` to disable tool-call logging and skip registering `vault_feedback`. Defaults to `true`. |
| `LOG_DIR` | no | Directory for JSONL logs (`tool-calls.jsonl`, `feedback.jsonl`). Defaults to `./logs`. Created on first write. Skipped when `VAULT_MCP_TEST=1` or `LOG_ENABLED=false`. |
| `MCP_STATIC_BEARER_TOKEN` | no | Optional fixed secret: requests to `/mcp` with `Authorization: Bearer <same value>` are allowed (for clients that cannot use browser OAuth). Long random string; use HTTPS. Works alongside normal OAuth tokens. |
| `VAULT_READ_ONLY` | no | Set to `true` to block all write operations (create, update, edit, move, trash) |
| `HEALTH_TOKEN` | no | Dedicated bearer for `GET /health`. Default-closed: unset → the route 404s. Sent as `Authorization: Bearer`; separate from the OAuth and static-bearer secrets. |
| `PORT` | no | HTTP port (default: `3456`) |

## Claude.ai custom connector (plain checklist)

1. **Public URL** — In Claude, set the connector to your MCP endpoint, e.g. `https://your-domain.com/mcp` (include `https://`).

2. **`MCP_BASE_URL`** — In your server env, set this to the **same host** as that URL, **without** the `/mcp` path — e.g. `https://your-domain.com`. Do **not** point it at a different subdomain or path than the site users use for the connector; OAuth clients compare this to the connector URL.

3. **Client ID / secret** — Set `MCP_CLIENT_ID` to the connector's client ID. `MCP_CLIENT_SECRET` is optional, but if you set it on the server, Claude must send the same value.

4. **After changing env** — Redeploy or restart the container so discovery (`/.well-known/...`) returns the new `resource` value.

`GET /mcp` returns **405** (not 404) so streamable-HTTP clients that probe for SSE know this server only answers MCP on **POST**.

## Notes

- The server is stateless — a fresh `McpServer` and transport are created per request. This is intentional and correct for this use case.
- **Concurrent edits to the same note** are handled in two layers. (1) A per-path async mutex (`lock.ts`, `withPathLock`) wraps every write that touches existing content (`appendNote`, `prependToNote`, `replaceInNote`, `editNoteSection`, `setFrontmatterProperty`, `updateNote`) so two tool calls on the same note can't interleave. Different notes never block each other. (`appendNote` takes the lock too — `O_APPEND` is atomic against other appends, but not against a read-modify-write writer that read the file before the append landed.) (2) Optimistic versioning: `vault_read` returns a content-addressed `version` (a hash of the note text, `versionOf`). `vault_update` accepts that version as `base_version`; if the note changed since the caller read it (or was deleted), the update is rejected with a `ConcurrentEditError` ("re-read and reapply") instead of silently overwriting the other session's edit. Omitting `base_version` keeps the old last-writer-wins overwrite. (A fuller version that auto-merges non-overlapping concurrent edits via line-based diff3 lives on the `archive/concurrent-edit-diff3-merge` branch.)
- **Note writes are atomic.** Every truncating write (`writeNote`, `updateNote`, `prependToNote`, `replaceInNote`, `editNoteSection`, and the move/rename link rewrite) goes through `atomicWriteFile`: content is written to a hidden temp file in the same directory, fsynced, then renamed over the target. A same-directory rename is atomic on POSIX, so a reader — Obsidian, Obsidian Sync, another tool call — never sees a half-written or zero-length file. The target's mode is preserved across the inode swap, and the temp file is removed on any failure. `appendNote` deliberately stays on `O_APPEND` — append never truncates, so it can't produce the partial-file corruption atomic-rename guards against.
- If `VAULT_PATH` is unset, the server reads `.config/obsidian/obsidian.json` (walks up from cwd and from the package directory). With a single vault entry that has a `path`, that path is used; with several, set `OBSIDIAN_VAULT_ID` to the vault id. If neither config nor `VAULT_PATH` is available, startup fails.
- The OAuth approval page uses `VAULT_DISPLAY_NAME` when set, otherwise the resolved vault directory name.
- Allowed OAuth redirect targets come from `MCP_ALLOWED_REDIRECT_URIS`, defaulting to Claude's callback URI.
- `vault_context` reads `VAULT_CONTEXT_PATH` when set, otherwise falls back to `AGENTS.md` and then `CLAUDE.md` if present. It also appends a folder-only tree of the vault (default depth 3, configurable per call via `max_depth`; pass 0 to skip). The tree honours `.mcpignore` and skips dotfiles. Subtrees at each level are walked in parallel, and the whole tree is bounded by a 1.5s timeout — if it can't finish in time the context note is returned without the tree.
- `vault_periodic_note` reads or creates a note for a `period` (`daily`, `weekly`, `monthly`, `quarterly`, `yearly`), each driven by its own path template env var (`DAILY_NOTE_PATH_TEMPLATE`, `WEEKLY_NOTE_PATH_TEMPLATE`, and so on). Supported tokens `{YYYY}`, `{YY}`, `{GGGG}`, `{GG}`, `{WW}`, `{Q}`, `{MM}`, `{M}`, `{DD}`, `{D}`, `{MMM}`, `{MMMM}`, `{dd}`, `{ddd}`, and `{dddd}`. Only `daily` has a built-in default; other cadences return an error naming their env var until it is set.
- CORS defaults to `*`, but `CORS_ALLOWED_ORIGINS` can restrict browser access to specific origins like `https://claude.ai`.
- All vault paths are validated against the resolved vault root to prevent directory traversal.
- Place a `.mcpignore` file in the vault root to block specific paths from MCP access. One relative path pattern per line; lines starting with `#` are comments. Trailing slashes are stripped — `03-Records/Journaling` blocks that folder and everything inside it.
- Tokens persist to `TOKEN_STORE_PATH` (default `./tokens.json`) and expire after 30 days.
- When logging is enabled (default), every tool call is recorded to `LOG_DIR/tool-calls.jsonl` with `{ ts, tool, args, ok, duration_ms, error? }`. The `error` field captures the suggestion text returned to the client on `isError` responses, so review can show both the failure and what the agent was told to try next.
- Args are summarized before logging: strings over 80 chars become `<str:Nchars>`, and the fields `content`, `value`, `template`, and `find` are always redacted to `<redacted:Nchars>` regardless of length so note bodies and frontmatter values never land on disk. Tool names, paths, and structural args remain visible.
- Agents can call `vault_feedback` to log a structured note when they get stuck or want a tool that doesn't exist; entries land in `LOG_DIR/feedback.jsonl`. The tool is only registered when logging is enabled. Feedback fields (`goal`, `attempted`, `stuck_on`, `suggested_tool`) are agent-authored and stored verbatim.
- No automatic rotation — log files grow forever. Mount `LOG_DIR` as a persistent volume in production and rotate or truncate manually if size becomes a concern.
- Set `LOG_ENABLED=false` to disable both — useful for forks that don't want disk writes recording agent activity, or for ephemeral deployments without a persistent volume.
- `setFrontmatterProperty` (and the `vault_set_frontmatter_property` tool) does a textual single-key splice on the frontmatter block instead of round-tripping the whole block through js-yaml. Untouched keys keep their on-disk byte form — including bare `YYYY-MM-DD` dates (which the YAML parser would otherwise normalize to full ISO datetimes), quoting style, key order, blank lines, and comments. JSON-shaped frontmatter (`---\n{ ... }\n---`) falls back to parse-and-reserialize, which converts to YAML — matching Obsidian's own behavior documented at `help.obsidian.md/properties#JSON+properties`. Values that arrive as JSON-stringified arrays or objects (e.g. from a client whose schema lost the array shape) are defensively parsed back; literal strings that happen to start with `[` or `{` but aren't valid JSON pass through unchanged.
- `vault_search_frontmatter` finds notes by a frontmatter property. `match_type` is `exact` (equals), `contains` (case-insensitive substring), or `exists` (property present, value ignored). For a list-valued property the predicate runs per element, so it is real membership — `exact: draft` matches `tags: [draft, idea]` — rather than a substring test against the stringified list. A property js-yaml parsed into a `Date` (an unquoted ISO-8601 scalar like `2026-01-15`) is matched by its `YYYY-MM-DD` UTC calendar date, not the timezone-shifted `String(Date)` form, so `exact: 2026-01-15` matches and the day never drifts; non-ISO date conventions stay plain strings and match verbatim. It is a single stateless walk that parses each note's frontmatter (skips dotfiles, honours `.mcpignore`, reads only `.md`), keeping the per-request, no-index design. (The older `searchContent` walk does not honour `.mcpignore`; noted for a separate change.)
- `vault_batch_read` reads several notes in one call (paths or bare titles, resolved like `vault_read`); entries that can't be resolved are reported under "missing" without failing the rest. `include_content: false` returns only each note's frontmatter, for cheap triage before opening bodies. `vault_batch_frontmatter_update` sets frontmatter on several notes; each note's fields are applied in one locked read-modify-write via `setFrontmatterProperties` — the multi-key generalization of `setFrontmatterProperty`, which now delegates to it so the splice + lock logic has one implementation. Both batch tools are per-item and non-transactional (one bad note is reported, the rest still run) and capped at 50 entries.
- The OAuth approval page has an opt-in password gate. With `VAULT_OAUTH_PASSWORD` set, `/authorize` requires a username (`VAULT_OAUTH_USERNAME`, default `obsidian`) and password — compared constant-time — before issuing a code; a wrong guess re-renders the page with a 401. Unset, the page is the unchanged click-to-approve. A reverse proxy / zero-trust gateway in front of `/authorize` remains the stronger control; the gate is the low-config alternative.
- `editNoteSection` and `readNoteSection` are asymmetric on duplicate headings, by design. **Writes refuse to guess**: `editNoteSection` throws an `AmbiguousHeadingError` (carrying every match's line number and a one-line preview) and points the caller at `vault_edit` with a find-anchored `replace` on text unique to the target section. **Reads return everything**: `readNoteSection` joins all matching sections with `<!-- match N of M (line X) -->` labels so the agent can tell candidates apart. The asymmetry tracks the difference in stakes — a write to the wrong section is data loss; a read of all candidates is a couple extra tokens.

## Tests

```bash
bun test
```

Uses a temporary `VAULT_PATH` and `VAULT_MCP_TEST=1` (see `package.json` `test` script). Covers discovery metadata, `GET /mcp` → 405 with a valid token, and a minimal `POST ... initialize` MCP round-trip.
