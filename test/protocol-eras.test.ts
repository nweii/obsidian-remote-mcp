// ABOUTME: Exercises the deployed Express endpoint through explicit modern and legacy MCP clients.
// ABOUTME: Pins protocol negotiation, tool-contract parity, and representative vault reads.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import type { Server } from 'http';
import { createServer } from 'net';
import os from 'os';
import path from 'path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Auth } from 'mcp-server-kit';

const MODERN_PROTOCOL_VERSION = '2026-07-28';

let server: Server;
let base: string;
let auth: Auth;
let vaultPath: string;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const candidate = createServer();
    candidate.on('error', reject);
    candidate.listen(0, '127.0.0.1', () => {
      const address = candidate.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      candidate.close(() => resolve(port));
    });
  });
}

async function connect(mode: 'legacy' | { pin: string }) {
  const client = new Client(
    { name: 'obsidian-protocol-test', version: '1.0.0' },
    { versionNegotiation: { mode } },
  );
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    authProvider: { token: async () => auth.seedTestToken() },
  });
  await client.connect(transport);
  return { client, transport };
}

beforeAll(async () => {
  vaultPath = await mkdtemp(path.join(os.tmpdir(), 'obsidian-protocol-'));
  await writeFile(path.join(vaultPath, 'Protocol fixture.md'), '# Protocol fixture\nmodern read works\n');
  process.env.VAULT_PATH = vaultPath;
  process.env.VAULT_MCP_TEST = '1';
  process.env.MCP_CLIENT_ID = 'protocol-test-client';
  process.env.APPROVAL_OPEN = 'true';
  delete process.env.MCP_CLIENT_SECRET;
  delete process.env.APPROVAL_PASSWORD;

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  process.env.MCP_BASE_URL = base;
  const { createApp } = await import('../src/app.ts');
  const built = createApp();
  auth = built.auth!;
  await new Promise<void>((resolve) => {
    server = built.app.listen(port, '127.0.0.1', () => resolve());
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  await rm(vaultPath, { recursive: true, force: true });
});

test('serves modern 2026-07-28 discovery and a vault read without a session', async () => {
  const { client, transport } = await connect({ pin: MODERN_PROTOCOL_VERSION });
  try {
    expect(client.getProtocolEra()).toBe('modern');
    expect(client.getNegotiatedProtocolVersion()).toBe(MODERN_PROTOCOL_VERSION);
    expect(client.getDiscoverResult()?.supportedVersions).toContain(MODERN_PROTOCOL_VERSION);
    expect(transport.sessionId).toBeUndefined();

    const result = await client.callTool({
      name: 'vault_read',
      arguments: { path: 'Protocol fixture' },
    });
    expect(result.content).toContainEqual(
      expect.objectContaining({ type: 'text', text: expect.stringContaining('modern read works') }),
    );
  } finally {
    await client.close();
  }
});

test('keeps modern and legacy tool contracts identical', async () => {
  const [{ client: legacy }, { client: modern, transport }] = await Promise.all([
    connect('legacy'),
    connect({ pin: MODERN_PROTOCOL_VERSION }),
  ]);
  try {
    expect(legacy.getProtocolEra()).toBe('legacy');
    expect(modern.getProtocolEra()).toBe('modern');
    expect(transport.sessionId).toBeUndefined();

    const [legacyTools, modernTools] = await Promise.all([legacy.listTools(), modern.listTools()]);
    const contract = (tool: (typeof modernTools.tools)[number]) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      annotations: tool.annotations,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
    });
    expect(modernTools.tools.map(contract)).toEqual(legacyTools.tools.map(contract));
    expect(modernTools.tools.map(tool => tool.name)).toContain('vault_read');
  } finally {
    await Promise.all([legacy.close(), modern.close()]);
  }
});
