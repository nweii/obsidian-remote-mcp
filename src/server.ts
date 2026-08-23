// ABOUTME: Process entry — builds the app via createApp() and starts it with the kit's startServer,
// which persists issued tokens on SIGTERM/SIGINT. createAuth refuses to construct when the OAuth
// approval page is unguarded, so a misconfigured deployment fails fast here rather than booting.
import { startServer } from 'mcp-server-kit';
import { createApp } from './app.js';

const PORT = parseInt(process.env.PORT ?? '3456', 10);

let built: ReturnType<typeof createApp>;
try {
  built = createApp();
} catch (err) {
  console.error(`[auth] ${(err as Error).message}`);
  process.exit(1);
}

const { app, auth } = built;

// Bind address. Defaults to 0.0.0.0 because the normal deployment is a container, where
// binding loopback would make the port unreachable from the host. That default also means the
// process answers on every interface it has: if the container port is published without a host
// restriction, the backend is reachable directly, bypassing whatever TLS proxy or identity
// gateway fronts it — which matters most with APPROVAL_OPEN=true, where that gateway *is* the
// approval gate. Set HOST=127.0.0.1 when running the process directly on the host behind a
// local proxy; in Docker, restrict the published port instead ("127.0.0.1:3456:3456").
const HOST = process.env.HOST?.trim() || undefined;

startServer({
  app,
  port: PORT,
  ...(HOST ? { host: HOST } : {}),
  // Keep the "listening on port N" phrasing — test/token-persistence.test.ts waits on it to
  // know the child server is up. The bind address is appended rather than substituted.
  onListen: () =>
    console.log(`obsidian-remote-mcp listening on port ${PORT} (bind ${HOST ?? '0.0.0.0'})`),
  // Persist tokens on clean shutdown so they survive container restarts.
  onShutdown: () => auth.saveTokens(),
});
