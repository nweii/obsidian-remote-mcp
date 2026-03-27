# obsidian-remote-mcp

A self-hosted [MCP](https://modelcontextprotocol.io) server for headless Obsidian vaults. It gives remote AI clients read and write access to a vault over HTTPS **without requiring the Obsidian desktop app to be running on the same machine.**

This is meant for server environments: home servers, NAS boxes, VPSes, containers, and other setups where your vault lives on disk and you want to expose it through a remote MCP endpoint for apps like Claude.ai.
`obsidian-remote-mcp` is filesystem-backed instead: it works directly from the vault on disk.

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

**Vault on disk.** Point the server at a folder that is your vault root. Easiest for a first run: set `VAULT_PATH` to an absolute path. Alternatively, leave it unset and use Obsidian’s `obsidian.json` discovery (see [Vault path](#vault-path)).

```bash
git clone https://github.com/nweii/obsidian-remote-mcp.git
cd obsidian-remote-mcp
bun install
export VAULT_PATH=/absolute/path/to/your/vault
export MCP_CLIENT_ID=dev
bun run src/server.ts
```

`bun start` runs the same entrypoint (`package.json` maps it to `bun run src/server.ts`).

The process listens on port `3456` by default (`PORT` overrides). The MCP endpoint is `POST /mcp` on that port; OAuth metadata is served under `/.well-known/oauth-authorization-server`.

**Using a remote MCP client (e.g. Claude).** OAuth and connector URLs expect HTTPS and a public origin you control. Set `MCP_BASE_URL` to that site URL without the `/mcp` path, terminate TLS in front of the app, and follow [Exposing it remotely](#exposing-it-remotely). For the full variable reference, see [Configuration](#configuration).

## Running with Docker

Use [Quick start](#quick-start) for Bun on a laptop or VM. Compose is for long-running container deploys.

Minimal Docker Compose example:

```yaml
services:
  obsidian-remote-mcp:
    image: oven/bun:1
    working_dir: /app
    restart: unless-stopped
    environment:
      MCP_CLIENT_ID: ${MCP_CLIENT_ID}
      MCP_CLIENT_SECRET: ${MCP_CLIENT_SECRET}
      MCP_BASE_URL: https://mcp.example.com
      VAULT_PATH: /vault
      CORS_ALLOWED_ORIGINS: https://claude.ai
      PORT: 3456
    volumes:
      - ./:/app
      - /path/to/your/vault:/vault
    command: ["bun", "run", "src/server.ts"]
    ports:
      - "3456:3456"
```

On my Synology NAS, I use my [`ghcr.io/nweii/debian-node-bun:latest`](https://github.com/nweii/debian-node-bun) image as a base.

## Exposing it remotely

Remote MCP clients (and OAuth) expect **HTTPS** and a **public origin** you control.

A common setup is:

1. Run the server on a host you control—for example with Bun directly, in a Docker container, or under a process manager
2. Put a reverse proxy in front of it
3. Expose it on a public HTTPS origin such as `https://mcp.example.com`
4. Set `MCP_BASE_URL` to that same origin, without `/mcp`

If you use Cloudflare Zero Trust, be careful where you place it. A practical setup is to put the identity gate only in front of `/authorize`, so adding the connector still requires a real login but `/.well-known/*`, `/oauth/token`, and `/mcp` remain reachable for the OAuth and MCP request flow.

On a Claude Pro plan, the connector setup is:

1. Add a remote connector pointing at your MCP URL, for example `https://mcp.example.com/mcp`.
2. Under advanced settings, provide an OAuth client ID. Any stable identifier is fine as long as it matches `MCP_CLIENT_ID` on the server.
3. Optionally provide an OAuth client secret. Any generated secret, token, or password is fine, but if you set one in Claude it must match `MCP_CLIENT_SECRET` on the server.
4. Set `MCP_BASE_URL` to the same origin as the connector URL, without `/mcp`.

How tokens and optional fixed secrets work is covered in [Authentication](#authentication). Browser **origin** allowlisting is covered in [CORS](#cors).

## Configuration

Set options via environment variables. [Vault path](#vault-path), [Vault context note](#vault-context-note), [Daily note paths](#daily-note-paths), [Authentication](#authentication), and [CORS](#cors) expand on the entries below.

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

## Vault path

The server resolves the vault root in this order:

1. `VAULT_PATH`, if set
2. `.config/obsidian/obsidian.json`, found by walking up from the current working directory or from the package directory

If `obsidian.json` contains multiple vaults, set `OBSIDIAN_VAULT_ID` to the vault entry you want to use.

The display name used in the OAuth approval page defaults to the resolved vault directory name. You can override that with `VAULT_DISPLAY_NAME`.

### Headless / no Obsidian installed

If you are running on a headless server or in a container without Obsidian installed, you can still use the automatic vault discovery by creating the Obsidian config file yourself.

1. Create the config directory:

```bash
mkdir -p ~/.config/obsidian
```

1. Create `~/.config/obsidian/obsidian.json`:

```json
{
  "vaults": {
    "personal": {
      "path": "/home/user/vaults/personal"
    }
  }
}
```

With multiple vaults:

```json
{
  "vaults": {
    "personal": {
      "path": "/home/user/vaults/personal"
    },
    "work": {
      "path": "/home/user/vaults/work"
    }
  }
}
```

In that case, set `OBSIDIAN_VAULT_ID=work` or whichever entry you want the server to use.

Use absolute paths. Do not rely on `~` expansion inside `obsidian.json`.

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

## Authentication

This section is about **who may call `/mcp`**. Public URL and TLS come first—see [Exposing it remotely](#exposing-it-remotely). All related env vars are listed in [Configuration](#configuration).

### OAuth (browser clients such as Claude)

The server uses **OAuth 2.1** authorization code + **PKCE**. The client opens your approval page, then exchanges a short-lived code for an access token at `POST /oauth/token`.

- **`MCP_CLIENT_ID`** is required (any stable string, often provided by the client app).
- **`MCP_CLIENT_SECRET`** is optional to configure. If you set it on the server, clients must send the same `client_secret` during token exchange. If you leave it unset, PKCE-only clients can sign in without one.

By default the server allows Claude’s OAuth callback URI. To allow other clients, set **`MCP_ALLOWED_REDIRECT_URIS`** to a comma-separated list.

### Access tokens on disk

After a successful browser login, the server saves access tokens under **`TOKEN_STORE_PATH`** (default `./tokens.json`) so clients stay signed in across restarts. To use another path:

```env
TOKEN_STORE_PATH=/data/tokens.json
```

### Fixed bearer token (Antigravity, scripts, non-browser clients)

There are **two ways** to prove access to `/mcp`:

1. **OAuth (above)** — After you approve in the browser, the server stores a token in `tokens.json`. The client sends that token on later `/mcp` requests. Browser clients usually do this for you.

2. **Shared secret** — Set **`MCP_STATIC_BEARER_TOKEN`** in your environment (e.g. Portainer) to a long random string. Any client that sends `Authorization: Bearer <that exact string>` to `/mcp` is allowed. Use this when the client cannot run the browser login.

You can use both at once. Use **HTTPS** so bearer values are not sent in clear text.

- `MCP_CLIENT_SECRET` is used only during OAuth login, at `POST /oauth/token`.
- `MCP_STATIC_BEARER_TOKEN` is the value sent later in the `Authorization` header on `/mcp`.

You may set both env vars to the same random string if you want one secret to remember.

**Antigravity / `mcp_config.json`** — when the client supports HTTP MCP directly, use **`serverUrl` + `headers`**:

```json
"obsidian-vault": {
  "serverUrl": "https://your-host/mcp",
  "headers": {
    "Authorization": "Bearer YOUR_MCP_STATIC_BEARER_TOKEN"
  }
}
```

If you must bridge over stdio, **`mcp-remote`** in one line:

```json
"obsidian-vault": {
  "command": "bunx",
  "args": ["-y", "mcp-remote", "https://your-host/mcp", "--transport", "http-only", "--header", "Authorization: Bearer YOUR_MCP_STATIC_BEARER_TOKEN"]
}
```

## CORS

`CORS_ALLOWED_ORIGINS` controls which **browser origins** may call the API from JavaScript. It is separate from OAuth and from `MCP_STATIC_BEARER_TOKEN`.

By default the server sends `Access-Control-Allow-Origin: *`. To restrict:

```env
CORS_ALLOWED_ORIGINS=https://claude.ai
CORS_ALLOWED_ORIGINS=https://claude.ai,http://localhost:3000
```

When set, only matching origins get reflected `Access-Control-Allow-Origin`; other browser preflights are rejected.

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
