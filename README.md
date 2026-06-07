# obsidian-remote-mcp

A self-hosted [MCP](https://modelcontextprotocol.io) server for headless Obsidian vaults. It gives remote AI clients read and write access to a vault over HTTPS **without requiring the Obsidian desktop app to be running on the same machine.**

## Features

This is meant for home servers, NAS boxes, VPSes, and other setups where your vault lives on disk and you want to expose it through a remote MCP endpoint for apps like Claude.ai, ChatGPT, and Cursor.

- OAuth (browser sign-in) or an API key (fixed bearer token), depending on what the client supports.
- `vault_context` serves your vault guide note (defaults to `AGENTS.md`) plus a shallow folder tree so agents can see your vault structure.
- Daily notes from a path template you configure.
- Create, edit, update, and trash notes; wikilinks and YAML frontmatter work as usual.
- Token-efficient partial access: read or edit one section under a heading, work with individual frontmatter properties, and list headings before reading. The [tools table](#tools) has the full set.
- Full-note updates can check the version you last read, so another agent's edit is not overwritten by accident.
- Search by filename or regex in note text; content search can be scoped to a folder.
- Block paths with `.mcpignore`; set `VAULT_READ_ONLY` to turn off writes.
- Optional JSONL logs of tool calls (note bodies redacted) if you want to review what agents did.

## Tools

The server currently exposes these tools:

| Tool | Description |
|------|-------------|
| `vault_context` | Read the vault guidance note configured by `VAULT_CONTEXT_PATH`, or fall back to `AGENTS.md` / `CLAUDE.md` |
| `vault_read` | Full note text (`mode` full, default) with a version for safe updates, or list one folder level (`mode` `list`; `path` `""` = vault root) |
| `vault_outline` | All `#` headings in a note (one per line); use before `vault_read_section` |
| `vault_read_section` | Body under a single heading (`heading` = text without `#`, case-insensitive) |
| `vault_frontmatter` | Read YAML frontmatter from a note; optional `property` for a single key |
| `vault_links` | Read outgoing wikilinks and optional backlinks |
| `vault_create` | Create a new note |
| `vault_update` | Replace a note's full contents; optional `base_version` rejects stale writes |
| `vault_set_frontmatter_property` | Set one frontmatter property without rewriting the note body |
| `vault_edit` | Append, prepend, or replace exact text within a note |
| `vault_edit_section` | Append, prepend, or replace the body under one heading |
| `vault_trash` | Move a note to `.trash` |
| `vault_move` | Move or rename any vault file by explicit path and rewrite the wikilinks that point at it; defaults to a dry run that shows the plan and writes nothing |
| `vault_search_title` | Find notes by filename (partial or exact); returns paths for `vault_read` |
| `vault_search_content` | Regex search in note bodies; optional `folder` to scope large vaults |
| `vault_daily_note` | Read or create a daily note using a configurable path template |

## Security and scope

Built-in safeguards:

- **OAuth 2.1 + PKCE** with optional `MCP_CLIENT_SECRET` on token exchange
- **API key** (`MCP_STATIC_BEARER_TOKEN`) for clients that take a fixed credential instead of browser auth
- **CORS allowlisting** (`CORS_ALLOWED_ORIGINS`) for browser-based clients
- **Vault path sandboxing** — all paths validated against the vault root
- **`.mcpignore`** to block specific paths from MCP access
- **`VAULT_READ_ONLY`** mode to prevent all writes

## Quick start

Getting from a vault on disk to an AI client reading it takes three steps:

1. **Run the server** — locally with Bun, or in Docker.
2. **Expose it over HTTPS** — remote clients and OAuth both require it.
3. **Connect a client** — with browser OAuth or an API key. Per-client steps are under [Client setup guides](#client-setup-guides).

### 1. Run the server

The server is TypeScript on [Bun](https://bun.sh) — no build step; Bun runs `src/server.ts` directly.

**Directly:**

```bash
git clone https://github.com/nweii/obsidian-remote-mcp.git
cd obsidian-remote-mcp
bun install
export VAULT_PATH=/absolute/path/to/your/vault
export MCP_CLIENT_ID=my-vault-mcp
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

If you use Cloudflare Zero Trust, a practical pattern is to put the identity gate **only** on `/authorize`, so users log in to approve access while `/.well-known/*`, `/oauth/token`, and `/mcp` stay reachable for the protocol.

### 3. Connect a client

Every client needs two things: your MCP URL (`https://mcp.example.com/mcp` — base URL plus `/mcp`) and one of the two credentials:

| Auth | When | Server setup |
|------|------|--------------|
| **OAuth** (browser sign-in) | The client walks you through a sign-in flow (Claude.ai, Cursor, ChatGPT, Poke via Kitchen) | `MCP_CLIENT_ID`, optionally `MCP_CLIENT_SECRET` |
| **API key** (fixed bearer token) | The client's setup form has an "API key" field, or it can't open a browser (Poke, scripts, `mcp-remote`) | `MCP_STATIC_BEARER_TOKEN` set to a long random string |

Details for each mechanism are under [Authentication](#authentication).

## Client setup guides

### Claude.ai

Available on paid plans, as a custom connector. Use your base URL with `/mcp` included. Under advanced settings, set OAuth client ID to your **`MCP_CLIENT_ID`**, and OAuth client secret to your **`MCP_CLIENT_SECRET`** if you've configured one for your server. On the server, set **`MCP_BASE_URL`** to the same origin as the connector URL, without `/mcp`.

Claude's OAuth callback is in the server's default redirect allowlist, so no further configuration is needed.

### Cursor

Cursor supports both auth styles in `mcp.json`. Pick one — do not set both `auth` and `headers` on the same entry.

OAuth:

```json
{
  "mcpServers": {
    "obsidian-vault": {
      "url": "https://your-host/mcp",
      "auth": {
        "CLIENT_ID": "your-mcp-client-id",
        "CLIENT_SECRET": "your-mcp-client-secret (optional)"
      }
    }
  }
}
```

API key:

```json
{
  "mcpServers": {
    "obsidian-vault": {
      "url": "https://your-host/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_MCP_STATIC_BEARER_TOKEN"
      }
    }
  }
}
```

Cursor's OAuth redirect URI (`cursor://anysphere.cursor-mcp/oauth/callback`) is in the default allowlist. If you set **`MCP_ALLOWED_REDIRECT_URIS`** yourself, include it so Cursor can still complete OAuth.

### ChatGPT

Add the server as a connector with your MCP URL and OAuth credentials. ChatGPT's legacy fixed callback (`https://chatgpt.com/connector_platform_oauth_redirect`) is in the default allowlist. Newer connectors may present a per-app callback URL (`https://chatgpt.com/connector/oauth/…`) during setup — if OAuth fails with `redirect_uri not allowed`, add the URL ChatGPT shows you to **`MCP_ALLOWED_REDIRECT_URIS`**.

### Poke

[Poke](https://poke.com) supports both auth styles:

- **API key (simpler).** Set `MCP_STATIC_BEARER_TOKEN` on the server. At [poke.com/integrations/new](https://poke.com/integrations/new), enter your MCP URL and paste the same token into the **API Key** field. Poke sends it as `Authorization: Bearer …`, which is exactly what the server expects.
- **OAuth (via Kitchen).** Poke's standard OAuth path assumes dynamic client registration, which this server [does not support](#oauth-browser-sign-in). Use Poke's fixed-credentials flow instead: at [poke.com/kitchen](https://poke.com/kitchen), create a template with your MCP URL, **`MCP_CLIENT_ID`**, and **`MCP_CLIENT_SECRET`**, then a recipe that includes it. Leave **scopes** blank (the server ignores them). Poke's callback (`https://poke.com/api/v1/mcp/callback`) is in the default redirect allowlist.

### Scripts and headless clients

For anything that just sends HTTP headers, use the API key. Antigravity `mcp_config.json`:

```json
"obsidian-vault": {
  "serverUrl": "https://your-host/mcp",
  "headers": {
    "Authorization": "Bearer YOUR_MCP_STATIC_BEARER_TOKEN"
  }
}
```

Bridging over stdio with **`mcp-remote`**:

```json
"obsidian-vault": {
  "command": "bunx",
  "args": ["-y", "mcp-remote", "https://your-host/mcp", "--transport", "http-only", "--header", "Authorization: Bearer YOUR_MCP_STATIC_BEARER_TOKEN"]
}
```

## Server configuration

### Authentication

Every `POST /mcp` request must send `Authorization: Bearer …`. You can offer **OAuth**, an **API key**, or **both**; each client then uses whichever path it supports.

#### OAuth (browser sign-in)

For clients where the user can open a browser. The server uses **OAuth 2.1**: approve on `/authorize`, exchange the short-lived code at `POST /oauth/token`, then send the issued access token in `Authorization` on `/mcp`.

The server does **not** support dynamic client registration (DCR). You configure one fixed client ID, and clients present that same ID — there is no `/register` endpoint. Clients that expect DCR need their manual-credentials path (for example, Poke's Kitchen templates).

The relevant variables:

- **`MCP_CLIENT_ID`** (required) — the one client ID the server accepts.
- **`MCP_CLIENT_SECRET`** (optional) — if set, every OAuth client must send the same value at `POST /oauth/token`. If unset, token exchange relies on PKCE alone — use HTTPS and limit who can reach `/authorize`.
- **`MCP_BASE_URL`** — must match the public site origin (no `/mcp`).
- **`MCP_ALLOWED_REDIRECT_URIS`** (optional) — comma-separated allowlist of OAuth callback URIs. When unset, the server allows the callbacks for Claude.ai (`https://claude.ai/api/mcp/auth_callback`), ChatGPT connectors (`https://chatgpt.com/connector_platform_oauth_redirect`), Cursor (`cursor://anysphere.cursor-mcp/oauth/callback`), and Poke (`https://poke.com/api/v1/mcp/callback`) out of the box. Setting the env var **replaces** that default list, so include every callback you want to keep.
- **`TOKEN_STORE_PATH`** (default `./tokens.json`) — stores OAuth-issued tokens after login so clients survive server restarts.

#### API key (static bearer token)

When a client's setup form asks for an API key (Poke, and most hosted MCP integrations), use `MCP_STATIC_BEARER_TOKEN`. It also covers scripts and clients that cannot open a browser.

Set **`MCP_STATIC_BEARER_TOKEN`** on the server to a long random string, and give the client the same value. The client sends it as `Authorization: Bearer …` on every `/mcp` request; the server compares it directly, skipping `/authorize`, `POST /oauth/token`, and `TOKEN_STORE_PATH` for that client. It works alongside OAuth — setting it does not disable the browser flow for other clients.

The trade-off versus OAuth: the token is long-lived and held by the client service, so rotate it (change the env var and update the client) if you ever suspect exposure.

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

Set these on the server process (Compose `environment:`, Portainer, shell `export`, etc.):

```env
MCP_CLIENT_ID=your-client-id
MCP_CLIENT_SECRET=your-client-secret   # optional
MCP_BASE_URL=https://mcp.example.com
MCP_ALLOWED_REDIRECT_URIS=https://claude.ai/api/mcp/auth_callback # optional; overrides the built-in defaults
VAULT_PATH=/path/to/your/vault         # optional if obsidian.json is available
OBSIDIAN_VAULT_ID=personal             # optional when obsidian.json contains multiple vaults
VAULT_DISPLAY_NAME=Personal            # optional; defaults to the vault directory name
VAULT_CONTEXT_PATH=AGENTS.md           # optional; defaults to AGENTS.md, then CLAUDE.md
DAILY_NOTE_PATH_TEMPLATE=Daily/{YYYY}-{MM}-{DD}.md
CORS_ALLOWED_ORIGINS=https://claude.ai # optional; defaults to *
TOKEN_STORE_PATH=./tokens.json         # optional
MCP_STATIC_BEARER_TOKEN=               # optional; API key for /mcp (see Authentication)
HEALTH_TOKEN=                          # optional; enables GET /health (see Health endpoint)
VAULT_READ_ONLY=true                   # optional
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

### Daily note paths

`vault_daily_note` uses `DAILY_NOTE_PATH_TEMPLATE`, which defaults to:

```text
Daily/{YYYY}-{MM}-{DD}.md
```

This is only a convenience tool. Many vaults use different daily note layouts, so you will likely want to override it.

Supported tokens:

- `{YYYY}`: 4-digit year
- `{YY}`: 2-digit year
- `{MM}`: 2-digit month
- `{M}`: month without zero padding
- `{DD}`: 2-digit day
- `{D}`: day without zero padding
- `{MMM}`: short month name like `Mar`
- `{MMMM}`: full month name like `March`
- `{dd}`: short weekday name like `Th`
- `{ddd}`: short weekday name like `Mon`
- `{dddd}`: full weekday name like `Monday`

Examples:

```env
DAILY_NOTE_PATH_TEMPLATE=Daily/{YYYY}/{YYYY}-{MM}-{DD}.md
DAILY_NOTE_PATH_TEMPLATE=Journal/{YYYY}-{MM}-{DD}-{dddd}.md
DAILY_NOTE_PATH_TEMPLATE=Journal/{YYYY}/{MMM}/{D}-{ddd}.md
```

## Notes

### MCP and HTTP

- `GET /mcp` returns `405`, not `404`, so streamable HTTP clients know the server only accepts MCP over `POST`.

### Vault access and tool defaults

- All vault paths are validated against the resolved vault root to prevent directory traversal.
- `.mcpignore` in the vault root can block paths from all MCP access.
- `VAULT_READ_ONLY=true` blocks all write operations.
- `vault_search_title` defaults to `limit=50`; `vault_search_content` defaults to `limit=20`. Limits are adjustable; `0` means no limit.
- `vault_frontmatter` and `vault_set_frontmatter_property` let agents work with frontmatter properties without reading or rewriting the whole note body.
- `vault_read` returns a version block. Pass it to `vault_update` as `base_version` if you want stale full-note updates to fail instead of overwriting another edit.
- `vault_move` takes explicit vault-relative paths (with extension) for both source and destination — bare titles are rejected, since a move is a mutation and title resolution adds ambiguity exactly where it isn't wanted. Use `vault_search_title` first to find the path. It also rewrites the wikilinks that point at the moved file, across note bodies and frontmatter (string and array values) and `.canvas` node paths.
- `vault_move` rewrites conservatively. `dry_run` defaults to `true`: the call returns the full plan — every file and the rewrites it would make, plus `.base` files to review and any ambiguous links it would skip — and writes nothing, not even the move. Pass `dry_run: false` to move the file (first) and apply the rewrites (after). All wikilink forms are handled — `[[Note]]`, `[[folder/Note]]`, `[[Note#Heading]]`, `[[Note#^block]]`, `[[Note|alias]]`, embeds `![[Note]]`, links carrying an explicit extension, and combinations — with the alias, heading, and block parts preserved.
- A pure move (same filename, new folder) leaves bare `[[Name]]` links alone, since Obsidian still resolves them by filename; only path-form links are repointed. A rename rewrites every form. If another file shares the old basename, bare-name links are ambiguous and skipped with a warning rather than guessed. Wikilinks inside fenced code blocks and inline code are left untouched. `.base` files are never edited — any that mention the old name or path are reported for manual attention, because rewriting strings inside Base formulas is too risky. `.mcpignore`d notes are neither scanned nor modified.

## Tests

```bash
bun test
```
