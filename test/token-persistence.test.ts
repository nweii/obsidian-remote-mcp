// ABOUTME: Pins token persistence across a real process restart — issuing a token writes it to the
// configured store file, and a freshly started process reads that store and honors the token. Uses
// two child processes of the actual server entry so the restart is genuine, driven entirely over HTTP.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'child_process';
import { createServer } from 'net';
import { createHash } from 'crypto';
import { mkdtemp, readFile, rm } from 'fs/promises';
import os from 'os';
import path from 'path';

const CLIENT_ID = 'persist-client';
const REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback';
const REPO_ROOT = path.resolve(import.meta.dir, '..');

let tmpDir: string;
let storePath: string;

// Grab a free ephemeral port by binding :0, reading the assigned port, then releasing it.
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr === null || typeof addr === 'string') {
        reject(new Error('no port'));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

// Start the real server entry (src/server.ts) as a child process and resolve once it logs readiness.
async function startServer(port: number): Promise<ChildProcess> {
  const child = spawn('bun', ['src/server.ts'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      VAULT_MCP_TEST: '', // not test mode — the auth module loads its persisted token store at init
      PORT: String(port),
      VAULT_PATH: tmpDir,
      MCP_CLIENT_ID: CLIENT_ID,
      MCP_BASE_URL: 'https://example.test',
      TOKEN_STORE_PATH: storePath,
      VAULT_APPROVAL_OPEN: 'true', // satisfy the startup approval-guard without a password
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start in time')), 15000);
    const onData = (buf: Buffer) => {
      if (buf.toString().includes('listening on port')) {
        clearTimeout(timer);
        child.stdout?.off('data', onData);
        resolve();
      }
    };
    child.stdout?.on('data', onData);
    child.once('error', err => { clearTimeout(timer); reject(err); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`server exited early (${code})`)); });
  });

  return child;
}

async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>(resolve => {
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
  });
}

// Mint an access token over HTTP through the real OAuth flow.
async function mintToken(base: string): Promise<string> {
  const verifier = 'persist-verifier';
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const approve = await fetch(`${base}/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }),
  });
  const code = new URL(approve.headers.get('location')!).searchParams.get('code')!;
  // Re-pin (delta: token endpoint /oauth/token → /token). Path change only.
  const tokenRes = await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
    }),
  });
  return ((await tokenRes.json()) as { access_token: string }).access_token;
}

beforeAll(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'orm-persist-test-'));
  storePath = path.join(tmpDir, 'tokens.json');
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('token persistence across a restart', () => {
  test('an issued token is written to the store and honored by a freshly started process', async () => {
    // Process one: issue a token; the exchange writes it to the store file.
    const port1 = await freePort();
    const s1 = await startServer(port1);
    let token: string;
    try {
      token = await mintToken(`http://127.0.0.1:${port1}`);
      const store = JSON.parse(await readFile(storePath, 'utf-8')) as Record<string, number>;
      expect(Object.keys(store)).toContain(token);
      expect(store[token]).toBeGreaterThan(Date.now());
    } finally {
      await stopServer(s1);
    }

    // Process two (the restart): a fresh process reads the store and accepts the earlier token.
    const port2 = await freePort();
    const s2 = await startServer(port2);
    try {
      const base = `http://127.0.0.1:${port2}`;
      const accepted = await fetch(`${base}/mcp`, {
        headers: { Accept: 'text/event-stream', Authorization: `Bearer ${token}` },
      });
      expect(accepted.status).toBe(405); // authenticated GET → "no standalone SSE"

      const rejected = await fetch(`${base}/mcp`, {
        headers: { Accept: 'text/event-stream', Authorization: 'Bearer never-issued-token' },
      });
      expect(rejected.status).toBe(401);
    } finally {
      await stopServer(s2);
    }
  }, 30000);
});
