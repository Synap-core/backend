/**
 * Synap API Server
 * 
 * Hono server with:
 * - tRPC API endpoints
 * - Better Auth routes (PostgreSQL only)
 * - Inngest handler
 */

// Load environment variables from .env
import 'dotenv/config';

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { trpcServer } from '@hono/trpc-server';
import { appRouter, createContext } from '@synap/api';
import { serve } from '@hono/node-server';
import { serve as inngestServe } from 'inngest/hono';
import { inngest, functions } from '@synap/jobs';
import {
  rateLimitMiddleware,
  requestSizeLimit,
  securityHeadersMiddleware,
  getCorsOrigins,
} from './middleware/security.js';

// Dynamic auth import based on DB dialect
const isPostgres = process.env.DB_DIALECT === 'postgres';
let auth: any = null;
let authMiddleware: any = null;

if (isPostgres) {
  // PostgreSQL: Better Auth with OAuth
  const betterAuth = await import('@synap/auth');
  auth = betterAuth.auth;
  authMiddleware = betterAuth.authMiddleware;
} else {
  // SQLite: Simple token auth
  const simpleAuth = await import('@synap/auth');
  authMiddleware = simpleAuth.authMiddleware;
}

const app = new Hono();

// Security Middleware (Applied First)
app.use('*', requestSizeLimit); // Max 10MB requests
app.use('*', rateLimitMiddleware); // 100 req/15min per IP
app.use('*', securityHeadersMiddleware); // Security headers
app.use('*', secureHeaders()); // Hono built-in security

// Logging & CORS
app.use('*', logger());
app.use('*', cors({
  origin: getCorsOrigins(),
  credentials: true,
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  exposeHeaders: ['Content-Length', 'X-Request-Id'],
  maxAge: 86400, // 24 hours
}));

// Health check (public, no auth)
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: isPostgres ? '0.2.0-saas' : '0.1.0-local',
    mode: isPostgres ? 'multi-user' : 'single-user',
    auth: isPostgres ? 'better-auth' : 'static-token',
  });
});

// Better Auth routes (PostgreSQL only)
if (isPostgres && auth) {
  // Handle all Better Auth routes: /api/auth/sign-in, /api/auth/sign-up, etc.
  app.all('/api/auth/*', async (c) => {
    return auth.handler(c.req.raw);
  });
  
  console.log('✅ Better Auth routes enabled at /api/auth/*');
}

// tRPC routes (protected by auth)
app.use('/trpc/*', authMiddleware);
app.use(
  '/trpc/*',
  trpcServer({
    router: appRouter,
    createContext: async (opts) => {
      const ctx = await createContext(opts.req);
      return ctx as unknown as Record<string, unknown>;
    },
  })
);

// Inngest handler (for background jobs)
app.use(
  '/api/inngest',
  inngestServe({
    client: inngest,
    functions,
  })
);

// 404 handler
app.notFound((c) => {
  return c.json({ error: 'Not found' }, 404);
});

// Error handler
app.onError((err, c) => {
  console.error('Server error:', err);
  return c.json({
    error: 'Internal server error',
    message: err.message,
  }, 500);
});

// Start server
const port = parseInt(process.env.PORT || '3000');

console.log(`🚀 Synap API starting on port ${port}`);

serve({
  fetch: app.fetch,
  port,
}, (info) => {
  console.log(`✅ Server running at http://localhost:${info.port}`);
  console.log(`📡 tRPC API: http://localhost:${info.port}/api/trpc`);
  console.log(`🔐 Auth API: http://localhost:${info.port}/api/auth`);
});

export default app;


