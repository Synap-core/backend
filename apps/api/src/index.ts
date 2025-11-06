/**
 * Synap API Server
 * 
 * Hono server with:
 * - tRPC API endpoints
 * - Better Auth routes
 * - Inngest handler
 */

// Load environment variables from .env
import 'dotenv/config';

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { trpcServer } from '@hono/trpc-server';
import { authMiddleware } from '@synap/auth';
import { appRouter, createContext } from '@synap/api';
import { serve } from '@hono/node-server';
import { serve as inngestServe } from 'inngest/hono';
import { inngest, functions } from '@synap/jobs';

const app = new Hono();

// Middleware
app.use('*', logger());
app.use('*', cors({
  origin: ['http://localhost:5173', 'http://localhost:3000'],
  credentials: true,
}));

// Health check (public, no auth)
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0-local',
    mode: 'single-user',
  });
});

// tRPC routes (protected by token auth)
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

