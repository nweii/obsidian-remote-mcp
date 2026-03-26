# obsidian-remote-mcp

A self-hosted [MCP](https://modelcontextprotocol.io) server for headless Obsidian vaults. It gives remote AI clients read and write access to a vault over HTTPS **without requiring the Obsidian desktop app to be running on the same machine.**

This is meant for server environments: home servers, NAS boxes, VPSes, containers, and other setups where your vault lives on disk and you want to expose it through a remote MCP endpoint for apps like Claude.ai.
`obsidian-remote-mcp` is filesystem-backed instead: it works directly from the vault on disk.

## What it includes

The server currently exposes these tools:

| Tool | Description |
|------|-------------|
| `vault_context` | Read the vault guidance note configured by `VAULT_CONTEXT_PATH`, or fall back to `AGENTS.md` / `CLAUDE.md` |
| `vault_read` | Read a note by relative path |
| `vault_frontmatter` | Read all YAML frontmatter from a note |
| `vault_frontmatter_property` | Read one frontmatter property from a note |
| `vault_outline` | Read only the headings from a note |
| `vault_read_section` | Read a single heading section from a note |
| `vault_links` | Read outgoing wikilinks and optional backlinks |
| `vault_create` | Create a new note |
| `vault_update` | Replace a note's full contents |
| `vault_set_frontmatter_property` | Set one frontmatter property without rewriting the note body |
| `vault_edit` | Append, prepend, or replace exact text within a note |
| `vault_trash` | Move a note to `.trash` |
| `vault_find` | Resolve a note title to one or more paths |
| `vault_search_content` | Regex search across note content |
| `vault_daily_note` | Read or create a daily note using a configurable path template |

## How auth works

The server uses OAuth 2.1 authorization code + PKCE.

Remote clients discover the auth endpoints, complete a browser approval flow, then exchange the authorization code for a bearer token at `POST /oauth/token`.

`MCP_CLIENT_ID` is required. `MCP_CLIENT_SECRET` is optional.

This matches clients like Claude, which may expose client ID / secret fields in the UI but can still operate as a PKCE client.

By default the server allows Claude's OAuth callback URI. If you need to support other clients or callback targets, set `MCP_ALLOWED_REDIRECT_URIS` to a comma-separated allowlist.

## Configuration

### Environment variables

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
VAULT_READ_ONLY=true                   # optional
PORT=3456
```

### Vault discovery

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

### Vault guidance note

`vault_context` is meant to help agents learn your vault structure before they start writing. By default it looks for `AGENTS.md` or `CLAUDE.md`.

If your vault uses a different bootstrap file, set `VAULT_CONTEXT_PATH` to the relative path you want the tool to read.

If you do not want to maintain one, the server still works without it.

### Daily note path template

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

### CORS

`CORS_ALLOWED_ORIGINS` is optional. By default the server responds with `Access-Control-Allow-Origin: *` so browser-based MCP clients can connect without extra setup.

If you want to narrow it, set a comma-separated allowlist:

```env
CORS_ALLOWED_ORIGINS=https://claude.ai
CORS_ALLOWED_ORIGINS=https://claude.ai,http://localhost:3000
```

When this is set, matching origins are reflected back in `Access-Control-Allow-Origin`. Disallowed browser preflight requests are rejected.

### Token persistence

Bearer tokens persist to `./tokens.json` by default so clients stay authorized across restarts.

If you want to store them elsewhere, set:

```env
TOKEN_STORE_PATH=/data/tokens.json
```

## Running locally

### Bun

```bash
bun install
MCP_CLIENT_ID=dev bun run src/server.ts
```

### Docker

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

The server must be reachable over HTTPS for remote MCP clients.

A common setup is:

1. run the container on your server
2. put a reverse proxy in front of it
3. expose it on a public HTTPS origin such as `https://mcp.example.com`
4. set `MCP_BASE_URL` to that same origin, without `/mcp`

If you use Cloudflare Zero Trust, be careful where you place it. A practical setup is to put the identity gate only in front of `/authorize`, so adding the connector still requires a real login but `/.well-known/*`, `/oauth/token`, and `/mcp` remain reachable for the OAuth and MCP request flow.

On a Claude Pro plan, the connector setup is:

1. Add a remote connector pointing at your MCP URL, for example `https://mcp.example.com/mcp`.
2. Under advanced settings, provide an OAuth client ID. Any stable identifier is fine as long as it matches `MCP_CLIENT_ID` on the server.
3. Optionally provide an OAuth client secret. Any generated secret, token, or password is fine, but if you set one in Claude it must match `MCP_CLIENT_SECRET` on the server.
4. Set `MCP_BASE_URL` to the same origin as the connector URL, without `/mcp`.

## Notes

- `GET /mcp` returns `405`, not `404`, so streamable HTTP clients know the server only accepts MCP over `POST`.
- All vault paths are validated against the resolved vault root to prevent directory traversal.
- `.mcpignore` in the vault root can block paths from all MCP access.
- `VAULT_READ_ONLY=true` blocks all write operations.
- `vault_find` defaults to `limit=50`; `vault_search_content` and backlink lookups default to `limit=20`. These are capped by default for performance, but the limits are adjustable and `0` means no limit.
- `vault_frontmatter` and `vault_set_frontmatter_property` let agents work with frontmatter properties without reading or rewriting the whole note body.
- Tokens persist to `TOKEN_STORE_PATH` (default `./tokens.json`) so clients stay authorized across restarts.

## Tests

```bash
bun test
```
