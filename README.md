# obsidian-remote-mcp

A self-hosted [MCP](https://modelcontextprotocol.io) server that gives remote MCP clients (Claude, ChatGPT, Notion etc.) secure access to your Obsidian vault over HTTPS without requiring the Obsidian desktop app to be running on the same machine.

It runs as an HTTP service on the machine where your vault lives (an NAS, VPS, or always-on PC/Mac). You keep a copy of your vault on that machine; clients reach them through your deployment of this repo, secured behind OAuth 2.1 authentication. 

## Features

- **Flexible** — configure it to your environment and your vault's conventions.
- **[Layerable security](#security-and-scope)** — secure by default, and you can layer on more as needed for your setup, up to an external access gateway.
- **[Careful, precise edits](#vault-edits)** — it changes your notes safely and surgically:
    - Writes are atomic, so your sync services never see a partial file.
    - Version checks and per-note locks keep two agents from clobbering each other.
    - Read or edit one section or one property; read or update notes in batches.
- **Obsidian-native** — wikilinks, frontmatter, tags, and periodic notes work as expected; moving or renaming a note rewrites the wikilinks pointing at it.

## How it fits together

```text
┌─ sync ─────────────┐
│ ex. Obsidian Sync, │
│ git, rsync         │
└────────────────────┘
           │
           ▼
┌┄┄┄┄┄┄┄┄┄┄┬┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┐
┆ your machine — VPS, NAS, always-on PC/Mac    ┆
┆                                              ┆
┆    ┌─ vault ──┐      ┌─ server ────────────┐ ┆
┆    │ your .md │◄────►│ obsidian-remote-mcp │ ┆
┆    │ files    │      │ (this repo)         │ ┆
┆    └──────────┘      └─────────────────────┘ ┆
┆                                 │            ┆
└┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┼┄┄┄┄┄┄┄┄┄┄┄┄┘
                                  │
                                  ▼  over HTTPS
                     ┌─ access ───────────────┐
                     │ ex. Cloudflare Tunnel, │
                     │ Tailscale              │
                     └────────────────────────┘
                                  │
                                  ▼  authenticated MCP connection
                      ┌─ client ─────────────┐
                      │ ex. Claude, ChatGPT, │
                      │ Cursor, Codex        │
                      └──────────────────────┘
```

The server and its tools are built in. The rest you choose to fit your setup:

- **vault** — the markdown files the server reads and edits
- **sync** — you keep the vault current on the machine using any service; the server reads whatever's on disk.
- **server** — obsidian-remote-mcp, this repo running
- **access** — makes the server reachable over HTTPS. See [Expose it over HTTPS](#2-expose-it-over-https).
- **auth** — built in (OAuth or API key); you can also put an external gate like Cloudflare Zero Trust in front. See [Authentication](#authentication).
- **client** — the app that talks to the server.

## Vault edits

The server edits the same files Obsidian and Obsidian Sync are using. Two things shape how it writes:

- Each write goes to a temporary file that is renamed into place. Obsidian, Sync, or other tools never read a half-written or empty note, even if the process stops mid-write.
- Writes to one note run one at a time. `vault_read` returns a version string; passing it to `vault_update` as `base_version` makes the update fail if the note changed since you read it, instead of overwriting the other edit.

## Security and scope

Access to the vault is controlled in layers.

**Authentication** — a client presents a credential to reach `/mcp`. Two ways to connect:
- **[OAuth 2.1 + PKCE](#oauth-browser-sign-in)** — browser sign-in, presenting your `MCP_CLIENT_ID`.
- **[API key](#api-key-static-bearer-token)** (`MCP_STATIC_BEARER_TOKEN`) — a fixed bearer token, for clients that can't open a browser.

**Approval** — with OAuth, a client is granted access at the approval page, so the server won't start until access is guarded. Set [`VAULT_APPROVAL_PASSWORD`](#password-gate) to require a password there, or rely on a client secret (`MCP_CLIENT_SECRET`), which guards token exchange instead. If a gateway like Cloudflare Zero Trust already fronts `/authorize`, set `VAULT_APPROVAL_OPEN=true`.

**Scope** — `.mcpignore` blocks paths from access, `VAULT_READ_ONLY` disables writes, and `CORS_ALLOWED_ORIGINS` limits browser origins. Paths are always confined to the vault root.

The configurable parts are set as [environment variables](#environment-variables).

## Quick start

Prefer to hand it to a coding agent? [SETUP-PROMPT.md](SETUP-PROMPT.md) is a paste-in prompt that sets it up with you. Or do it by hand:

Getting from a vault on disk to an AI client reading it takes three steps:

1. **Run the server** — locally with Bun, or in Docker.
2. **Expose it over HTTPS** — remote clients and OAuth both require it.
3. **Connect a client** — with browser OAuth or an API key. Per-client steps are under [clients.md](clients.md).

### 1. Run the server

The server is TypeScript on [Bun](https://bun.sh) — no build step; Bun runs `src/server.ts` directly.

**Directly:**

```bash
git clone https://github.com/nweii/obsidian-remote-mcp.git
cd obsidian-remote-mcp
bun install
export VAULT_PATH=/absolute/path/to/your/vault
export MCP_CLIENT_ID=my-vault-mcp
export VAULT_APPROVAL_PASSWORD=pick-a-password   # or VAULT_APPROVAL_OPEN=true behind a gateway
bun run src/server.ts
```

`MCP_CLIENT_ID` is a name you make up — there is no registration step. OAuth clients will present this same ID back to the server, so pick something you can paste into a client config later. It is required even if you only plan to use an API key.

The process listens on port `3456` by default. The MCP endpoint is `POST /mcp`; OAuth metadata is served under `/.well-known/oauth-authorization-server`. `bun start` runs the same entrypoint.

**Docker:**

Save this as `docker-compose.yml` in the cloned repo directory:

```yaml
services:
  obsidian-remote-mcp:
    image: oven/bun:1              # pre-built Bun runtime — no local Bun install needed
    working_dir: /app
    restart: unless-stopped
    environment:
      MCP_CLIENT_ID: your-client-id
      MCP_CLIENT_SECRET: your-client-secret     # optional
      MCP_BASE_URL: https://mcp.example.com
      VAULT_PATH: /vault                         # path inside the container (mapped by volumes below)
      CORS_ALLOWED_ORIGINS: https://claude.ai
      PORT: 3456
      # TOKEN_STORE_PATH: /app/data/tokens.json  # uncomment to persist OAuth sign-ins across restarts
    volumes:
      - ./:/app                                  # mounts the repo into the container
      - /path/to/your/vault:/vault               # left = path on your machine, right = path inside container
      # - ./data:/app/data                       # uncomment to persist TOKEN_STORE_PATH on the host
    command: ["bun", "run", "src/server.ts"]
    ports:
      - "3456:3456"                              # host:container — access on http://localhost:3456
```

```bash
docker compose up -d      # start in background
docker compose logs -f    # watch output
```

### 2. Expose it over HTTPS

Remote MCP and OAuth require **HTTPS**. Use a reverse proxy (Caddy, nginx, Cloudflare Tunnel, etc.) to handle TLS in front of the app and expose a public URL like `https://mcp.example.com`. Set **`MCP_BASE_URL`** on the server to that origin **without** the `/mcp` path — it must match what users see in the browser bar.

If you use Cloudflare Zero Trust, a practical pattern is to put the identity gate **only** on `/authorize`, so users log in to approve access while `/.well-known/*`, `/token`, and `/mcp` stay reachable for the protocol.

### 3. Connect a client

Every client needs two things: your MCP URL (`https://mcp.example.com/mcp` — base URL plus `/mcp`) and one of the two credentials:

| Auth | When | Server setup |
|------|------|--------------|
| **OAuth** (browser sign-in) | The client walks you through a sign-in flow (Claude.ai, Cursor, ChatGPT, Poke via Kitchen) | `MCP_CLIENT_ID`, optionally `MCP_CLIENT_SECRET` |
| **API key** (fixed bearer token) | The client's setup form has an "API key" field, or it can't open a browser (Poke, scripts, `mcp-remote`) | `MCP_STATIC_BEARER_TOKEN` set to a long random string |

Details for each mechanism are under [Authentication](#authentication), and per-client setup (Claude.ai, Cursor, ChatGPT, Poke, scripts) is in [clients.md](clients.md).

## Tools

The server currently exposes these tools:

| Tool | Description |
|------|-------------|
| `vault_context` | Read the vault guidance note configured by `VAULT_CONTEXT_PATH`, or fall back to `AGENTS.md` / `CLAUDE.md` |
| `vault_read` | Full note text (`mode` full, default) with a version for safe updates, or list one folder level (`mode` `list`; `path` `""` = vault root) |
| `vault_batch_read` | Read several notes in one call by path or title; `include_content: false` returns just frontmatter for cheap triage |
| `vault_outline` | All `#` headings in a note (one per line); use before `vault_read_section` |
| `vault_read_section` | Body under a single heading (`heading` = text without `#`, case-insensitive) |
| `vault_read_attachment` | Read a binary attachment by path; images return a renderable image block, other types base64 plus mime/size; `stat_only` checks size first (read-only) |
| `vault_frontmatter` | Read YAML frontmatter from a note; optional `property` for a single key |
| `vault_links` | Read outgoing wikilinks and optional backlinks |
| `vault_create` | Create a new note |
| `vault_update` | Replace a note's full contents; optional `base_version` rejects stale writes |
| `vault_set_frontmatter_property` | Set one frontmatter property without rewriting the note body |
| `vault_batch_frontmatter_update` | Set frontmatter properties on several notes in one call |
| `vault_edit` | Append, prepend, or replace exact text within a note |
| `vault_edit_section` | Append, prepend, or replace the body under one heading |
| `vault_trash` | Move a note to `.trash` |
| `vault_move` | Move or rename any vault file by explicit path and rewrite the wikilinks that point at it; defaults to a dry run that shows the plan and writes nothing |
| `vault_search_title` | Find notes by filename (partial or exact); returns paths for `vault_read` |
| `vault_search_content` | Regex search in note bodies; optional `folder` to scope large vaults |
| `vault_search_frontmatter` | Find notes by a frontmatter property (match type `exact`, `contains`, or `exists`) |
| `vault_tags` | List all tags with note counts, or note paths for one `tag`; counts frontmatter and inline `#tag` |
| `vault_periodic_note` | Read or create a daily, weekly, monthly, quarterly, or yearly note using a per-cadence path template |
| `vault_clip_url` | Save a web page to the vault as a markdown note |
| `vault_feedback` | Log a structured note when an agent gets stuck or wants a tool that doesn't exist |

## Server configuration

### Authentication

Every `POST /mcp` request must send `Authorization: Bearer …`. You can offer **OAuth**, an **API key**, or **both**; each client then uses whichever path it supports.

#### OAuth (browser sign-in)

For clients where the user can open a browser. The server uses **OAuth 2.1**: approve on `/authorize`, exchange the short-lived code at `POST /token`, then send the issued access token in `Authorization` on `/mcp`.

The server does **not** support dynamic client registration (DCR). You configure one fixed client ID, and clients present that same ID — there is no `/register` endpoint. Clients that expect DCR need their manual-credentials path (for example, Poke's Kitchen templates).

The relevant variables:

- **`MCP_CLIENT_ID`** (required) — the one client ID the server accepts.
- **`MCP_CLIENT_SECRET`** (optional) — if set, every OAuth client must send the same value at `POST /token`. If unset, token exchange relies on PKCE alone — use HTTPS and limit who can reach `/authorize`.
- **`MCP_BASE_URL`** — must match the public site origin (no `/mcp`).
- **`MCP_ALLOWED_REDIRECT_URIS`** (optional) — comma-separated allowlist of OAuth callback URIs. When unset, the server allows the callbacks for Claude.ai (`https://claude.ai/api/mcp/auth_callback`), ChatGPT connectors (`https://chatgpt.com/connector_platform_oauth_redirect`), Cursor (`cursor://anysphere.cursor-mcp/oauth/callback`), and Poke (`https://poke.com/api/v1/mcp/callback`) out of the box. Setting the env var **replaces** that default list, so include every callback you want to keep.
- **`TOKEN_STORE_PATH`** (default `./tokens.json`) — stores OAuth-issued tokens after login so clients survive server restarts.

#### API key (static bearer token)

For scripts and clients that cannot open a browser, use a long random string as your API key for  `MCP_STATIC_BEARER_TOKEN`  on the server end. Then give the client the same value for `Authorization: Bearer [your key]`. 

The client will then use this for every `/mcp` request. The server compares it directly, skipping `/authorize`, `POST /token`, and `TOKEN_STORE_PATH` for that client. This works alongside OAuth — setting it does not disable the browser flow for other clients.

The trade-off versus OAuth is that the token is long-lived and held by the client service. You'll need to replace this token with a new one if you ever suspect exposure.

To generate a random, secure API key, run this in your terminal:

```bash
# generate one
openssl rand -base64 48
```

#### CORS

`CORS_ALLOWED_ORIGINS` limits which **browser origins** may call the API from JavaScript. It is separate from OAuth and from `MCP_STATIC_BEARER_TOKEN`, and irrelevant to server-side clients like Poke. Default is `*` (allow all). To restrict:

```env
CORS_ALLOWED_ORIGINS=https://claude.ai
CORS_ALLOWED_ORIGINS=https://claude.ai,http://localhost:3000
```

When set, only listed origins get a reflected `Access-Control-Allow-Origin`; other browser preflights fail.

#### Password gate

The OAuth approval page must be guarded, and the server refuses to start otherwise. Set `VAULT_APPROVAL_PASSWORD` to require a password on that page before a code is issued; it's checked on every authorization. A client secret (`MCP_CLIENT_SECRET`) satisfies the guard instead, by blocking token exchange.

If a reverse proxy or zero-trust gateway already guards `/authorize` (the stronger control), set `VAULT_APPROVAL_OPEN=true` for the click-to-approve page instead.

### Health endpoint

`GET /health` is a liveness probe for uptime monitors. It is **default-closed**: with `HEALTH_TOKEN` unset the route returns 404, so a fresh deploy exposes nothing. Set **`HEALTH_TOKEN`** to a long random string to turn it on, and the monitor must send that value as `Authorization: Bearer …`. A wrong or missing token returns 401.

It is a separate secret from `MCP_CLIENT_SECRET` and `MCP_STATIC_BEARER_TOKEN`, so you can rotate it without touching any OAuth client config, and the credential pasted into a third-party monitor grants no vault access — leaking it reveals nothing but the response below.

Each request stats the vault root once, which catches the case where the process is up but the volume mount is broken (a realistic NAS failure). The response is:

```json
{ "ok": true, "version": "1.0.0", "uptime_seconds": 1234.5 }
```

- `ok` — `true`, or `false` with HTTP **503** when the vault stat fails, so monitors can alert on the status code alone.
- `version` — from `package.json`, to confirm a deploy landed.
- `uptime_seconds` — process uptime; a green monitor with constantly resetting uptime means the container is crash-looping.

Nothing else is returned — no vault name, paths, or counts.

```bash
# generate a token
openssl rand -base64 48
```

Sample Uptime Kuma monitor: type **HTTP(s)**, URL `https://mcp.example.com/health`, accepted status codes `200`, and under HTTP Options add a header `Authorization: Bearer YOUR_HEALTH_TOKEN`.

### Environment variables

Configuration is through environment variables. There's no required `.env` file — set them wherever your deployment takes config: a Docker Compose `environment:` block, a dashboard field (Portainer and similar), an `.env` file you load, or a shell `export`.

```env
MCP_CLIENT_ID=your-client-id
MCP_CLIENT_SECRET=your-client-secret   # optional
VAULT_APPROVAL_PASSWORD=                # password for the OAuth approval page; required unless MCP_CLIENT_SECRET or VAULT_APPROVAL_OPEN is set
VAULT_APPROVAL_OPEN=                    # set true to allow click-to-approve when a gateway already guards /authorize
MCP_BASE_URL=https://mcp.example.com
MCP_ALLOWED_REDIRECT_URIS=https://claude.ai/api/mcp/auth_callback # optional; overrides the built-in defaults
VAULT_PATH=/path/to/your/vault         # optional if obsidian.json is available
OBSIDIAN_VAULT_ID=personal             # optional when obsidian.json contains multiple vaults
VAULT_DISPLAY_NAME=Personal            # optional; defaults to the vault directory name
VAULT_CONTEXT_PATH=AGENTS.md           # optional; defaults to AGENTS.md, then CLAUDE.md
DAILY_NOTE_PATH_TEMPLATE=Daily/{YYYY}-{MM}-{DD}.md
WEEKLY_NOTE_PATH_TEMPLATE=Weekly/{GGGG}-W{WW}.md       # optional; opt-in cadence
MONTHLY_NOTE_PATH_TEMPLATE=Monthly/{YYYY}-{MM}.md      # optional; opt-in cadence
QUARTERLY_NOTE_PATH_TEMPLATE=Quarterly/{YYYY}-Q{Q}.md  # optional; opt-in cadence
YEARLY_NOTE_PATH_TEMPLATE=Yearly/{YYYY}.md             # optional; opt-in cadence
CORS_ALLOWED_ORIGINS=https://claude.ai # optional; defaults to *
TOKEN_STORE_PATH=./tokens.json         # optional
MCP_STATIC_BEARER_TOKEN=               # optional; API key for /mcp (see Authentication)
HEALTH_TOKEN=                          # optional; enables GET /health (see Health endpoint)
VAULT_READ_ONLY=true                   # optional
VAULT_ATTACHMENT_MAX_BYTES=10485760    # optional; vault_read_attachment size cap, defaults to 10 MB
PORT=3456
```

### Vault path

The server resolves the vault root in this order:

1. `VAULT_PATH`, if set
2. `.config/obsidian/obsidian.json`, found by walking up from the current working directory or from the package directory

If `obsidian.json` contains multiple vaults, set `OBSIDIAN_VAULT_ID` to the vault entry you want to use.

The display name used in the OAuth approval page defaults to the resolved vault directory name. You can override that with `VAULT_DISPLAY_NAME`.

#### Headless / no Obsidian installed

Most users should just set `VAULT_PATH` and skip this. If you prefer the automatic discovery path on a machine without Obsidian, create the config file yourself:

```bash
mkdir -p ~/.config/obsidian
```

`~/.config/obsidian/obsidian.json`:

```json
{
  "vaults": {
    "personal": {
      "path": "/home/user/vaults/personal"
    }
  }
}
```

With multiple vaults, add more entries and set `OBSIDIAN_VAULT_ID` to the one you want. Use absolute paths — `~` is not expanded inside `obsidian.json`.

### Vault context note

`vault_context` is meant to help agents learn your vault structure before they start writing. By default it looks for `AGENTS.md` or `CLAUDE.md`.

If your vault uses a different bootstrap file, set `VAULT_CONTEXT_PATH` to the relative path you want the tool to read.

If you do not want to maintain one, the server still works without it.

### Periodic note paths

`vault_periodic_note` reads or creates a note for one of five cadences — `daily`, `weekly`, `monthly`, `quarterly`, `yearly`. It replaces the earlier `vault_daily_note` tool; clients pick up the new tool on their next tool-list refresh, and `period: daily` behaves exactly as the old daily tool did. The tool takes an optional `date` (`YYYY-MM-DD`), which is bucketed into the week, month, quarter, or year that contains it, so any day in a period maps to the same note.

Each cadence has its own opt-in path template env var:

| Cadence | Env var |
|---------|---------|
| `daily` | `DAILY_NOTE_PATH_TEMPLATE` |
| `weekly` | `WEEKLY_NOTE_PATH_TEMPLATE` |
| `monthly` | `MONTHLY_NOTE_PATH_TEMPLATE` |
| `quarterly` | `QUARTERLY_NOTE_PATH_TEMPLATE` |
| `yearly` | `YEARLY_NOTE_PATH_TEMPLATE` |

Only the daily cadence has a built-in default:

```text
Daily/{YYYY}-{MM}-{DD}.md
```

The other four are opt-in — calling a cadence with no template configured returns an error naming the env var to set. These are convenience templates; many vaults use different layouts, so you will likely want to override them.

Supported tokens:

- `{YYYY}`: 4-digit calendar year
- `{YY}`: 2-digit calendar year
- `{GGGG}`: 4-digit ISO week-year (use with `{WW}`, not `{YYYY}`)
- `{GG}`: 2-digit ISO week-year
- `{WW}`: 2-digit ISO week number (weeks start Monday; week 1 contains the first Thursday)
- `{Q}`: quarter number (`1`–`4`)
- `{MM}`: 2-digit month
- `{M}`: month without zero padding
- `{DD}`: 2-digit day
- `{D}`: day without zero padding
- `{MMM}`: short month name like `Mar`
- `{MMMM}`: full month name like `March`
- `{dd}`: short weekday name like `Th`
- `{ddd}`: short weekday name like `Mon`
- `{dddd}`: full weekday name like `Monday`

The ISO week-year (`{GGGG}`) differs from the calendar year (`{YYYY}`) around New Year — for example `2025-12-29` falls in ISO week 1 of 2026. Pair `{WW}` with `{GGGG}` so the year matches the week; pairing it with `{YYYY}` produces wrong paths at that boundary.

Examples:

```env
DAILY_NOTE_PATH_TEMPLATE=Daily/{YYYY}/{YYYY}-{MM}-{DD}.md
DAILY_NOTE_PATH_TEMPLATE=Journal/{YYYY}/{MMM}/{D}-{ddd}.md
WEEKLY_NOTE_PATH_TEMPLATE=Weekly/{GGGG}-W{WW}.md
MONTHLY_NOTE_PATH_TEMPLATE=Monthly/{YYYY}-{MM}.md
QUARTERLY_NOTE_PATH_TEMPLATE=Quarterly/{YYYY}-Q{Q}.md
YEARLY_NOTE_PATH_TEMPLATE=Yearly/{YYYY}.md
```

## Notes

### MCP and HTTP

- `GET /mcp` returns `405`, not `404`, so streamable HTTP clients know the server only accepts MCP over `POST`.

### Vault access and tool defaults

- All vault paths are validated against the resolved vault root to prevent directory traversal.
- `.mcpignore` in the vault root can block paths from all MCP access.
- `VAULT_READ_ONLY=true` blocks all write operations.
- `vault_search_title` defaults to `limit=50`; `vault_search_content` defaults to `limit=20`. Limits are adjustable; `0` means no limit.
- `vault_tags` defaults to `limit=100` when listing all tags; passing a `tag` returns the matching note paths without a limit. Counts are case-insensitive (displayed in first-seen casing) and nested tags match exactly — `parent` does not include `parent/child`.
- `vault_frontmatter` and `vault_set_frontmatter_property` let agents work with frontmatter properties without reading or rewriting the whole note body.
- `vault_read` returns a version block. Pass it to `vault_update` as `base_version` if you want stale full-note updates to fail instead of overwriting another edit.
- `vault_move` takes explicit vault-relative paths (with extension) for both source and destination — bare titles are rejected, since a move is a mutation and title resolution adds ambiguity exactly where it isn't wanted. Use `vault_search_title` first to find the path. It also rewrites the wikilinks that point at the moved file, across note bodies and frontmatter (string and array values) and `.canvas` node paths.
- `vault_move` rewrites conservatively. `dry_run` defaults to `true`: the call returns the full plan — every file and the rewrites it would make, plus `.base` files to review and any ambiguous links it would skip — and writes nothing, not even the move. Pass `dry_run: false` to move the file (first) and apply the rewrites (after). All wikilink forms are handled — `[[Note]]`, `[[folder/Note]]`, `[[Note#Heading]]`, `[[Note#^block]]`, `[[Note|alias]]`, embeds `![[Note]]`, links carrying an explicit extension, and combinations — with the alias, heading, and block parts preserved.
- A pure move (same filename, new folder) leaves bare `[[Name]]` links alone, since Obsidian still resolves them by filename; only path-form links are repointed. A rename rewrites every form. If another file shares the old basename, bare-name links are ambiguous and skipped with a warning rather than guessed. Wikilinks inside fenced code blocks and inline code are left untouched. `.base` files are never edited — any that mention the old name or path are reported for manual attention, because rewriting strings inside Base formulas is too risky. `.mcpignore`d notes are neither scanned nor modified.

## Similar projects

[obsidian-web-mcp](https://github.com/jimprosser/obsidian-web-mcp) is another remote MCP server for Obsidian vaults, written in Python. The two cover much of the same ground but are built differently: obsidian-web-mcp keeps an in-memory index of the vault, while obsidian-remote-mcp is stateless, reading the current vault on each request. 

## Tests

```bash
bun test
```
