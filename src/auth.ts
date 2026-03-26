// ABOUTME: OAuth 2.1 authorization server - discovery, authorization code flow with PKCE, and token issuance.
import type { Request, Response, NextFunction } from 'express';
import { randomUUID, createHash } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import { getVaultDisplayName } from './vault.js';

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const CODE_TTL_MS  = 10 * 60 * 1000; // 10 minutes

// Tokens persist to this file so they survive container restarts.
const TOKEN_STORE_PATH = process.env.TOKEN_STORE_PATH ?? './tokens.json';

// In-memory stores
const tokens    = new Map<string, number>();    // token → expiry
const authCodes = new Map<string, PendingCode>(); // code  → pending auth

// --- Token persistence -------------------------------------------------------

function loadPersistedTokens() {
  try {
    const data = JSON.parse(readFileSync(TOKEN_STORE_PATH, 'utf-8')) as Record<string, number>;
    const now = Date.now();
    for (const [token, expiry] of Object.entries(data)) {
      if (expiry > now) tokens.set(token, expiry);
    }
    console.log(`[auth] loaded ${tokens.size} token(s) from ${TOKEN_STORE_PATH}`);
  } catch {
    // no store yet — start fresh
  }
}

export function saveTokens() {
  try {
    const data: Record<string, number> = {};
    for (const [token, expiry] of tokens) data[token] = expiry;
    writeFileSync(TOKEN_STORE_PATH, JSON.stringify(data));
  } catch (err) {
    console.error('[auth] failed to save token store:', err);
  }
}

// Load on startup (module init — runs once when the module is first imported)
if (process.env.VAULT_MCP_TEST !== '1') loadPersistedTokens();

interface PendingCode {
  codeChallenge:       string;
  codeChallengeMethod: string;
  clientId:            string;
  redirectUri:         string;
  state?:              string;
  expiresAt:           number;
}

// --- Helpers -----------------------------------------------------------------

function getBaseUrl(): string {
  return process.env.MCP_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3456}`;
}

function getClientId(): string {
  const id = process.env.MCP_CLIENT_ID;
  if (!id) throw new Error('MCP_CLIENT_ID env var is required');
  return id;
}

function getClientSecret(): string | undefined {
  const secret = process.env.MCP_CLIENT_SECRET?.trim();
  return secret ? secret : undefined;
}

function getAllowedRedirectUris(): string[] {
  const env = process.env.MCP_ALLOWED_REDIRECT_URIS;
  if (env) return env.split(',').map(u => u.trim());
  return ['https://claude.ai/api/mcp/auth_callback'];
}

function pruneExpired() {
  const now = Date.now();
  for (const [k, v] of tokens)    if (now > v)          tokens.delete(k);
  for (const [k, v] of authCodes) if (now > v.expiresAt) authCodes.delete(k);
}

function verifyPKCE(codeVerifier: string, codeChallenge: string): boolean {
  const computed = createHash('sha256').update(codeVerifier).digest('base64url');
  return computed === codeChallenge;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function getVaultDisplayNameHtml(): string {
  return escapeHtml(getVaultDisplayName());
}

function wwwAuthenticate(extra = ''): string {
  const meta = `resource_metadata="${getBaseUrl()}/.well-known/oauth-protected-resource"`;
  return extra ? `Bearer ${meta}, ${extra}` : `Bearer ${meta}`;
}

// --- Discovery endpoints -----------------------------------------------------

// GET /.well-known/oauth-protected-resource  (RFC9728)
// Tells clients which authorization server to use.
export function protectedResourceHandler(_req: Request, res: Response) {
  const base = getBaseUrl();
  res.json({ resource: base, authorization_servers: [base] });
}

// GET /.well-known/oauth-authorization-server  (RFC8414)
// Advertises all auth server capabilities including PKCE support.
export function discoveryHandler(_req: Request, res: Response) {
  const base = getBaseUrl();
  res.json({
    issuer:                               base,
    authorization_endpoint:              `${base}/authorize`,
    token_endpoint:                       `${base}/oauth/token`,
    response_types_supported:            ['code'],
    grant_types_supported:               ['authorization_code'],
    code_challenge_methods_supported:    ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
  });
}

// --- Authorization endpoint --------------------------------------------------

// GET /authorize  — validate params, render approval page
export function authorizationHandler(req: Request, res: Response) {
  const q = req.query as Record<string, string>;
  const { response_type, client_id, redirect_uri, code_challenge, code_challenge_method, state, scope } = q;

  if (response_type !== 'code') {
    res.status(400).send('Unsupported response_type');
    return;
  }
  if (client_id !== getClientId()) {
    res.status(400).send('Unknown client_id');
    return;
  }
  if (!getAllowedRedirectUris().includes(redirect_uri)) {
    res.status(400).send('redirect_uri not allowed');
    return;
  }
  if (!code_challenge || code_challenge_method !== 'S256') {
    res.status(400).send('PKCE with S256 is required');
    return;
  }

  // Pass all params through hidden inputs so POST /authorize can use them
  const params: [string, string][] = [
    ['response_type', response_type],
    ['client_id', client_id],
    ['redirect_uri', redirect_uri],
    ['code_challenge', code_challenge],
    ['code_challenge_method', code_challenge_method],
    ...(state ? [['state', state] as [string, string]] : []),
    ...(scope  ? [['scope',  scope]  as [string, string]] : []),
  ];

  const inputs = params
    .map(([name, val]) => `<input type="hidden" name="${name}" value="${escapeHtml(val)}">`)
    .join('\n    ');

  res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Authorize obsidian-remote-mcp</title>
  <style>
    body   { font-family: system-ui, sans-serif; max-width: 400px; margin: 80px auto; padding: 0 1rem; color: #111; }
    h1     { font-size: 1.25rem; margin-bottom: 0.5rem; }
    p      { color: #555; margin-bottom: 1.5rem; }
    button { padding: 0.5rem 1.5rem; font-size: 1rem; cursor: pointer; }
  </style>
</head>
<body>
  <h1>Authorize obsidian-remote-mcp</h1>
  <p>Allow access to your ${getVaultDisplayNameHtml()} vault?</p>
  <form method="POST" action="/authorize">
    ${inputs}
    <button type="submit">Approve</button>
  </form>
</body>
</html>`);
}

