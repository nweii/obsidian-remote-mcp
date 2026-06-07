// ABOUTME: Shared registerLogged wrapper. Wraps server.registerTool with timing + JSONL logging
// so every tool call lands in the audit trail with args summary, ok/error, duration, and the
// suggestion text returned on isError responses.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logToolCall } from "./log.js";

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export type ToolResult = {
  content: ToolContent[];
  isError?: boolean;
};

export function extractErrorText(result: ToolResult): string | undefined {
  const first = result.content?.[0];
  return first && first.type === "text" ? first.text : undefined;
}

// Uses `any` for def and handler because the SDK's registerTool is heavily generic and re-typing
// it here just fights the compiler with no runtime benefit.
export function registerLogged(
  server: McpServer,
  name: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  def: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (args: any) => Promise<ToolResult>,
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server.registerTool as any)(name, def, async (args: any) => {
    const start = Date.now();
    try {
      const result = await handler(args);
      const ok = result.isError !== true;
      logToolCall({
        tool: name,
        args,
        ok,
        duration_ms: Date.now() - start,
        error: ok ? undefined : extractErrorText(result),
      });
      return result;
    } catch (e) {
      logToolCall({
        tool: name,
        args,
        ok: false,
        duration_ms: Date.now() - start,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  });
}
