# Audit logging

What the tool-call and feedback logs record, and what they redact.

- When logging is enabled (default), every tool call is recorded to `LOG_DIR/tool-calls.jsonl` with `{ ts, tool, args, ok, duration_ms, error? }`. The `error` field captures the suggestion text returned to the client on `isError` responses, so review can show both the failure and what the agent was told to try next.
- YAML parser errors expose only fixed safe diagnostic categories and line numbers. `AmbiguousHeadingError.message` carries line numbers but no note previews; `candidatesText()` provides previews in the tool response’s second content block, which the logger does not record.
- Args are summarized before logging: strings over 80 chars become `<str:Nchars>`, and the fields `content`, `value`, `template`, and `find` are always redacted to `<redacted:Nchars>` regardless of length so note bodies and frontmatter values never land on disk. Tool names, paths, titles, search queries, tags, frontmatter field names, and structural args remain visible and can reveal sensitive metadata. Use `LOG_ENABLED=false` when that metadata must not be stored.
- Agents can call `vault_feedback` to log a structured note when they get stuck or want a tool that doesn't exist; entries land in `LOG_DIR/feedback.jsonl`. The tool is only registered when logging is enabled. Feedback fields (`goal`, `attempted`, `stuck_on`, `suggested_tool`) are agent-authored and stored verbatim.
- No automatic rotation — log files grow forever. Mount `LOG_DIR` as a persistent volume in production and rotate or truncate manually if size becomes a concern.
- Set `LOG_ENABLED=false` to disable both — useful for forks that don't want disk writes recording agent activity, or for ephemeral deployments without a persistent volume.
