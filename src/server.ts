// ABOUTME: Process entry — listens on PORT using the shared Express app from app.ts.
import { createApp } from './app.js';
import { saveTokens } from './auth.js';

const PORT = parseInt(process.env.PORT ?? '3456', 10);

const app = createApp();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`obsidian-remote-mcp listening on port ${PORT}`);
});

// Persist tokens on clean shutdown so they survive container restarts
process.on('SIGTERM', () => { saveTokens(); process.exit(0); });
process.on('SIGINT',  () => { saveTokens(); process.exit(0); });
