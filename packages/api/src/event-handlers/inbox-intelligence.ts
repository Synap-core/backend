/**
 * Inbox Intelligence Handler
 * 
 * Listens to: inbox.item.received
 * Action: Call intelligence service for analysis
 * 
 * This handler sends inbox items to registered intelligence services
 * for analysis (priority, tags, categorization, etc.)
 */

import { db, intelligenceServices, eq } from '@synap/database';
import type { InboxItemReceivedEvent } from '@synap/events';
import { createLogger } from '@synap-core/core';

const logger = createLogger({ module: 'inbox-intelligence-handler' });

/**
 * Handle inbox item received event
 * Calls intelligence service for analysis
 */
export async function handleInboxItemIntelligence(
  event: InboxItemReceivedEvent & {
    id: string;
    userId: string;
    timestamp: Date;
  }
) {
  logger.info({ 
    itemId: event.subjectId,
    provider: event.data.provider 
  }, 'Requesting intelligence analysis');
  
  try {
    // Find active intelligence services that can handle inbox analysis
    const services = await db
      .select()
      .from(intelligenceServices)
      .where(eq(intelligenceServices.status, 'active'));
    
    // Filter for services with 'lifefeed-analysis' capability
    const lifefeedServices = services.filter(s => 
      s.capabilities.includes('lifefeed-analysis')
    );
    
    if (lifefeedServices.length === 0) {
      logger.warn('No intelligence services available for Life Feed analysis');
      return;
    }
    
    // Use the first available service
    const service = lifefeedServices[0];
    
    logger.info({ 
      serviceId: service.serviceId,
      itemId: event.subjectId 
    }, 'Calling intelligence service');
    
    // Call the service webhook
    const response = await fetch(service.webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${service.apiKey}`,
      },
      body: JSON.stringify({
        requestId: event.id, // Event ID as request ID
        itemId: event.subjectId,
        item: {
          provider: event.data.provider,
          externalId: event.data.externalId,
          type: event.data.type,
          title: event.data.title,
          preview: event.data.preview,
          timestamp: event.data.timestamp,
          deepLink: event.data.deepLink,
          data: event.data.rawData,
        },
        callbackUrl: `${process.env.API_URL}/webhooks/intelligence/callback`,
      }),
    });
    
    if (!response.ok) {
      throw new Error(`Intelligence service returned ${response.status}: ${await response.text()}`);
    }
    
    logger.info({ 
      serviceId: service.serviceId,
      itemId: event.subjectId,
      status: response.status 
    }, 'Intelligence service called successfully');
    
  } catch (error) {
    logger.error({ 
      err: error, 
      itemId: event.subjectId 
    }, 'Failed to call intelligence service');
    // Don't throw - we don't want to block inbox storage if intelligence fails
  }
}
