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
import { createLogger, config, isSynapError, toSynapError, validateConfig } from '@synap/core';
import crypto from 'crypto';
import {
  rateLimitMiddleware,
  requestSizeLimit,
  securityHeadersMiddleware,
  getCorsOrigins,
} from './middleware/security.js';

// Validate configuration at startup
const apiLogger = createLogger({ module: 'api-server' });
try {
  // Validate database config
  if (config.database.dialect === 'postgres') {
    validateConfig('postgres');
    apiLogger.info('PostgreSQL configuration validated');
  }
  
  // Validate storage config
  if (config.storage.provider === 'r2') {
    validateConfig('r2');
    apiLogger.info('R2 storage configuration validated');
  }
  
  // Validate AI config in production
  if (config.server.nodeEnv === 'production') {
    validateConfig('ai');
    apiLogger.info('AI configuration validated');
  }
  
  // Validate auth config for PostgreSQL
  if (config.database.dialect === 'postgres') {
    validateConfig('better-auth');
    apiLogger.info('Better Auth configuration validated');
  }
} catch (error) {
  apiLogger.error({ err: error }, 'Configuration validation failed');
  console.error('❌ Configuration Error:', error instanceof Error ? error.message : String(error));
  console.error('Please check your environment variables and configuration.');
  process.exit(1);
}

// Dynamic auth import based on DB dialect
const isPostgres = config.database.dialect === 'postgres';
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
  
  apiLogger.info('Better Auth routes enabled at /api/auth/*');
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
  const errorId = crypto.randomUUID();
  const apiLogger = createLogger({ module: 'api-server' });
  
  // Convert to SynapError if needed (standardized error handling)
  const synapError = isSynapError(err) ? err : toSynapError(err, 'An unexpected error occurred');
  
  // Only log stack trace for 5xx errors or in development
  const shouldLogStack = synapError.statusCode >= 500 || config.server.nodeEnv === 'development';
  
  apiLogger[synapError.statusCode >= 500 ? 'error' : 'warn'](
    { 
      err: synapError, 
      errorId, 
      path: c.req.path,
      method: c.req.method,
      statusCode: synapError.statusCode,
      ...(shouldLogStack && { stack: synapError.stack }),
    },
    synapError.statusCode >= 500 ? 'Server error' : 'Client error'
  );
  
  const isDev = config.server.nodeEnv === 'development';
  
  // Return standardized error response
  // Cast statusCode to satisfy Hono's type requirements
  const statusCode = synapError.statusCode as 400 | 401 | 403 | 404 | 409 | 429 | 500 | 503;
  return c.json(
    {
      error: synapError.name,
      code: synapError.code,
      message: synapError.message,
      ...(synapError.context && { context: synapError.context }),
      ...(isDev && { 
        errorId,
        ...(shouldLogStack && { stack: synapError.stack }),
      }),
    },
    statusCode
  );
});

// Start server
const port = config.server.port;
apiLogger.info({ port }, 'Synap API starting');

serve({
  fetch: app.fetch,
  port,
}, (info) => {
  apiLogger.info(
    {
      port: info.port,
      tRPC: `http://localhost:${info.port}/trpc`,
      auth: `http://localhost:${info.port}/api/auth`,
      health: `http://localhost:${info.port}/health`,
    },
    'Server running'
  );
});

export default app;


