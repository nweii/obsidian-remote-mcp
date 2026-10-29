# obsidian-remote-mcp

Remote MCP server exposing an Obsidian vault over HTTP with OAuth 2.1 (authorization code + PKCE).

References:
- MCP specification: [modelcontextprotocol.io/specification](https://modelcontextprotocol.io/specification)
- Claude Code MCP docs for server authors: [code.claude.com/docs/en/mcp#for-mcp-server-authors](https://code.claude.com/docs/en/mcp#for-mcp-server-authors)

## Stack

- **Runtime**: Bun (TypeScript, no build step)
- **Transport**: Streamable HTTP (MCP spec)
- **Auth**: OAuth 2.1 authorization code + PKCE (browser flow for Claude.ai)
- **Scaffolding**: [`mcp-server-kit`](https://github.com/nweii/mcp-server-kit) (git dependency) supplies the app factory (CORS, request logging, the bearer-gated `/health`, the `/mcp` mount), the Claude-facing OAuth module (`createAuth`, SDK-backed), the tool-result helpers, the audit-logging module, and process/shutdown helpers. The OAuth wire surface (discovery, endpoint paths, error shapes) is whatever the MCP SDK emits — notably the token endpoint is `/token`.
- **Deployment**: Docker container on a server or NAS

## File structure

```
src/
  server.ts       — Builds the app via createApp() and starts it with the kit's startServer (persists tokens on shutdown)
  app.ts          — createApp(): maps env vars to the kit's createAuth / createApp, guards /mcp origins, registers the vault tools
  vault.ts        — Vault filesystem operations, path policy, search and link indices, vault discovery
  periodic.ts     — Periodic note paths from env templates or the vault's Obsidian config (moment format translation)
  tools.ts        — MCP tool definitions; converts vault errors into tool results
  frontmatter.ts  — Frontmatter parsing and the textual key splice
  ignore.ts       — Compiles .mcpignore literal/glob rules with case and Unicode normalization
  lock.ts         — Per-path async mutex for read-modify-write
  access.ts       — Per-connection access: the approval page's scopes (edit notes, Obsidian CLI) and whether the current request's connection holds one
  clip.ts         — Registers vault_clip_url when the optional web-clipper-headless is installed
  cli.ts          — Registers vault_cli / vault_cli_help when the obsidian CLI is opted in and reaches this vault: guards, probe, help parsing; backlinks via Obsidian
  qmd.ts          — Registers vault_search_semantic when a local QMD server is configured: forwards queries, maps QMD paths back to vault paths, withholds what the access policy hides
  skim.ts         — Registers vault_skim when a decision-model key is set: note selection, exclusions, plan ids, rendering
  chunk.ts        — Line-aware chunker with overlap used by vault_skim
  decision.ts     — Decision-model client (TypeSafe, OpenRouter, OpenAI): provider resolution, request shapes, batching, retries
  log.ts          — Configures the kit's audit logger and its redaction
  date.ts         — Local-timezone date helpers for periodic notes (parsing, ISO weeks, period buckets)
scripts/          — setup-clipper.ts builds the optional clipper from the root lockfile
test/             — One file per area; vault-policy-matrix.test.ts covers every vault export and the CLI tool against hostile input; fake-obsidian.ts stands in for the CLI
docs/             — Design notes, reached through the pointers below
```

## Commands

```bash
bun install                 # add --omit=optional for a core-only install
bun run setup:clipper       # build the optional clipper after install
MCP_CLIENT_ID=dev bun run src/server.ts
bun run test
bun run typecheck
bun run audit
```

CI (`.github/workflows/ci.yml`) runs install, `setup:clipper`, typecheck, tests and audit on every pull request, with `REQUIRE_CLIPPER=1` so missing clipper sources fail instead of skipping their tests.

Endpoints: OAuth discovery `GET /.well-known/oauth-authorization-server`, token `POST /token`, MCP `POST /mcp` (Bearer token; `GET /mcp` returns 405).

## Before changing code

- Path checks, `.mcpignore`, hidden folders, or anything that reads, writes or walks vault files: read [docs/vault-access-policy.md](docs/vault-access-policy.md).
- Write paths, locking, atomic writes, frontmatter or section edits: [docs/writes.md](docs/writes.md).
- Tool behaviour (context note, periodic notes and their Obsidian config, frontmatter search, batch tools): [docs/tools.md](docs/tools.md).
- Server setup, OAuth, origins, environment variables: [docs/server.md](docs/server.md).
- Audit log contents and redaction: [docs/audit-logging.md](docs/audit-logging.md).
- Reviewing a diff: apply [CODING_STANDARDS.md](CODING_STANDARDS.md).

## Adding an optional tool

An optional tool registers only when its dependency is present. Each optional tool is a module in `src/` and an entry in `OPTIONAL_TOOLS` in `tools.ts`. If one optional tool fails to register, the other tools still register.

- **Detect in the module.** If the dependency is missing, the module's `register*(server)` function won't register anything. The server registers tools on every request, so check for the dependency once, keep the result, and log it once (`clipperOnce` in `clip.ts`, `providerOnce` in `skim.ts`). If the dependency can disappear and come back, as the Obsidian app can, check again on a timer (`probeCache` in `cli.ts`).
- **Reach notes through `vault.ts`.** Select, list, and read notes with `resolveNoteReference`, `listNotePaths`, and `readNote`. These functions apply `.mcpignore` and the hidden-folder rules. If a tool gets results from an outside index, map each result back through these functions and withhold any result they don't return (`qmd.ts`). If the server can't filter a tool's output, as with Obsidian CLI searches, say so in `docs/tools.md`.
- **Respect read-only mode.** Register a tool that only writes through `registerWrite`, so read-only mode hides it. Register a tool that reads or writes depending on its arguments as usual. In read-only mode, the vault layer refuses its writes.
- **Log through `registerLogged`.** If an argument can carry note text that `REDACTED_FIELDS` in `log.ts` doesn't cover, log a summary of the arguments instead (`registerCliTool` in `cli.ts`).
- **Gate per connection.** To let a connection's approval withhold the tool, check that connection's access in `access.ts`.

There is no shared extension interface. The optional tools detect their dependencies in different ways, and `vault.ts`, `registerWrite`, `log.ts`, and `access.ts` already hold the shared rules. Add an interface if a new tool would otherwise repeat one of those rules, or if tools need a shared lifecycle beyond registration, such as startup hooks, routes, or vault-write events.

## Install policy

`bunfig.toml` gates installs. Don't remove it.

- New package versions younger than 3 days aren't eligible — defends against malicious-publish supply-chain attacks (the May 2026 npm incident and its family).
- `frozenLockfile = true` — commit `bun.lock`. The setting overrides the `--no-frozen-lockfile` flag, so adding a dependency means setting it to `false` for that one install and restoring it.
- `exact = true` — `bun add <pkg>` saves the version without a caret.

- Release-age gating covers registry packages only. Git dependencies (`mcp-server-kit`, `web-clipper-headless`, and transitive `obsidian-clipper`) must keep reviewed lockfile commits; updating them requires source review, not just a version bump.
- `bun install --frozen-lockfile --omit=optional` supports core-only installations. `bun run setup:clipper` builds optional clipping from the root lockfile without nested installs; rebuild after dependency changes. Keep `scripts/bootstrap-clipper.sh` routed through that command.
- After security dependency updates, run `bun audit`, the full suite, and a clipper build/render smoke test if its dependencies changed. Preserve the release-age gate when deliberately regenerating the lockfile.

## Pull requests

Title a PR in Conventional Commits form, `type(scope): imperative subject`, naming the symbol the change centers on. The squash merge turns the body into the commit message, so keep the body under about 40 lines. Use these sections in order, and drop any that would be empty:

- `## Why`: one to three sentences.
- `## What changed`: one to three bullets. Add a small `diff` or call-tree sketch when it explains the change better than prose.
- `## Scope`: what the change covers and what it leaves out on purpose.
- `## Tradeoffs`: only the alternatives a reviewer would ask about.
- `## Blast radius`: what the change touches, and a `Door:` line. A two-way door reverts cleanly. A one-way door does not, for example a renamed tool that prompts call by its old name.
- `## Verification`: one to three commands or live checks and what they showed.

This repository is public. Describe test setups in general terms, such as "a live QMD 2.8 instance against a real vault". Code, fixtures, commits, PRs, and issues never name a machine, hostname, network, IP address, or vault from anyone's own setup.
