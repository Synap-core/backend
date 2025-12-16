/**
 * Webhooks Main Router
 * 
 * Aggregates all webhook routes (N8N, Intelligence Services, etc.)
 */

import { Hono } from 'hono';
import { n8nWebhookRouter } from './n8n.js';
import { intelligenceWebhookRouter } from './intelligence.js';

export const webhookRouter = new Hono();

// Mount sub-routers
webhookRouter.route('/n8n', n8nWebhookRouter);
webhookRouter.route('/intelligence', intelligenceWebhookRouter);

// Global webhook health check
webhookRouter.get('/health', (c) => {
  return c.json({
    status: 'ok',
    routes: {
      n8n: '/webhooks/n8n/*',
      intelligence: '/webhooks/intelligence/*',
    }
  });
});
