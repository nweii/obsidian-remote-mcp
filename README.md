# obsidian-remote-mcp

Read and edit your Obsidian notes from Claude, ChatGPT, and other [MCP clients](https://modelcontextprotocol.io), even when you're away from your computer.

Run this self-hosted server on a NAS, a cloud server, or an always-on computer with a local copy of your vault. AI apps connect over HTTPS with browser sign-in or an API key. The core tools work directly with your Markdown files, so Obsidian doesn't need to be running.

## Features

- Ask AI to find notes, add to a journal, or update one section of a project note. Tools also support frontmatter and batches of notes.
- Use your existing daily, weekly, and other periodic note settings. Moving or renaming notes updates the wikilinks pointing to them.
- Give agents your vault's instructions and a folder map with [`vault_context`](docs/configuration.md#vault-context-note). It reads `AGENTS.md`, `CLAUDE.md`, or a guidance file you choose.
- Optionally use the [Obsidian desktop app's CLI](docs/tools.md#obsidian-cli-tools) to query Bases, work with tasks, and access other app features.
- Choose editing and Obsidian app permissions separately for each connection approved through browser sign-in. Use [`.mcpignore`](docs/tools.md#vault-access-and-tool-defaults) to exclude private folders from file tools.
- [Atomic writes](docs/tools.md#vault-edits) keep Obsidian and sync services from reading partially written notes. Optional version checks reject updates based on an outdated copy.

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

Your sync service keeps the server's local vault current. The server reads and edits those files, and your AI apps connect through the HTTPS service.

## Quick start

Run the server on a computer that has a local copy of your vault. For guided setup with a coding agent, use [SETUP-PROMPT.md](SETUP-PROMPT.md).

### 1. Run the server

With [Bun](https://bun.sh) installed, run these commands. Replace the vault path and password with your own values.

```bash
git clone https://github.com/nweii/obsidian-remote-mcp.git
cd obsidian-remote-mcp
bun install
export VAULT_PATH=/absolute/path/to/your/vault
export MCP_CLIENT_ID=my-vault-mcp
export APPROVAL_PASSWORD=pick-a-password
export HOST=127.0.0.1
bun run src/server.ts
```

The server listens on port `3456`. `MCP_CLIENT_ID` is a name you choose and enter in clients that ask for one. If you already use containers, follow the [Docker Compose setup](docs/setup.md#run-with-docker).

#### Optional vault features

- [Enable Obsidian CLI tools](docs/setup.md#use-the-obsidian-desktop-apps-cli-tools) to use app features on a computer running Obsidian.
- [Set up Obsidian Headless sync](docs/setup.md#sync-a-vault-with-obsidian-headless) to keep the server's vault current without the desktop app.

### 2. Expose it over HTTPS

Use a reverse proxy or tunneling service to give the server an HTTPS URL. It receives encrypted connections from clients and forwards them to `http://127.0.0.1:3456` on this computer.

| Service | Setup |
|---------|-------|
| [Cloudflare Tunnel](docs/setup.md#cloudflare-tunnel) | Use Cloudflare's dashboard or `cf` CLI to configure it, with `cloudflared` running locally. Requires a Cloudflare account and domain. |
| [Tailscale Funnel](docs/setup.md#tailscale) | Run a terminal command to get a public HTTPS URL. Requires a Tailscale account. |
| [Caddy](docs/setup.md#caddy) | Add a Caddyfile on a server your domain points to. Requires incoming ports `80` and `443`. |

Tailscale Serve is also available for clients inside your private Tailscale network. Cloud-hosted connectors generally need Funnel's public URL.

Keep port `3456` private so clients use the HTTPS URL. A direct connection skips your HTTPS service and its login checks. The command above sets `HOST=127.0.0.1` for this purpose; the Docker example restricts the published port instead.

Once your HTTPS service is running, stop the MCP server with **Ctrl+C**. Set its public address in the same terminal and restart it.

```bash
export MCP_BASE_URL=https://mcp.example.com
bun run src/server.ts
```

Replace the example address with your own. See [HTTPS setup](docs/setup.md#expose-it-over-https) for the full examples and optional Cloudflare Access login protection.

### 3. Connect a client

Give your client the HTTPS address with `/mcp` added, such as `https://mcp.example.com/mcp`.

Use [client setup](clients.md) for Claude, ChatGPT, Cursor, Codex, and scripts. Clients can use browser OAuth or an API key, depending on what they support.

Once connected, ask the client to read a note you know by title. To use the Obsidian CLI tools, allow **Control the Obsidian app** when approving the connection.

## Security and scope

Clients authenticate with OAuth or an API key. Browser sign-in lets you choose whether each connection can edit notes or control the Obsidian app. You can also make the whole server read-only with `VAULT_READ_ONLY=true`.

Vault file access is confined to the vault folder. `.mcpignore` blocks notes from file reads, edits, and searches. Optional [CLI access has a separate .mcpignore limitation](docs/tools.md#safety-guards) to review before enabling it.

Connected clients receive the notes they request. The optional [skim tool](docs/tools.md#finding-and-skimming-notes), enabled by setting a decision-model API key, sends note text to that model provider, except for notes under its exclusion rules. [Audit logs](docs/configuration.md#audit-log-privacy) can contain paths and search queries; use `LOG_ENABLED=false` to disable logging.

## Guides and reference

| Topic | Guide |
|-------|-------|
| Docker, desktop CLI, sync, HTTPS services | [Setup](docs/setup.md) |
| Authentication, permissions, vault conventions | [Authentication and vault settings](docs/configuration.md) |
| Environment variables, health checks, dependency updates | [Server reference](docs/server.md) |
| Available tools, file access, moves, and safety guards | [Tools](docs/tools.md) |
| Per-client connection steps | [Client setup](clients.md) |

## Similar projects

[obsidian-web-mcp](https://github.com/jimprosser/obsidian-web-mcp) is another remote MCP server for Obsidian vaults, written in Python.

## Tests

```bash
bun run test
bun run typecheck
```
