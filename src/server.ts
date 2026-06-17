// ABOUTME: Process entry — listens on PORT using the shared Express app from app.ts.
import { createApp } from './app.js';
import { saveTokens, assertApprovalGuardConfigured } from './auth.js';

const PORT = parseInt(process.env.PORT ?? '3456', 10);

// Secure by default: don't boot with the OAuth approval page unguarded.
try {
  assertApprovalGuardConfigured();
} catch (err) {
  console.error(`[auth] ${(err as Error).message}`);
  process.exit(1);
}

const app = createApp();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`obsidian-remote-mcp listening on port ${PORT}`);
});

// Persist tokens on clean shutdown so they survive container restarts
process.on('SIGTERM', () => { saveTokens(); process.exit(0); });
process.on('SIGINT',  () => { saveTokens(); process.exit(0); });
