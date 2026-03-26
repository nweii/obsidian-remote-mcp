// ABOUTME: Express application factory — OAuth, well-known metadata, and stateless MCP (used by server entry and tests).
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { Express } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  protectedResourceHandler,
  discoveryHandler,
  authorizationHandler,
  authorizationApproveHandler,
  tokenHandler,
  authMiddleware,
} from './auth.js';
import { registerTools } from './tools.js';

function ts(): string {
  return new Date().toISOString();
}

function clientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  const ip = Array.isArray(forwarded) ? forwarded[0] : (forwarded?.split(',')[0] ?? req.socket.remoteAddress ?? '?');
  return ip.trim();
}

function requestLogger(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();
  res.on('finish', () => {
    console.log(`[${ts()}] ${clientIp(req)} ${req.method} ${req.path} → ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
}

function getAllowedOrigins(): string[] | null {
  const env = process.env.CORS_ALLOWED_ORIGINS?.trim();
  if (!env || env === '*') return null;
  return env.split(',').map(origin => origin.trim()).filter(Boolean);
}

function setCorsHeaders(req: Request, res: Response): boolean {
  const allowedOrigins = getAllowedOrigins();
  const origin = req.headers.origin;

  if (allowedOrigins === null) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  } else if (req.method === 'OPTIONS' && origin) {
    res.status(403).end();
    return false;
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept');
  return true;
}

export function createApp(): Express {
  const app = express();

  // CORS — browser-based OAuth and MCP clients may need cross-origin access.
  app.use((req, res, next) => {
    if (!setCorsHeaders(req, res)) return;
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(requestLogger);

  // OAuth discovery (unauthenticated — clients need these to initiate auth)
  app.get('/.well-known/oauth-protected-resource', protectedResourceHandler);
  app.get('/.well-known/oauth-authorization-server', discoveryHandler);

  // Authorization code flow
  app.get('/authorize', authorizationHandler);
  app.post('/authorize', authorizationApproveHandler);
  app.post('/oauth/token', tokenHandler);

  // Streamable HTTP clients probe GET with Accept: text/event-stream; 405 means "no standalone SSE" (not 404).
  app.get('/mcp', authMiddleware, (_req, res) => {
    res.setHeader('Allow', 'POST, DELETE');
    res.status(405).end();
  });

  // MCP endpoint — auth required
  app.post('/mcp', authMiddleware, async (req, res) => {
    // Log the MCP method and tool name (if a tool call) for auditability
    const body = req.body as { method?: string; params?: { name?: string } };
    const mcpMethod = body?.method ?? '?';
    const toolName = body?.params?.name;
    console.log(`[${ts()}] MCP ${mcpMethod}${toolName ? ` (${toolName})` : ''}`);

    const server = new McpServer({ name: 'obsidian-remote-mcp', version: '1.0.0' });
    registerTools(server);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless — no session tracking
      enableJsonResponse: true, // return JSON instead of SSE; avoids proxy buffering issues
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  return app;
}
