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
  vault.ts        — Vault filesystem operations, path policy, search and link indices, vault discovery, config-derived defaults
  tools.ts        — MCP tool definitions; converts vault errors into tool results
  frontmatter.ts  — Frontmatter parsing and the textual key splice
  ignore.ts       — Compiles .mcpignore literal/glob rules with case and Unicode normalization
  lock.ts         — Per-path async mutex for read-modify-write
  clip.ts         — Registers vault_clip_url when the optional web-clipper-headless is installed
  log.ts          — Configures the kit's audit logger and its redaction
  date.ts         — Local-timezone date helpers for periodic notes (parsing, ISO weeks, period buckets)
scripts/          — setup-clipper.ts builds the optional clipper from the root lockfile
test/             — One file per area; vault-policy-matrix.test.ts covers every vault export against hostile paths
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
- Tool behaviour (context note, periodic notes, frontmatter search, batch tools): [docs/tools.md](docs/tools.md).
- Server setup, OAuth, origins, environment variables: [docs/server.md](docs/server.md).
- Audit log contents and redaction: [docs/audit-logging.md](docs/audit-logging.md).
- Reviewing a diff: apply [CODING_STANDARDS.md](CODING_STANDARDS.md).

## Install policy

`bunfig.toml` gates installs. Don't remove it.

- New package versions younger than 3 days aren't eligible — defends against malicious-publish supply-chain attacks (the May 2026 npm incident and its family).
- `frozenLockfile = true` — commit `bun.lock`. The setting overrides the `--no-frozen-lockfile` flag, so adding a dependency means setting it to `false` for that one install and restoring it.
- `exact = true` — `bun add <pkg>` saves the version without a caret.

- Release-age gating covers registry packages only. Git dependencies (`mcp-server-kit`, `web-clipper-headless`, and transitive `obsidian-clipper`) must keep reviewed lockfile commits; updating them requires source review, not just a version bump.
- `bun install --frozen-lockfile --omit=optional` supports core-only installations. `bun run setup:clipper` builds optional clipping from the root lockfile without nested installs; rebuild after dependency changes. Keep `scripts/bootstrap-clipper.sh` routed through that command.
- After security dependency updates, run `bun audit`, the full suite, and a clipper build/render smoke test if its dependencies changed. Preserve the release-age gate when deliberately regenerating the lockfile.
