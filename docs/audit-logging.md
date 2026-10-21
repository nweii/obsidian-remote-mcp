# Audit logging

[README](../README.md) · [Authentication and vault settings](configuration.md) · [Server reference](server.md)

## Files and controls

Logging is enabled by default. Tool calls go to `LOG_DIR/tool-calls.jsonl`; feedback goes to `LOG_DIR/feedback.jsonl`; decision-model usage goes to `LOG_DIR/decision-usage.jsonl`.

Set `LOG_ENABLED=false` to disable all three logs and omit the `vault_feedback` tool.

At startup, each log larger than `LOG_MAX_BYTES` (default 10 MB) is renamed to `<name>.1`, replacing the previous `.1`, so a log keeps at most two generations on disk. Rotation happens only at startup, so a server that runs for a long time without restarting can grow a log past the cap until its next start. Set `LOG_MAX_BYTES=0` to manage the files yourself. Use a persistent volume for `LOG_DIR` when logs must survive container replacement.

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

## Decision-model usage

Each `vault_search_semantic` call that judges anything writes one entry: `{ ts, client, client_name?, tool, provider, model, resolved_models, requests, from_cache, input_tokens, output_tokens, cost_usd }`.

- `model` is the configured model or alias. `resolved_models` lists the versions the provider reported answering with.
- `from_cache` counts judgments answered from the cache with no request.
- Token and cost fields are what the provider reported. A field is `null` when any request's response left it out, so a partial sum is never recorded as the total. Only some providers report `cost_usd`; for the rest, multiply `input_tokens` by the provider's published price.

Entries hold counts and model names only, never the goal, note paths, or note text. The tool's result also shows the request count and input tokens.

## Feedback

`vault_feedback` lets agents report a failed task or a missing tool. Its `goal`, `attempted`, `stuck_on`, and `suggested_tool` fields are stored verbatim.
