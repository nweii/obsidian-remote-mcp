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

startServer({
  app,
  port: PORT,
  onListen: () => console.log(`obsidian-remote-mcp listening on port ${PORT}`),
  // Persist tokens on clean shutdown so they survive container restarts.
  onShutdown: () => auth.saveTokens(),
});
