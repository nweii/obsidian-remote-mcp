# Note writes

[Tools](tools.md) · [Vault access policy](vault-access-policy.md)

## Concurrent edits

Every write that reads existing content takes a per-path lock through `withPathLock` in `src/lock.ts`. This includes appends, prepends, text and section edits, frontmatter updates, full-note updates, deletion, and link rewrites. Two tool calls cannot interleave writes to the same note.

Moves and trash operations acquire both endpoint locks with `withPathsLock`. Locks also conflict with ancestor and descendant paths, so a folder move waits for writes inside it. Unrelated notes do not block one another. These locks coordinate writes within this server process. They do not lock out Obsidian, a sync client, or another server process.

`appendNote` takes a lock even though it uses `O_APPEND`. Appends are atomic relative to other appends, but can conflict with an operation that reads the note and then rewrites it.

### Version checks

`vault_read` returns a `version` hash of the note text, produced by `versionOf`. Pass it to `vault_update` as `base_version` to reject an update if the note changed or was deleted after the read.

A rejected update returns `ConcurrentEditError` and asks the caller to re-read and reapply the change. Without `base_version`, the last full-note update wins.

## Atomic file replacement

`atomicWriteFile` writes a temporary file in the same directory, calls `fsync`, then renames the temporary file over the target. Same-directory replacement is atomic on POSIX, so readers cannot see an empty or partially written replacement.

The target's file mode is preserved, and the temporary file is removed if the operation fails. This applies to creates, full-note updates, prepends, text and section edits, and link rewrites after moves.

`appendNote` uses `O_APPEND` rather than replacement because it does not truncate the existing file.

## Frontmatter formatting

`setFrontmatterProperty` and `vault_set_frontmatter_property` splice the changed key into the existing frontmatter text. Untouched keys retain their dates, quoting, order, blank lines, and comments. This avoids converting bare `YYYY-MM-DD` values into full ISO datetimes.

JSON-shaped frontmatter such as `---\n{ ... }\n---` is parsed and reserialized as YAML, matching Obsidian's handling of JSON properties.

Valid JSON-stringified arrays and objects are parsed back into structured values. Strings beginning with `[` or `{` that are not valid JSON stay unchanged.

## Duplicate headings

`editNoteSection` refuses ambiguous headings with `AmbiguousHeadingError`. The response includes each matching line number and a preview. Use `vault_edit` with text unique to the intended section instead.

`readNoteSection` returns every matching section, labeled with `<!-- match N of M (line X) -->`. This lets an agent inspect the candidates before choosing what to edit.
