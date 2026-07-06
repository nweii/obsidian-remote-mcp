// ABOUTME: Assembles the obsidian-remote-mcp server from the shared mcp-server-kit (CORS, request
// logging, a bearer-gated /health with a vault-liveness probe, the Claude-facing OAuth surface, and
// the stateless /mcp mount) and registers the vault tools. createApp() returns the Express app plus
// the auth instance, whose saveTokens() the entry point persists on shutdown.
import type { Express } from 'express';
import { stat } from 'fs/promises';
import { createApp as createKitApp, createAuth } from 'mcp-server-kit';
import type { Auth } from 'mcp-server-kit';
import { getVaultRoot, getVaultDisplayName } from './vault.js';
import { registerTools } from './tools.js';
import pkg from '../package.json' with { type: 'json' };

function getAllowedOrigins(): string[] | null {
  const env = process.env.CORS_ALLOWED_ORIGINS?.trim();
  if (!env || env === '*') return null;
  return env.split(',').map(origin => origin.trim()).filter(Boolean);
}

// Builds the server. Returns the app and its auth instance; the entry point persists tokens via
// auth.saveTokens() on shutdown. createAuth throws at construction when /authorize is unguarded, so a
// misconfigured deployment fails fast rather than booting exposed.
export function createApp(): { app: Express; auth: Auth } {
  const testMode = process.env.VAULT_MCP_TEST === '1';
  const port = process.env.PORT ?? '3456';

  const clientId = process.env.MCP_CLIENT_ID;
  if (!clientId) throw new Error('MCP_CLIENT_ID env var is required');

  const redirectEnv = process.env.MCP_ALLOWED_REDIRECT_URIS;
  const auth = createAuth({
    baseUrl: process.env.MCP_BASE_URL ?? `http://localhost:${port}`,
    clientId,
    displayName: 'obsidian-remote-mcp',
    tokenStorePath: process.env.TOKEN_STORE_PATH ?? './tokens.json',
    clientSecret: process.env.MCP_CLIENT_SECRET,
    allowedRedirectUris: redirectEnv ? redirectEnv.split(',').map(u => u.trim()) : undefined,
    staticBearerToken: process.env.MCP_STATIC_BEARER_TOKEN,
    approvalPassword: process.env.VAULT_APPROVAL_PASSWORD,
    approvalOpen: process.env.VAULT_APPROVAL_OPEN?.trim().toLowerCase() === 'true',
    approvalPrompt: `Allow access to your ${getVaultDisplayName()} vault?`,
    testMode,
    // The SDK's rate limiter keys on client IP; under test every request shares 127.0.0.1, so leaving
    // it on would throttle across cases. Disabled in test only — production keeps it.
    disableRateLimit: testMode,
  });

  const app = createKitApp({
    name: 'obsidian-remote-mcp',
    version: pkg.version,
    auth,
    // Read live per /health request (the kit reads this property on each call), so an uptime
    // monitor's HEALTH_TOKEN can be set or rotated without a code change.
    get healthToken() {
      return process.env.HEALTH_TOKEN?.trim() || undefined;
    },
    // One stat of the vault root catches the realistic NAS failure where the process is up but the
    // volume mount is broken. Throwing marks the server unhealthy: the kit answers /health with 503.
    healthProbe: () => stat(getVaultRoot()).then(() => undefined),
    corsOrigins: getAllowedOrigins(),
    registerTools,
    testMode,
  });

  // Deployed behind a reverse proxy / tunnel on the loopback interface. Trust that single loopback hop
  // so req.ip resolves to the real client from X-Forwarded-For; otherwise the SDK's per-IP rate limiter
  // buckets every request under 127.0.0.1. 'loopback' (not `true`) keeps the trust boundary at the
  // local tunnel and does not trust arbitrary upstream proxies.
  app.set('trust proxy', 'loopback');

  return { app, auth };
}
