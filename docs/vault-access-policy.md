# Vault access policy

[Tools](tools.md#vault-access-and-tool-defaults) · [Note writes](writes.md)

## Shared path checks

`policySnapshot().check` in `src/vault.ts` decides whether an entry's requested and resolved filesystem paths are allowed. Reads use `resolveSafePath`, writes use `resolveWritePath`, bulk scans use `walkVaultFiles`, and folder moves and trash check every descendant through `checkFileMove`.

Route new filesystem operations through those functions. Add rules in `check` so they apply to every operation.

Each operation reads `.mcpignore` once. A single-path check takes a fresh snapshot; walks and folder operations share one snapshot for all their entries. Policy edits apply to the next call.

### Vault boundaries

Both the requested and resolved paths must stay inside the vault and comply with `.mcpignore`. Dangling symlinks are refused. Walks through a shortcut folder check the resolved descendants too.

Internal `.trash` destinations must remain inside the vault and cannot modify the policy file, even when `.trash` is ignored.

`.obsidian` and `.git` are always blocked at any depth, before `.mcpignore` is checked. Other hidden files, including `.trash`, remain accessible by explicit path unless a rule excludes them. Ordinary searches and listings skip hidden entries.

## Folder moves and trash

`vault_move` and `vault_trash` validate the complete subtree, including hidden entries, and every mapped destination before moving anything. A protected descendant, symlink, or special file rejects the whole folder operation. Folder tool paths use trailing slashes.

Folder moves scan rewrite targets once and include references inside the moved folder. Bare filenames in links stay unchanged when the move preserves the filename.

`moveWithReferences` holds both endpoint locks while it plans and renames. Ancestor and descendant lock conflicts make folder renames wait for pending writes inside them. Calling `planReferenceRewrite` and `moveFile` separately does not provide that guarantee.

## .mcpignore rules

`src/ignore.ts` compiles one vault-relative rule per line using Bun's glob matcher. Blank lines and lines starting with `#` are ignored. See [rule examples](tools.md#exclude-paths-with-mcpignore).

- A literal path blocks itself and every descendant.
- `*` and `?` match within one path segment. A whole `**` segment spans zero or more directories.
- `.*/` blocks hidden entries at the root. `**/.*` blocks hidden entries and their descendants at any depth.
- Leading `/` or `./` and trailing slashes are optional. A trailing slash does not restrict a rule to directories.
- Matching ignores case and NFC-normalizes Unicode across filesystems.
- Negation, brace expansion, and character classes are unsupported. Their syntax is treated literally.

The policy file is reread for each operation because metadata can miss a same-length rewrite. Changed contents invalidate cached title and link results. An unavailable vault, unreadable policy, or dangling policy symlink causes access to be refused.

### Policy-file protection

Only the owner can change `.mcpignore` directly. All mutation helpers reject its requested and resolved paths, hardlink aliases, and containing directories. Reads remain allowed unless the rules exclude them.

Hidden guidance files outside `.obsidian` and `.git` remain accessible by explicit path unless excluded.

## Read-only permissions

Writes are refused when `VAULT_READ_ONLY=true` or the connection lacks `vault:write`. `readOnlyReason()` in `src/access.ts` checks both conditions. Every write calls `assertWritable` at entry.

The kit's request-scoped `currentCaller()` identifies the connection. Outside a request, including startup and direct test calls, only `VAULT_READ_ONLY` applies.

## File traversal

Every search, index, and scan in `vault.ts` uses `walkVaultFiles`. It skips hidden entries and symlinks and checks each entry against the policy.

## Internal configuration reads

`src/periodic.ts` reads plugin settings from `.obsidian` or `OBSIDIAN_CONFIG_DIR` outside the path policy. The `.obsidian` folder remains blocked from MCP tools. The derived note path passes through normal access checks.

`scanVaultForSettings` in `src/clip.ts` also walks outside the policy. This lets the clipper use an owner-hidden settings file that contains interpreter API keys. Agents cannot read the settings file through that scan.

## Obsidian CLI

The Obsidian CLI does not enforce this server's path policy. `src/cli.ts` checks path-like parameters with `resolveSafeWritePath`, including protection against changing `.mcpignore`.

`file=` is resolved by the server and rewritten to an exact `path=` so Obsidian's name resolution cannot select a protected note. Commands that may write cannot target a folder through `path`, since that would leave descendants unchecked.

Command output and implicit targets, such as `daily:append` and task references, cannot be filtered. CLI tools stay disabled while `.mcpignore` has rules unless `OBSIDIAN_CLI_MCPIGNORE_ACK=true` accepts this limitation. Backlinks are filtered per result and need no acknowledgment.

## Policy coverage

`test/vault-policy-matrix.test.ts` checks every exported `vault.ts` function against ignored paths, case variants, traversal, internal folders, symlink aliases, escapes, dangling links, the policy file, and folders containing hidden notes.

Every export must be covered or listed as taking no vault path. Add new operations to the matrix. The tests also run every write as a read-only connection and use a fake CLI binary to verify refusals happen before a process starts.
