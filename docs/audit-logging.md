# Audit logging

[README](../README.md) · [Authentication and vault settings](configuration.md) · [Server reference](server.md)

## Files and controls

Logging is enabled by default. Tool calls go to `LOG_DIR/tool-calls.jsonl`; feedback goes to `LOG_DIR/feedback.jsonl`.

Set `LOG_ENABLED=false` to disable both logs and omit the `vault_feedback` tool.

Logs do not rotate automatically. Use a persistent volume for `LOG_DIR` when logs must survive container replacement. Rotate or truncate the files to limit disk usage.

## Recorded fields

Tool-call entries contain `{ ts, client, client_name?, tool, args, ok, duration_ms, error? }`.

`client` identifies the connection that made the call.

- The configured OAuth client uses `MCP_CLIENT_ID`.
- A self-registered client uses its generated client ID.
- API-key calls use `static-bearer`.

`client_name` is the name a self-registered client supplied. Treat it as a label rather than verified identity. Feedback entries carry the same client fields.

The `error` field records the message returned with an `isError` result, including any suggested next action.

## Redaction and visible metadata

Argument strings longer than 80 characters become `<str:Nchars>`. The `content`, `value`, `template`, and `find` fields always become `<redacted:Nchars>`, regardless of length.

Tool names, paths, titles, search queries, tags, frontmatter field names, and structural arguments remain visible. These metadata can be sensitive even when note-body arguments and frontmatter values are redacted.

`vault_cli` and `vault_cli_help` record the command, parameter names, and flags instead of raw arguments. Parameter values are omitted. Refusal messages may name a path, command ID, or parameter name.

YAML parser errors record fixed diagnostic categories and line numbers. `AmbiguousHeadingError.message` includes line numbers without note previews. `candidatesText()` puts previews in the response's second content block, which the logger does not record.

## Feedback

`vault_feedback` lets agents report a failed task or a missing tool. Its `goal`, `attempted`, `stuck_on`, and `suggested_tool` fields are stored verbatim.
