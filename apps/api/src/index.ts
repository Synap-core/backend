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

// Initialize OpenTelemetry tracing FIRST (before any other imports)
// This must be done before importing any libraries to ensure proper instrumentation
import { initializeTracing } from '@synap/core';
initializeTracing();

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { trpcServer } from '@hono/trpc-server';
import { createLogger, config, isSynapError, toSynapError, validateConfig } from '@synap/core';
import { appRouter, createContext } from '@synap/api';
import { serve } from '@hono/node-server';
import { serve as inngestServe } from 'inngest/hono';
import { inngest, functions } from '@synap/jobs';
import crypto from 'crypto';
import {
  rateLimitMiddleware,
  requestSizeLimit,
  securityHeadersMiddleware,
  getCorsOrigins,
} from './middleware/security.js';
import { eventStreamManager, setupEventBroadcasting } from '@synap/api';

// Setup event broadcasting to SSE clients
setupEventBroadcasting();

// Validate configuration at startup
const apiLogger = createLogger({ module: 'api-server' });
try {
  // Validate database config
  if (config.database.dialect === 'postgres') {
    validateConfig('postgres');
    apiLogger.info('PostgreSQL configuration validated');
  }
  
  // Validate storage config only if explicitly set to R2
  // If R2 credentials are missing, provider will auto-switch to MinIO
  if (config.storage.provider === 'r2') {
    // Only validate if we actually have R2 credentials
    // If not, the provider should have been auto-switched to MinIO
    if (config.storage.r2AccountId && config.storage.r2AccessKeyId && config.storage.r2SecretAccessKey) {
      validateConfig('r2');
      apiLogger.info('R2 storage configuration validated');
    } else {
      // This shouldn't happen if auto-detection works, but log a warning
      apiLogger.warn('R2 provider selected but credentials missing - should auto-switch to MinIO');
    }
  } else {
    apiLogger.info({ provider: config.storage.provider }, 'Storage provider configured');
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

// Prometheus metrics endpoint (public, no auth)
app.get('/metrics', async (c) => {
  const { getMetrics } = await import('@synap/core');
  const metrics = await getMetrics();
  return c.text(metrics, 200, {
    'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
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

// SSE endpoint for real-time event streaming (admin dashboard)
// This endpoint is public for now - in production, add auth
app.get('/api/events/stream', (c) => {
  const clientId = crypto.randomUUID();

  const stream = new ReadableStream({
    start(controller) {
      // Register the client
      eventStreamManager.registerClient(clientId, controller);

      // Send initial connection message
      const encoder = new TextEncoder();
      const initialMessage = `data: ${JSON.stringify({ type: 'connected', clientId })}\n\n`;
      controller.enqueue(encoder.encode(initialMessage));

      apiLogger.info({ clientId }, 'SSE client stream started');
    },
    cancel() {
      // Cleanup when client disconnects
      eventStreamManager.unregisterClient(clientId);
      apiLogger.info({ clientId }, 'SSE client stream cancelled');
    },
  });

  // Get CORS origins
  const allowedOrigins = getCorsOrigins();
  const origin = c.req.header('origin') || '';
  const allowOrigin = Array.isArray(allowedOrigins)
    ? (allowedOrigins.includes(origin) ? origin : allowedOrigins[0])
    : allowedOrigins;

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': allowOrigin,
      'Access-Control-Allow-Credentials': 'true',
    },
  });
});

// tRPC routes (protected by auth, except system.* routes in development)
app.use('/trpc/*', async (c, next) => {
  const path = c.req.path;

  // In development, allow public access to system.* routes for the admin dashboard
  // In production, you should add proper auth for the admin dashboard
  const isSystemRoute = path.includes('system.');
  const isDev = config.server.nodeEnv === 'development';

  if (isSystemRoute && isDev) {
    apiLogger.debug({ path }, 'Bypassing auth for system route in development');
    return next();
  }

  // Apply auth middleware for all other routes
  return authMiddleware(c, next);
});

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


