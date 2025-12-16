/**
 * Webhook Routes - N8N Integration
 * 
 * Handles incoming webhooks from N8N for inbox item ingestion.
 * Uses webhook secret authentication instead of user auth.
 */

import { Hono } from 'hono';
import { publishEvent, createInboxItemReceivedEvent } from '@synap/events';
import { createLogger } from '@synap/core';
import { z } from 'zod';

const logger = createLogger({ module: 'n8n-webhooks' });

export const n8nWebhookRouter = new Hono();

// Webhook authentication middleware
const webhookAuth = async (c: any, next: () => Promise<void>) => {
  const secret = c.req.header('X-Webhook-Secret');
  const expectedSecret = process.env.N8N_WEBHOOK_SECRET;
  
  if (!expectedSecret) {
    logger.warn('N8N_WEBHOOK_SECRET not configured');
    return c.json({ error: 'Webhook authentication not configured' }, 500);
  }
  
  if (secret !== expectedSecret) {
    logger.warn({ receivedSecret: secret?.substring(0, 10) }, 'Invalid webhook secret');
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  await next();
};

// Validation schema for inbox items
const InboxItemSchema = z.object({
  provider: z.string(),
  account: z.string(),
  externalId: z.string(),
  type: z.string(),
  title: z.string(),
  preview: z.string().optional(),
  timestamp: z.coerce.date(),
  deepLink: z.string().optional(),
  data: z.record(z.unknown()),
});

/**
 * N8N Inbox Ingestion Webhook
 * 
 * POST /webhooks/n8n/inbox
 * Headers: X-Webhook-Secret, X-User-Id
 * Body: { items: InboxItem[] }
 */
n8nWebhookRouter.post('/inbox', webhookAuth, async (c) => {
  try {
    const userId = c.req.header('X-User-Id');
    
    if (!userId) {
      return c.json({ error: 'X-User-Id header required' }, 400);
    }
    
    const body = await c.req.json();
    const { items } = body;
    
    if (!Array.isArray(items)) {
      return c.json({ error: 'items must be an array' }, 400);
    }
    
    logger.info({ userId, count: items.length }, 'Processing N8N inbox webhook');
    
    const results = { published: 0, failed: 0, errors: [] as string[] };
    
    for (const item of items) {
      try {
        // Validate item
        const validated = InboxItemSchema.parse(item);
        
        // Generate ID for the inbox item
        const itemId = `inbox_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        // ✅ Type-safe event publishing
        const event = createInboxItemReceivedEvent(itemId, {
          provider: validated.provider,
          externalId: validated.externalId,
          type: validated.type,
          title: validated.title,
          preview: validated.preview,
          timestamp: validated.timestamp,
          deepLink: validated.deepLink,
          rawData: validated.data,
        });
        
        await publishEvent(event, {
          userId,
          source: 'n8n-webhook',
        });
        
        results.published++;
      } catch (error: any) {
        logger.error({ error, item }, 'Failed to process inbox item');
        results.failed++;
        results.errors.push(error.message);
      }
    }
    
    logger.info(results, 'N8N inbox webhook processing complete');
    
    return c.json({
      success: true,
      ...results,
    });
  } catch (error: any) {
    logger.error({ error }, 'N8N webhook handler error');
    return c.json({ error: 'Internal server error', message: error.message }, 500);
  }
});

/**
 * Health check for webhooks
 */
n8nWebhookRouter.get('/health', (c) => {
  return c.json({ status: 'ok', service: 'n8n-webhooks' });
});