// POST /authorize  — user approved; generate code and redirect back to client
export function authorizationApproveHandler(req: Request, res: Response) {
  const b = req.body as Record<string, string>;
  const { response_type, client_id, redirect_uri, code_challenge, code_challenge_method, state } = b;

  if (response_type !== 'code' || client_id !== getClientId()) {
    res.status(400).send('Invalid request');
    return;
  }
  if (!getAllowedRedirectUris().includes(redirect_uri)) {
    res.status(400).send('redirect_uri not allowed');
    return;
  }

  const code = randomUUID();
  authCodes.set(code, {
    codeChallenge:       code_challenge,
    codeChallengeMethod: code_challenge_method,
    clientId:            client_id,
    redirectUri:         redirect_uri,
    state,
    expiresAt:           Date.now() + CODE_TTL_MS,
  });

  const url = new URL(redirect_uri);
  url.searchParams.set('code', code);
  if (state) url.searchParams.set('state', state);
  res.redirect(url.toString());
}

// --- Token endpoint ----------------------------------------------------------

// POST /oauth/token  — exchange authorization code + code_verifier for access token.
// Public PKCE clients may omit client_secret; confidential clients can send one via client_secret_post.
export function tokenHandler(req: Request, res: Response) {
  const { grant_type, code, code_verifier, client_id, client_secret, redirect_uri } = req.body as Record<string, string>;

  if (grant_type !== 'authorization_code') {
    res.status(400).json({ error: 'unsupported_grant_type' });
    return;
  }
  if (!code) {
    res.status(400).json({ error: 'invalid_request', error_description: 'code is required' });
    return;
  }

  pruneExpired();
  const pending = authCodes.get(code);
  if (!pending) {
    res.status(400).json({ error: 'invalid_grant', error_description: 'Unknown or expired code' });
    return;
  }
  if (client_id !== pending.clientId || redirect_uri !== pending.redirectUri) {
    res.status(400).json({ error: 'invalid_grant' });
    return;
  }
  if (client_secret !== undefined) {
    const expectedSecret = getClientSecret();
    if (!expectedSecret || client_secret !== expectedSecret) {
      res.status(401).json({ error: 'invalid_client' });
      return;
    }
  }
  if (!verifyPKCE(code_verifier ?? '', pending.codeChallenge)) {
    res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
    return;
  }

  authCodes.delete(code); // single-use
  const token = randomUUID();
  tokens.set(token, Date.now() + TOKEN_TTL_MS);
  saveTokens();
  res.json({ access_token: token, token_type: 'bearer', expires_in: TOKEN_TTL_MS / 1000 });
}

// --- Auth middleware ----------------------------------------------------------

export function validateToken(token: string): boolean {
  pruneExpired();
  const expiry = tokens.get(token);
  return expiry !== undefined && Date.now() <= expiry;
}

/** Inserts a valid opaque access token for HTTP tests. Only when `VAULT_MCP_TEST=1`. */
export function seedTestToken(): string {
  if (process.env.VAULT_MCP_TEST !== '1') {
    throw new Error('seedTestToken is only for automated tests (set VAULT_MCP_TEST=1)');
  }
  pruneExpired();
  const token = randomUUID();
  tokens.set(token, Date.now() + TOKEN_TTL_MS);
  return token;
}

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.setHeader('WWW-Authenticate', wwwAuthenticate());
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const token = authHeader.slice(7);
  if (!validateToken(token)) {
    res.setHeader('WWW-Authenticate', wwwAuthenticate('error="invalid_token"'));
    res.status(401).json({ error: 'invalid_token' });
    return;
  }

  next();
}
