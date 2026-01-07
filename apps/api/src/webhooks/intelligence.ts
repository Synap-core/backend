/**
 * Webhook Routes - Intelligence Service Callbacks
 * 
 * Handles callbacks from intelligence services (e.g., analysis results).
 */

import { Hono } from 'hono';
import { publishEvent, createInboxItemAnalyzedEvent } from '@synap/events';
import { createLogger } from '@synap-core/core';
import { z } from 'zod';

const logger = createLogger({ module: 'intelligence-webhooks' });

export const intelligenceWebhookRouter = new Hono();

// Callback payload schema
const AnalysisCallbackSchema = z.object({
  requestId: z.string(),
  itemId: z.string(),
  analysis: z.object({
    priority: z.enum(['urgent', 'high', 'normal', 'low']).optional(),
    tags: z.array(z.string()).optional(),
    category: z.string().optional(),
    summary: z.string().optional(),
  }).passthrough(), // Allow additional fields
});

/**
 * Intelligence Service Callback
 * 
 * POST /webhooks/intelligence/callback
 * 
 * Called by intelligence services to return analysis results
 */
intelligenceWebhookRouter.post('/callback', async (c) => {
  try {
    const body = await c.req.json();
    
    // Validate payload
    const { requestId, itemId, analysis } = AnalysisCallbackSchema.parse(body);
    
    logger.info({ requestId, itemId }, 'Received intelligence callback');
    
    // ✅ Type-safe event publishing
    const event = createInboxItemAnalyzedEvent(itemId, {
      requestId,
      analysis,
    });
    
    await publishEvent(event, {
      userId: 'system', // TODO: Look up userId from inbox item
      source: 'intelligence-callback',
    });
    
    logger.info({ requestId, itemId }, 'Intelligence callback processed');
    
    return c.json({ success: true });
  } catch (error: any) {
    logger.error({ error }, 'Intelligence callback handler error');
    
    if (error.name === 'ZodError') {
      return c.json({ error: 'Invalid payload', details: error.errors }, 400);
    }
    
    return c.json({ error: 'Internal server error', message: error.message }, 500);
  }
});

/**
 * Health check
 */
intelligenceWebhookRouter.get('/health', (c) => {
  return c.json({ status: 'ok', service: 'intelligence-webhooks' });
});
