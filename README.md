# obsidian-remote-mcp

A self-hosted [MCP](https://modelcontextprotocol.io) server for headless Obsidian vaults. It gives remote AI clients read and write access to a vault over HTTPS **without requiring the Obsidian desktop app to be running on the same machine.**

It works directly from the vault files on disk — no Obsidian app or sync service required. This is meant for server environments: home servers, NAS boxes, VPSes, and other setups where your vault lives on disk and you want to expose it through a remote MCP endpoint for apps like Claude.ai.

## Security and scope

Remote MCP is powerful access to your vault — use HTTPS, and think about where the service listens.

Built-in safeguards:

- **OAuth 2.1 + PKCE** with optional `MCP_CLIENT_SECRET` on token exchange
- **Fixed bearer token** (`MCP_STATIC_BEARER_TOKEN`) for clients that skip browser auth
- **CORS allowlisting** (`CORS_ALLOWED_ORIGINS`) for browser-based clients
- **Vault path sandboxing** — all paths validated against the vault root
- **`.mcpignore`** to block specific paths from MCP access
- **`VAULT_READ_ONLY`** mode to prevent all writes

## What it includes

The server currently exposes these tools:

| Tool | Description |
|------|-------------|
| `vault_context` | Read the vault guidance note configured by `VAULT_CONTEXT_PATH`, or fall back to `AGENTS.md` / `CLAUDE.md` |
| `vault_read` | Full note text (`mode` full, default) or list one folder level (`mode` `list`; `path` `""` = vault root) |
| `vault_outline` | All `#` headings in a note (one per line); use before `vault_read_section` |
| `vault_read_section` | Body under a single heading (`heading` = text without `#`, case-insensitive) |
| `vault_frontmatter` | Read YAML frontmatter from a note; optional `property` for a single key |
| `vault_links` | Read outgoing wikilinks and optional backlinks |
| `vault_create` | Create a new note |
| `vault_update` | Replace a note's full contents |
| `vault_set_frontmatter_property` | Set one frontmatter property without rewriting the note body |
| `vault_edit` | Append, prepend, or replace exact text within a note |
| `vault_trash` | Move a note to `.trash` |
| `vault_search_title` | Find notes by filename (partial or exact); returns paths for `vault_read` |
| `vault_search_content` | Regex search in note bodies; optional `folder` to scope large vaults |
| `vault_daily_note` | Read or create a daily note using a configurable path template |

## Quick start

**Runtime.** The server is TypeScript on [Bun](https://bun.sh). There is no separate build step for normal use: Bun runs `src/server.ts` directly. Install dependencies with `bun install` (Express, the MCP SDK, and a few libraries—see `package.json`).

**Vault on disk.** Point the server at your vault root with `VAULT_PATH`, or leave it unset and use Obsidian’s `obsidian.json` discovery (details under **Vault path** below).

```bash
git clone https://github.com/nweii/obsidian-remote-mcp.git
cd obsidian-remote-mcp
bun install
export VAULT_PATH=/absolute/path/to/your/vault
export MCP_CLIENT_ID=dev
bun run src/server.ts
```

`bun start` runs the same entrypoint (`package.json` maps it to `bun run src/server.ts`).

The process listens on port `3456` by default. The MCP endpoint is `POST /mcp` on that port; OAuth metadata is served under `/.well-known/oauth-authorization-server`.

To make the server reachable from the internet (required by Claude.ai and other remote clients), see **Deployment** below.

## Deployment

### Docker

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

### HTTPS and `MCP_BASE_URL`

Remote MCP and OAuth require **HTTPS**. Use a reverse proxy (Caddy, nginx, Cloudflare Tunnel, etc.) to handle TLS in front of the app and expose a public URL like `https://mcp.example.com`. Set **`MCP_BASE_URL`** on the server to that origin **without** the `/mcp` path — it must match what users see in the browser bar.

If you use Cloudflare Zero Trust, a practical pattern is to put the identity gate **only** on `/authorize`, so users log in to approve access while `/.well-known/*`, `/oauth/token`, and `/mcp` stay reachable for the protocol.

### Environment variables

Set these on the server process (Compose `environment:`, Portainer, shell `export`, etc.):

```env
MCP_CLIENT_ID=your-client-id
MCP_CLIENT_SECRET=your-client-secret   # optional
MCP_BASE_URL=https://mcp.example.com
MCP_ALLOWED_REDIRECT_URIS=https://claude.ai/api/mcp/auth_callback # optional
VAULT_PATH=/path/to/your/vault         # optional if obsidian.json is available
OBSIDIAN_VAULT_ID=personal             # optional when obsidian.json contains multiple vaults
VAULT_DISPLAY_NAME=Personal            # optional; defaults to the vault directory name
VAULT_CONTEXT_PATH=AGENTS.md           # optional; defaults to AGENTS.md, then CLAUDE.md
DAILY_NOTE_PATH_TEMPLATE=Daily/{YYYY}-{MM}-{DD}.md
CORS_ALLOWED_ORIGINS=https://claude.ai # optional; defaults to *
TOKEN_STORE_PATH=./tokens.json         # optional
MCP_STATIC_BEARER_TOKEN=               # optional; fixed Bearer for /mcp (e.g. mcp-remote + Antigravity)
VAULT_READ_ONLY=true                   # optional
PORT=3456
```

`VAULT_PATH`, `VAULT_CONTEXT_PATH`, and `DAILY_NOTE_PATH_TEMPLATE` are also documented under **Vault path**, **Vault context note**, and **Daily note paths** later in this readme.

### Authenticating to `/mcp`

Every `POST /mcp` request must send `Authorization: Bearer …`. You can offer **OAuth**, **fixed bearer**, or **both**; each client then uses whichever path it supports.

#### OAuth (browser)

For clients where the user can open a browser. The server uses **OAuth 2.1**: approve on `/authorize`, exchange the short-lived code at `POST /oauth/token`, then send the issued access token in `Authorization` on `/mcp`.

**Server:** **`MCP_CLIENT_ID`** is required. **`MCP_CLIENT_SECRET`** is optional; if you set it on the server, configure the same value in each OAuth client so they send it at `POST /oauth/token`. If you leave it unset, that step does not use a shared secret—use HTTPS and limit who can reach `/authorize`. **`MCP_BASE_URL`** must match the public site origin (no `/mcp`). **`MCP_ALLOWED_REDIRECT_URIS`** is an optional comma-separated list; Claude’s callback is allowed by default.

**Persisted sign-in:** **`TOKEN_STORE_PATH`** (default `./tokens.json`) stores OAuth-issued tokens after login so clients survive server restarts.

**Add as a remote MCP connector to Claude** (paid plans only): Use your base URL with `/mcp` included. Under advanced settings, set OAuth client ID to your **`MCP_CLIENT_ID`**, optionally OAuth client secret to your **`MCP_CLIENT_SECRET`** (required at token exchange if the server has a secret configured). On the server, set **`MCP_BASE_URL`** to the same origin as the connector URL, without `/mcp`.

Cursor `mcp.json`:

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

Cursor uses the redirect URI **`cursor://anysphere.cursor-mcp/oauth/callback`**. Add it to **`MCP_ALLOWED_REDIRECT_URIS`** on the server (comma-separated alongside any other clients, e.g. Claude’s callback).

#### Fixed bearer (non-browser)

For scripts, Antigravity + `mcp-remote`, or any client that cannot run the browser flow. Do not set both **`auth`** and **`headers`** on the same mcp.json entry—pick OAuth or fixed bearer.

Set **`MCP_STATIC_BEARER_TOKEN`** on the server; the client sends that exact string as `Authorization: Bearer …` on every `/mcp` request. This skips `/authorize`, `POST /oauth/token`, **`TOKEN_STORE_PATH`** for that client.

Antigravity `mcp_config.json`:

```json
"obsidian-vault": {
  "serverUrl": "https://your-host/mcp",
  "headers": {
    "Authorization": "Bearer YOUR_MCP_STATIC_BEARER_TOKEN"
  }
}
```

Cursor `mcp.json`:

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

Bridging over stdio with **`mcp-remote`**:

```json
"obsidian-vault": {
  "command": "bunx",
  "args": ["-y", "mcp-remote", "https://your-host/mcp", "--transport", "http-only", "--header", "Authorization: Bearer YOUR_MCP_STATIC_BEARER_TOKEN"]
}
```

### CORS

`CORS_ALLOWED_ORIGINS` limits which **browser origins** may call the API from JavaScript. It is separate from OAuth and from `MCP_STATIC_BEARER_TOKEN`. Default is `*` (allow all). To restrict:

```env
CORS_ALLOWED_ORIGINS=https://claude.ai
CORS_ALLOWED_ORIGINS=https://claude.ai,http://localhost:3000
```

When set, only listed origins get a reflected `Access-Control-Allow-Origin`; other browser preflights fail.

## Vault path

The server resolves the vault root in this order:

1. `VAULT_PATH`, if set
2. `.config/obsidian/obsidian.json`, found by walking up from the current working directory or from the package directory

If `obsidian.json` contains multiple vaults, set `OBSIDIAN_VAULT_ID` to the vault entry you want to use.

The display name used in the OAuth approval page defaults to the resolved vault directory name. You can override that with `VAULT_DISPLAY_NAME`.

### Headless / no Obsidian installed

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

## Vault context note

`vault_context` is meant to help agents learn your vault structure before they start writing. By default it looks for `AGENTS.md` or `CLAUDE.md`.

If your vault uses a different bootstrap file, set `VAULT_CONTEXT_PATH` to the relative path you want the tool to read.

If you do not want to maintain one, the server still works without it.

## Daily note paths

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

## Tests

```bash
bun test
```
