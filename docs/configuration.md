# Authentication and vault settings

[README](../README.md) · [Setup](setup.md) · [Environment variables](server.md#environment-variables)

## Authentication

Clients authenticate with browser OAuth or an API key. Every `POST /mcp` request must include `Authorization: Bearer …`.

### OAuth (browser sign-in)

Use OAuth 2.1 for clients that support browser sign-in. The user approves access on `/authorize`. The client exchanges the short-lived code at `POST /token`, then sends the issued access token in `Authorization` on `/mcp`.

By default, clients use the fixed client ID you configure. To let clients register themselves, enable dynamic client registration (DCR) with `MCP_DCR_ENABLED=true`. Enabling DCR opens `/register` and requires `APPROVAL_PASSWORD`.

Clients that cannot accept a fixed client ID need DCR. See [client setup](../clients.md) for each app's authentication options.

- **`MCP_CLIENT_ID`** (required). The configured OAuth client ID.
- **`MCP_CLIENT_SECRET`** (optional). Set the same secret in clients using the configured `MCP_CLIENT_ID`. Without a secret, token exchange relies on PKCE. Use HTTPS and restrict access to `/authorize`.
- **`MCP_BASE_URL`** must match the public site origin (no `/mcp`).
- **`MCP_CLIENT_ALLOWED_REDIRECT_URIS`** (optional). A comma-separated list of allowed OAuth callback URLs. Setting it replaces the defaults, so retain every callback your clients need.
- **`MCP_DCR_ALLOWED_REDIRECT_URIS`** (optional). A comma-separated allowlist of callbacks self-registering clients may use. Entries can be exact URLs or host-scoped patterns such as `https://host/*`. Setting it also enables DCR. Unset accepts each client's own declared redirect.
- **`TOKEN_STORE_PATH`** (default `./tokens.json`) stores OAuth tokens on disk so sign-ins persist across server restarts.

<details>
<summary>Built-in OAuth callbacks</summary>

The default list includes these callbacks.

| Client | Callback |
|--------|----------|
| Claude.ai | `https://claude.ai/api/mcp/auth_callback` |
| ChatGPT | `https://chatgpt.com/connector_platform_oauth_redirect` |
| Cursor | `cursor://anysphere.cursor-mcp/oauth/callback` |

See [client setup](../clients.md) for callbacks and authentication options specific to each app.

</details>

### API key (static bearer token)

For scripts and clients that cannot open a browser, set `MCP_STATIC_BEARER_TOKEN` to a long random string on the server. Configure the client to send the same value as `Authorization: Bearer [your key]`.

The server checks the key on each `/mcp` request. API-key clients skip the browser flow and do not use `TOKEN_STORE_PATH`. Other clients can still use OAuth.

The client service stores this long-lived token. Replace it if you suspect exposure.

Every client using the same API key shares its permissions. The API key has full access by default. Set `MCP_STATIC_BEARER_SCOPES` to `vault:write` for note editing, `vault:cli` for Obsidian app control, or both separated by a comma. Set it to `none` for reading only.

Generate a random API key in your terminal.

```bash
# generate one
openssl rand -base64 48
```

### Browser origins (CORS)

A browser origin identifies the page making a request by its scheme, hostname, and port, such as `https://my-vault-chat.example`. `CORS_ALLOWED_ORIGINS` controls which of these pages may call `/mcp`.

With `CORS_ALLOWED_ORIGINS` unset or empty, `/mcp` accepts the following requests.

- Requests without an `Origin` header (cloud, CLI, and native clients still need a valid token).
- Your configured `MCP_BASE_URL` origin, or `http://localhost:PORT` when it is unset.

Other supplied origins receive `403` before MCP tools run, even with a valid token. The [MCP origin check](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#security-warning) applies to every MCP request. Allowing an origin does not remove authentication.

An OAuth callback URL does not authorize requests from that client's website. No client-specific browser origins are allowed by default.

For a client that calls directly from a browser page, add its exact origin. An explicit list **replaces all defaults**, so include each origin you want to retain.

```env
CORS_ALLOWED_ORIGINS=https://vault.example,https://my-vault-chat.example,http://localhost:3000
```

Use HTTP(S) origins without paths, trailing slashes, or credentials. Subdomains and ports must match exactly.

<details>
<summary>Origin validation and OAuth endpoints</summary>

Partial wildcards and `null` entries are rejected at startup. The server does not infer trust from Host or forwarded headers.

OAuth discovery, registration, and token exchange retain the SDK's CORS behavior so clients can complete sign-in. This does not add their websites to the MCP origin allowlist. Client versions may send different Origin headers; check the rejected origin before adding an entry.

The origin allowlist does not protect a directly exposed backend port. Follow the [HTTPS setup](setup.md#expose-it-over-https) to keep port `3456` private.

</details>

`CORS_ALLOWED_ORIGINS=*` remains an explicit compatibility override accepting every origin, including opaque origins (`Origin: null`). It disables this Origin restriction; authentication remains required. Use `*` alone.

### Password gate

The OAuth approval page must be guarded, and the server refuses to start otherwise. Set `APPROVAL_PASSWORD` to require a password on that page before a code is issued; it's checked on every authorization. A client secret (`MCP_CLIENT_SECRET`) satisfies the guard instead, by blocking token exchange.

If a reverse proxy or zero-trust gateway already guards `/authorize` (the stronger control), set `APPROVAL_OPEN=true` for the click-to-approve page instead.

### Choosing what each connection can do

Every connection can read your notes. The approval page offers two additional permissions.

- **Edit notes.** Create, edit, move and trash notes. Leave it unticked for a connection that should only read.
- **Control the Obsidian app.** Use `vault_cli` to run plugin and command-palette commands and change Publish and Sync. This box appears when `OBSIDIAN_CLI_ENABLED=true`. Without **Edit notes**, the connection can run only commands that read. See [Obsidian CLI tools](tools.md#obsidian-cli-tools).

Both permissions are selected by default. With `VAULT_READ_ONLY=true`, no connection can edit.

A connection keeps the permissions you approved. To change them, including after enabling editing or CLI tools on the server, approve the connection again. Connections approved before these permission choices existed keep full access.

A connection approved without **Edit notes** does not see write-only tools. Tools that can both read and write remain listed but refuse writes.

## Environment variables

Use the [environment-variable reference](server.md#environment-variables) for defaults and constraints, grouped by feature.

## Audit-log privacy

Audit logs can contain paths, titles, search queries, tags, and frontmatter field names. Note-body arguments and frontmatter values are redacted. Feedback is stored as written.

Set `LOG_ENABLED=false` to disable tool-call and feedback logging. See [audit logging](audit-logging.md) for recorded fields, error handling, and log rotation.

## Vault path

The server resolves the vault root in this order.

1. `VAULT_PATH`, if set
2. `.config/obsidian/obsidian.json`, found by walking up from the current working directory or from the package directory

If `obsidian.json` contains multiple vaults, set `OBSIDIAN_VAULT_ID` to the vault entry you want to use.

The display name used in the OAuth approval page defaults to the resolved vault directory name. You can override that with `VAULT_DISPLAY_NAME`.

### Discover a vault without Obsidian installed

Set `VAULT_PATH` to choose the vault folder directly. To use automatic discovery on a machine without Obsidian, create the config file yourself.

```bash
mkdir -p ~/.config/obsidian
```

Save the following as `~/.config/obsidian/obsidian.json`.

```json
{
  "vaults": {
    "personal": {
      "path": "/home/user/vaults/personal"
    }
  }
}
```

With multiple vaults, add more entries and set `OBSIDIAN_VAULT_ID` to the one you want. Use absolute paths. `~` is not expanded inside `obsidian.json`.

## Vault context note

`vault_context` reads `AGENTS.md`, falling back to `CLAUDE.md`, and returns a folder map to help agents follow your vault's conventions. To use another guidance file, set `VAULT_CONTEXT_PATH` to its vault-relative path. The guidance file is optional.

## Periodic note paths

`vault_periodic_note` reads or creates notes for the `period` you choose, either `daily`, `weekly`, `monthly`, `quarterly`, or `yearly`. Pass a `date` as `YYYY-MM-DD` to select a period. Any day within the same week, month, quarter, or year selects the same note.

Each cadence uses the first configured path in this order.

1. Its env var (table below).
2. The [Periodic Notes](https://github.com/liamcain/obsidian-periodic-notes) community plugin, when it is enabled and that cadence is turned on in it.
3. For `daily` only, the core Daily notes plugin's folder and date format.
4. For `daily` only, the built-in default `Daily/{YYYY}-{MM}-{DD}.md`.

| Cadence | Env var |
|---------|---------|
| `daily` | `DAILY_NOTE_PATH_TEMPLATE` |
| `weekly` | `WEEKLY_NOTE_PATH_TEMPLATE` |
| `monthly` | `MONTHLY_NOTE_PATH_TEMPLATE` |
| `quarterly` | `QUARTERLY_NOTE_PATH_TEMPLATE` |
| `yearly` | `YEARLY_NOTE_PATH_TEMPLATE` |

If your vault already configures these paths in Obsidian, you do not need environment variables. For example, with the Daily notes folder `01-Days` and format `YYYY-MM-DD-ddd`, the note for October 12, 2026 is `01-Days/2026-10-12-Mon.md`.

The server reads plugin settings on each call from `.obsidian`, or the folder set by `OBSIDIAN_CONFIG_DIR`. The `.obsidian` folder stays blocked from MCP tools. If you use a custom config folder, add it to `.mcpignore` to exclude it from file tools. If only notes are mounted into the server, configure paths with environment variables.

Obsidian date formats are translated into the tokens below, with `[bracketed]` text kept literal. Month, weekday and ordinal names are English; if Obsidian runs in another language, set the env templates instead. A format using any other token returns an error naming the token rather than a guessed path. If no source defines a path for that period, the error names the environment variable and config files checked.

<details>
<summary>Path tokens, week numbering, and examples</summary>

| Token | Meaning |
|-------|---------|
| `{YYYY}` | 4-digit calendar year |
| `{YY}` | 2-digit calendar year |
| `{GGGG}` | 4-digit ISO week-year (use with `{WW}`, not `{YYYY}`) |
| `{GG}` | 2-digit ISO week-year |
| `{WW}` | 2-digit ISO week number (weeks start Monday; week 1 contains the first Thursday) |
| `{W}` | ISO week number without zero padding |
| `{gggg}` | 4-digit locale week-year (use with `{ww}`) |
| `{gg}` | 2-digit locale week-year |
| `{ww}` | 2-digit locale week number (weeks start Sunday unless set otherwise; week 1 contains January 1) |
| `{w}` | locale week number without zero padding |
| `{Q}` | quarter number (`1`–`4`) |
| `{MM}` | 2-digit month |
| `{M}` | month without zero padding |
| `{DD}` | 2-digit day |
| `{D}` | day without zero padding |
| `{Do}` | day as an ordinal like `12th` |
| `{MMM}` | short month name like `Mar` |
| `{MMMM}` | full month name like `March` |
| `{dd}` | short weekday name like `Th` |
| `{ddd}` | short weekday name like `Mon` |
| `{dddd}` | full weekday name like `Monday` |

Match the week system your existing notes use. ISO weeks use `{GGGG}` and `{WW}` and start on Monday.

Obsidian in English and Periodic Notes' default format, `gggg-[W]ww`, use locale weeks. These use `{gggg}` and `{ww}` and start on Sunday by default, so a Sunday note has a different week number from its ISO equivalent.

For locale weeks, the server uses `PERIODIC_WEEK_START` first, then the Calendar or Periodic Notes plugin's week-start setting, then Sunday. If Obsidian relies on a Monday-start language default, set `PERIODIC_WEEK_START=monday` explicitly.

Each week-year can differ from the calendar year (`{YYYY}`) around New Year. For example `2025-12-29` falls in week 1 of 2026 in both systems. Pair each week number with its own week-year (`{WW}` with `{GGGG}`, `{ww}` with `{gggg}`); pairing it with `{YYYY}` produces wrong paths at that boundary.

```env
DAILY_NOTE_PATH_TEMPLATE=Daily/{YYYY}/{YYYY}-{MM}-{DD}.md
DAILY_NOTE_PATH_TEMPLATE=Journal/{YYYY}/{MMM}/{D}-{ddd}.md
WEEKLY_NOTE_PATH_TEMPLATE=Weekly/{GGGG}-W{WW}.md
MONTHLY_NOTE_PATH_TEMPLATE=Monthly/{YYYY}-{MM}.md
QUARTERLY_NOTE_PATH_TEMPLATE=Quarterly/{YYYY}-Q{Q}.md
YEARLY_NOTE_PATH_TEMPLATE=Yearly/{YYYY}.md
```

</details>

<details>
<summary>Plugin formats and path resolution</summary>

`src/periodic.ts` reads configuration on each call. A missing or unparseable config file falls through to the next source. The server reads these settings internally. The `.obsidian` folder stays blocked from MCP tools.

Periodic Notes must be listed in `community-plugins.json`, with the requested period enabled. Both the 0.x per-period layout and the 1.x active calendar set are supported. Core Daily notes settings come from `daily-notes.json` unless `core-plugins.json` disables the plugin.

Configured Obsidian formats get `.md` appended unless they already produce it. `[text]` and `\x` are literal. Unsupported Moment format tokens fail the call rather than falling through to a different note path. Unrecognized braces in environment templates stay literal.

Locale-week start settings are checked in this order.

1. `PERIODIC_WEEK_START`.
2. A day-name `weekStart` in the enabled Calendar plugin's `data.json`.
3. With Periodic Notes enabled, `app.json`, where Periodic Notes 1.x stores the setting.
4. The Periodic Notes plugin's `data.json`.
5. Sunday.

A weekly path from Periodic Notes, or one using locale-week tokens, selects the start of that locale week. For example, a Sunday-start `YYYY-MM-DD` path selects Sunday. Other weekly environment templates select the ISO Monday.

`src/date.ts` implements Moment's `firstWeekOffset` and week-year rollover without importing Moment.

</details>
