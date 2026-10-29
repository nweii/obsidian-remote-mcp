# Tools

[README](../README.md) · [Setup](setup.md) · [Authentication and vault settings](configuration.md)

## Available tools

| Tool | Description |
|------|-------------|
| `vault_context` | Read the vault guidance note configured by `VAULT_CONTEXT_PATH`, or fall back to `AGENTS.md` / `CLAUDE.md`, and return a folder map for orientation |
| `vault_read` | Full note text (`mode` full, default) with a version for safe updates, or list one folder level (`mode` `list`; `path` `""` = vault root) |
| `vault_batch_read` | Read several notes in one call by path or title; `include_content: false` returns just frontmatter to inspect metadata before reading note bodies |
| `vault_outline` | All `#` headings in a note (one per line); use before `vault_read_section` |
| `vault_read_section` | Body under a single heading (`heading` = text without `#`, case-insensitive) |
| `vault_read_attachment` | Read a binary attachment by path; images return a renderable image block, other types return base64 with MIME type and size; `stat_only` checks size first (read-only) |
| `vault_frontmatter` | Read YAML frontmatter from a note; optional `property` for a single key |
| `vault_links` | Read outgoing wikilinks and optional backlinks (answered by Obsidian when the CLI tools are on) |
| `vault_create` | Create a new note |
| `vault_update` | Replace a note's full contents; optional `base_version` rejects stale writes |
| `vault_set_frontmatter_property` | Set one frontmatter property without rewriting the note body |
| `vault_batch_frontmatter_update` | Set frontmatter properties on several notes in one call |
| `vault_edit` | Append, prepend, or replace exact text within a note |
| `vault_edit_section` | Append, prepend, or replace the body under one heading |
| `vault_trash` | Move a file or folder to `.trash` |
| `vault_move` | Move or rename a vault file or validated folder by explicit path and rewrite the wikilinks that point at it; defaults to a dry run that shows the plan and writes nothing |
| `vault_search_title` | Find notes by filename (partial or exact); returns paths for `vault_read` |
| `vault_search_content` | Regex search in note bodies; optional `folder` to scope large vaults |
| `vault_search_frontmatter` | Find notes by a frontmatter property (match type `exact`, `contains`, or `exists`) |
| `vault_tags` | List all tags with note counts, or note paths for one `tag`; counts frontmatter and inline `#tag` |
| `vault_periodic_note` | Read or create a daily, weekly, monthly, quarterly, or yearly note at the path the vault's Obsidian config or an env template sets |
| `vault_clip_url` | Save a web page to the vault as a markdown note |
| `vault_skim` | Return only the parts of selected notes relevant to a goal, judged chunk by chunk by an external decision model; plans first and sends nothing until confirmed. Listed only when a decision-model key is set (see [Skimming notes](tools.md#skimming-notes)) |
| `vault_semantic_search` | Search notes by meaning through a local [QMD](https://github.com/tobi/qmd) index, combining keyword and vector retrieval. Listed only when `QMD_URL` and `QMD_COLLECTION` are set (see [Semantic search with QMD](tools.md#semantic-search-with-qmd)) |
| `vault_cli_help` / `vault_cli` | List and run Obsidian CLI commands against this vault. Opt-in, and listed only when the CLI reaches this vault (see [Obsidian CLI tools](tools.md#obsidian-cli-tools)) |
| `vault_feedback` | Log a structured note when an agent gets stuck or wants a tool that doesn't exist |

## URL clipping

`vault_clip_url` fetches a public web page and renders it with an Obsidian Web Clipper template. Install the [optional clipping integration](setup.md#install-optional-url-clipping) first. Pages that require a website login may not extract.

Set `WEB_CLIPPER_SETTINGS_PATH` to a Web Clipper settings export. Without an explicit path, the server uses the newest `obsidian-web-clipper-settings*.json` within four folder levels of the vault root. In Docker, the path must be mounted into the container.

The settings export can contain model-provider API keys. Use `.mcpignore` to hide a vault-local export from file tools. The clipping integration can still read its settings internally.

The tool returns Markdown for the calling agent to save with `vault_create`. Set `save: true` to save a fully rendered note directly. This does not overwrite an existing note.

`use_server_interpreter` defaults to `false`. Unresolved template prompts return `needs_interpretation` for the calling agent to fill through `slot_overrides`. Setting `use_server_interpreter: true` sends page content to the model provider configured in the Web Clipper settings.

## Skimming notes

`vault_skim` returns the passages relevant to a goal. It splits notes into roughly 2,000-character chunks with overlap, then asks a decision model which chunks are relevant. Returned passages include `path:start-end` citations for follow-up reads with `vault_read`.

Select notes with `paths` (paths or titles), a regex `query` optionally limited to a `folder`, or a `folder` alone. `max_notes` defaults to 20.

Decision models return a probability rather than generated text. Choose a provider with `DECISION_PROVIDER`.

| Provider | Key | Default model |
| --- | --- | --- |
| `typesafe` (default) | `TYPESAFE_API_KEY` | `jev-latest` |
| `openrouter` | `OPENROUTER_API_KEY` | `typesafe/jev-1.13` |
| `openai` | `OPENAI_API_KEY` | `gpt-6-luna` |

`DECISION_MODEL` overrides the model. Without the chosen provider's key, `vault_skim` is not listed. `SKIM_PROVIDER` and `SKIM_MODEL` remain supported aliases. See [decision-model settings](server.md#decision-models) for precedence and migration details.

The tool requires approval before sending note text to the model provider.

1. Call without `confirm` to get a plan. The plan lists the goal, selection method, notes and chunk counts, withheld notes and reasons, and the provider and model. No note text is sent to the provider.
2. Show the plan to the user. After approval, call again with the same arguments and `confirm` set to the returned `planId`.

If the goal, provider, model, or any planned note changes, confirmation fails and the tool returns a fresh plan. A call can send at most 500 chunks.

### Exclusions

Exclusions apply together. A call can add exclusions but cannot override the server's rules.

- `.mcpignore` blocks matching paths from the vault file tools.
- `SKIM_EXCLUDE_TAGS` and `SKIM_EXCLUDE_PATHS` apply to every skim call.
- `exclude_tags` and `exclude_paths` add exclusions for one call.

Use comma-separated tags and paths for the server settings. `private` matches only `#private`. `work/*` matches `#work` and all nested tags. Tags are read from frontmatter and inline `#tag`.

Path rules use [`.mcpignore` syntax](#exclude-paths-with-mcpignore) and cover each matching path and its contents. For example, `**/Private` excludes every `Private` folder.

Path exclusions are checked against normalized requested paths and resolved file locations before note text is read, including during query selection. Equivalent spellings and symlinks cannot bypass an excluded folder. Plans list allowed aliases once, using the resolved vault-relative path. A path-excluded note in a query's scope is reported as withheld without reading it to test the query.

A chunk the model couldn't judge (a failed request, a malformed answer) is kept and marked `unjudged`, so a provider failure can return more text than expected but never silently drops any.

## Semantic search with QMD

`vault_semantic_search` searches the vault through a [QMD](https://github.com/tobi/qmd) index that runs on the same machine as the server. QMD combines keyword (BM25) and vector retrieval and reranks the results with a local model. Each call takes typed sub-queries: `lex` for keywords, `vec` for a natural-language question, and `hyde` for a short passage that reads like the answer.

To enable it, run QMD's HTTP server (`qmd mcp --http`, on `localhost:8181` by default) and set `QMD_URL` to its address and `QMD_COLLECTION` to the QMD collection that indexes this vault. The server searches only that collection, so other collections on the same QMD index stay out of reach.

QMD reports each result by its path in the collection: the note's own path in current releases, or a normalized form, which several vault paths can share, in QMD 2.5 and earlier. The server maps every result back to the notes at that path that the vault access policy allows reading, and returns the result only when one of them holds the content QMD indexed (QMD's docid is a prefix of the content's SHA-256). The lines shown with each result are read from that note, never taken from QMD's snippet or title, so a note the policy hides can't surface through a shared path and docid. Results from hidden files, `.mcpignore` matches, and notes that no longer exist are dropped without a count, because QMD indexes those notes too and a count would tell a client whether a hidden note contains the searched words. Those dropped results still use up part of `limit`, so a search can return fewer results than asked for. Results from readable notes changed since QMD last indexed them are skipped, and the result reports how many. Keep QMD's index current so recent edits stay searchable. QMD's own index and server have no access control, so keep QMD bound to localhost.

## Obsidian CLI tools

On a computer running Obsidian desktop installer 1.12.7 or later with its command-line interface enabled, agents can query Bases, work with tasks, and use file history, Sync, bookmarks, and unresolved links.

`vault_cli_help` lists commands from `obsidian help`. `vault_cli` runs a command with `params` for key-value arguments and `flags` for arguments without values. CLI commands added by Obsidian can work without a server update, subject to the safety guards below.

Set `OBSIDIAN_CLI_ENABLED=true` to enable these tools. They appear only if the server finds the `obsidian` binary on `PATH` or at `OBSIDIAN_CLI_PATH`, and the CLI reports the same vault folder as the server.

The server passes the vault folder's name as `vault=`. Set `OBSIDIAN_CLI_VAULT` if Obsidian uses a different name. If the app stops answering, the next failed call rechecks availability and reports the problem.

The CLI tools can create, edit, move, and delete notes, and add or remove notes on your Obsidian Publish site. When you [approve a connection](configuration.md#choosing-what-each-connection-can-do), clear **Control the Obsidian app** to deny CLI access. Clear **Edit notes** to limit the connection to commands that read. `VAULT_READ_ONLY` limits every connection to reading.

The server log reports whether the CLI tools are available. If they are unavailable, the log gives the reason.

### Safety guards

Obsidian CLI searches, task lists, and Bases can return results from the whole vault. The server cannot filter those results through `.mcpignore`. Commands that choose their own target, such as `daily:append`, task references, and templates, also bypass these path checks.

If `.mcpignore` has rules, the CLI tools stay disabled unless you set `OBSIDIAN_CLI_MCPIGNORE_ACK=true` to accept this limitation. `.obsidian` and `.git` remain protected because Obsidian does not index them.

<details>
<summary>Command and parameter restrictions</summary>

- Commands always target the server's vault. A `vault` parameter or flag is refused.
- Parameter keys and flags are letters and hyphens starting lowercase (`paneType` is fine). Keys the guards check (`vault`, `path`, `to`, `folder`, `file`, `name`, `id`) must be lowercase. Each becomes one argument. Commands do not run through a shell.
- `eval`, `devtools`, `restart`, `reload`, `plugins:restrict`, `theme:install`, `vault` and `vaults` (which report host paths), and every `dev:`, `plugin:` and `snippet:` command are always blocked. No setting unblocks them.
- Command-palette execution (`command id=…`) is off unless `OBSIDIAN_CLI_COMMANDS` lists the allowed IDs. `*` allows every ID except those that look destructive (delete, remove, purge, trash and similar); those run only when listed by name.
- With `VAULT_READ_ONLY=true`, and for a connection approved without "Edit notes", only commands on a known-read list run, so a command added by a future CLI release is refused until it is reviewed.
- `path`, `to` and `folder` go through the same path checks as every other tool, and `file` (a note name) is resolved by the server and passed as an exact `path`. A protected location gets the same "Not found" answer a missing note does. `name` can't contain a slash.
- Commands that may write cannot target a folder through `path`. Use `vault_move` or `vault_trash` for folders.
- Calls are audit-logged with the command, parameter names and flags. Parameter values stay out of the logged arguments, though an error message can name the path or command ID it refused.

`*` also covers community-plugin commands, including plugins that run scripts such as Templater and Shell commands. List specific IDs to limit this access.

</details>

### Backlinks

When the CLI is available, `vault_links` uses Obsidian's backlink results, including its alias, relative-link, and path-link resolution. The server filters these results through its access policy, so `.mcpignore` rules apply and no acknowledgment is needed.

If the CLI call fails or returns unparseable output, `vault_links` uses the server's text search. The result's `backlinks_source` identifies which method returned the backlinks.

## Vault edits

The server edits the same files Obsidian and Obsidian Sync are using.

- Each write goes to a temporary file that is renamed into place. Obsidian, Sync, or other tools never read a half-written or empty note, even if the process stops mid-write.
- Writes to one note run one at a time. `vault_read` returns a version string; passing it to `vault_update` as `base_version` makes the update fail if the note changed since you read it, instead of overwriting the other edit.

## Vault access and tool defaults

### Path checks

Vault paths must stay inside the vault and pass access checks both as requested and after resolving filesystem shortcuts (symlinks). Dangling shortcuts are refused. Searches through shortcut folders check the resolved descendants too.

Internal trash destinations must also remain inside the vault. See the [vault access policy](vault-access-policy.md) for implementation details.

### Exclude paths with .mcpignore

Create `.mcpignore` in the vault root to block matching paths from file reads, edits, searches, and listings. Use one vault-relative rule per line. Blank lines and lines starting with `#` are ignored.

| Rule | Effect |
|------|--------|
| `Private` or `Private/` | Block that path and everything beneath it |
| `Notes/draft?.md` | Block a single-character match such as `Notes/draft1.md` |
| `**/*.bak` | Block `.bak` files at any depth |
| `.*/` | Block hidden entries at the vault root |
| `**/.*` | Block hidden entries and their contents at any depth |

`*` matches within one path segment. `?` matches one character. `**` as a whole segment matches zero or more directory levels.

Rules ignore case and normalize Unicode. Leading `/` or `./` and trailing slashes are optional. A trailing slash does not restrict a rule to directories. Brackets and braces are literal, and `!` cannot re-include a path.

Policy edits take effect on the next call, including cached title and link results. An unavailable vault or unreadable policy causes access to be refused.

You manage `.mcpignore` directly. Agents may read it when the rules allow, but cannot create, edit, delete, or move it through MCP, including through aliases.

### Hidden files

`.obsidian` and `.git` are always blocked at any depth. They contain app settings, plugin data that may include API keys, and version history.

Other hidden entries are omitted from searches and listings. Explicit paths, such as `VAULT_CONTEXT_PATH=.claude/CLAUDE.md`, remain accessible unless `.mcpignore` blocks them.

`.trash` remains readable by explicit path so agents can read or restore trashed notes. Add `.trash` to `.mcpignore` to hide it. Trashing still works when it is hidden.

### Read-only connections

`VAULT_READ_ONLY=true` blocks writes for every connection. A connection approved without **Edit notes** has the same restriction for its own calls.

Write-only tools are omitted from the tool list. `vault_periodic_note`, `vault_clip_url`, and `vault_move` remain listed because they can read or plan without writing. They refuse calls that would write. A move defaults to a dry run.

### Search and tag limits

| Tool | Default limit | Unlimited results |
|------|---------------|-------------------|
| `vault_search_title` | 50 | Set `limit=0` |
| `vault_search_content` | 20 | Set `limit=0` |
| `vault_tags` | 100 tags | Pass one `tag` to return all matching note paths |

Tag counts ignore case and display the first spelling encountered. Nested tags match exactly. `parent` does not include `parent/child`.

## Moving and trashing files and folders

`vault_move` moves or renames a vault file or folder. Use explicit vault-relative paths. Include the extension for files. For folders, use trailing slashes, such as `Projects/` and `Archive/Projects/`. Use `vault_search_title` to find a file's path before moving it.

`dry_run` defaults to `true`. The tool checks the move and returns a plan without moving anything or creating directories. The plan includes link changes, ambiguous links it would skip, and `.base` files that need review. Set `dry_run: false` to move the file or folder, then apply the link changes.

If a link rewrite fails after the move, the moved item stays at its new path. The response lists files whose links need manual repair.

Folder moves and trash operations check every entry, including hidden entries, and every destination before moving anything. A protected entry, symlink, or special file rejects the whole folder operation. Use the real source path without symlinked parent folders. See [Vault access policy](vault-access-policy.md) for the complete checks.

### Link updates

- Moves rewrite path-qualified wikilinks in note bodies and frontmatter, plus `.canvas` file paths. Folder moves include references inside the moved folder.
- A move that keeps the filename leaves bare links such as `[[Name]]` unchanged. A rename updates bare links too, unless another file shares the old name. Ambiguous links are skipped with a warning.
- Rewrites preserve aliases, headings, block references, embeds, and explicit extensions. They handle combinations such as `![[folder/Note#Heading|alias]]`.
- Links inside code blocks and inline code stay unchanged. Relative links starting with `./` or `../`, and standard Markdown links, need manual review.
- `.base` files are never edited. References to the old name or path are reported for review. Notes blocked by `.mcpignore` are neither scanned nor modified.

`vault_trash` moves files or folders to `.trash` without rewriting links.

## Implementation notes

<details>
<summary>Tool internals and limits</summary>

### Vault context

`vault_context` appends a folder-only tree to the [guidance note](configuration.md#vault-context-note). `max_depth` defaults to 3. Set it to 0 to omit the tree. The tree honors `.mcpignore` and skips hidden folders.

Subtrees are walked in parallel. If building the tree exceeds 1.5 seconds, the tool returns the guidance note without it.

### Periodic notes

`src/periodic.ts` resolves note paths and translates Obsidian date formats. See [periodic note paths](configuration.md#periodic-note-paths) for precedence, tokens, plugin layouts, and week numbering.

### Frontmatter search

`vault_search_frontmatter` takes a `match_type` of `exact`, `contains`, or `exists`. `contains` ignores case. `exists` checks whether a property is present and ignores its value.

List-valued properties are matched per element. For example, `exact: draft` matches `tags: [draft, idea]`.

An unquoted ISO date parsed by js-yaml as a `Date` is matched by its UTC `YYYY-MM-DD` date. Other date conventions stay strings and match verbatim.

The search walks notes and parses frontmatter for each request. Searches and indices share `walkVaultFiles`, which applies the [vault access policy](vault-access-policy.md) and reads `.md` files by default.

### Batch operations

`vault_batch_read` resolves paths and titles like `vault_read`. Unresolved entries appear under `missing` without failing the other reads. Set `include_content: false` to return only frontmatter.

`vault_batch_frontmatter_update` applies each note's fields in one locked read-modify-write through `setFrontmatterProperties`. `setFrontmatterProperty` delegates to the same function.

Both batch tools accept at most 50 entries. They are not transactions. One failed item does not roll back successful items or stop the rest.

### Skim plans and provider requests

In addition to sending requested notes to connected clients, `vault_skim` can send selected text to a model provider. Its `planId` hashes the goal, provider, model, and each planned note's `versionOf`.

The calling agent must show the plan and obtain approval. The hash checks that the arguments and note contents still match. It does not verify human consent.

Path exclusions use `ignore.ts`. Tag exclusions use `getNoteTags`, which reads frontmatter and inline tags. See [skimming notes](#skimming-notes) for selection, exclusions, and confirmation.

`decision.ts` uses System One `noul` questions for TypeSafe and OpenRouter, and named `predicate` questions for OpenAI. It splits a batch if the provider reports a question-count limit.

### CLI execution

`src/cli.ts` invokes the first-party `obsidian` CLI with an argument array, a 30-second timeout, and a 10 MB output cap. Leading app-update lines are removed from the output. Backlink calls have a 5-second timeout.

The availability probe runs `obsidian vault=<name> vault info=path` and checks that the returned path matches the server's vault. A successful probe is cached for 5 minutes or until a call fails. Failed probes are retried after 30 seconds.

A failed call probes again so a closed or unreachable app is reported as unavailable. Errors place CLI output in a second content block, outside the audit log.

Guards run before a process starts, in this order.

1. The connection's `vault:cli` permission.
2. The command name format and fixed block list.
3. The known-read list for read-only connections.
4. The command-palette allowlist.
5. Parameter and flag names.
6. The path policy.

`path`, `to`, and `folder` use `resolveSafeWritePath`. `file` is resolved through `resolveNoteReference` and rewritten to an exact `path`. Read commands may target the vault root. Commands that may write cannot use a folder in `path`, since its descendants would go unchecked.

When a command fails and its path does not exist, it returns the same `Not found` response as a protected path. The help listing applies the same command checks as execution.

### Backlink resolution

`resolveBacklinks` uses Obsidian's `backlinks format=json` when available and checks each result with `resolveSafePath`. Otherwise it uses `getBacklinks`, the server's `[[title` content search. `backlinks_source` reports `obsidian` or `server`.

### Tool errors

`registerVaultTool` converts `VaultError` exceptions into `isError` results. Ambiguous headings include candidate previews in a second content block. Other exceptions propagate to the SDK and are logged with their messages.

</details>

## Performance checks

Run the optional folder-operation performance checks with `VAULT_MCP_TEST=1 VAULT_FOLDER_BENCH=1 bun test test/vault-folder-operations.test.ts`. They report timings and verify one content read per rewrite candidate; they do not impose machine-dependent timing thresholds.
