// ABOUTME: Optional tool registration: a feature that throws while registering leaves the features
// after it, and the caller's server, intact.
import { expect, spyOn, test } from 'bun:test';
import type { McpServer } from '@modelcontextprotocol/server';
import { registerOptionalTools } from '../src/tools.ts';

test('a throwing optional tool is logged and the rest still register', async () => {
  const names: string[] = [];
  const server = { registerTool(name: string) { names.push(name); } } as unknown as McpServer;
  const errors = spyOn(console, 'error').mockImplementation(() => {});
  try {
    await registerOptionalTools(server, [
      { label: 'first', register: s => { s.registerTool('first_tool', {} as never, (() => {}) as never); } },
      { label: 'broken', register: () => { throw new Error('boom'); } },
      { label: 'async broken', register: async () => { throw new Error('later boom'); } },
      { label: 'last', register: async s => { s.registerTool('last_tool', {} as never, (() => {}) as never); } },
    ]);
    expect(names).toEqual(['first_tool', 'last_tool']);
    expect(errors.mock.calls.map(c => c[0])).toEqual([
      '[obsidian-remote-mcp] broken registration failed; continuing with core tools.',
      '[obsidian-remote-mcp] async broken registration failed; continuing with core tools.',
    ]);
  } finally {
    errors.mockRestore();
  }
});
