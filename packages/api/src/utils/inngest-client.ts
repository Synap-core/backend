/**
 * Inngest Client for API Mutations
 * 
 * Phase 4: Shared Inngest client for publishing command events
 * 
 * This client is used by tRPC mutations to publish intent events.
 * It's separate from the jobs package client to avoid circular dependencies.
 */

import { Inngest } from 'inngest';
import { config } from '@synap/core';
import { createLogger } from '@synap/core';

const logger = createLogger({ module: 'api-inngest-client' });

const isProduction = config.server.nodeEnv === 'production';
const resolvedEventKey = config.inngest.eventKey ?? (isProduction ? undefined : 'dev-local-key');
const baseUrl = config.inngest.baseUrl ?? (isProduction ? undefined : 'http://127.0.0.1:8288');

if (!config.inngest.eventKey && !isProduction) {
  logger.warn('INNGEST_EVENT_KEY not provided. Using default "dev-local-key" for local development.');
}

export const inngest = new Inngest({
  id: 'synap-api-commands',
  eventKey: resolvedEventKey,
  baseUrl,
});

const canPublish = Boolean(resolvedEventKey);

/**
 * Publish an event to Inngest
 * 
 * Phase 4: Used by command mutations to publish intent events
 * 
 * @param eventName - Event name (e.g., 'note.creation.requested')
 * @param data - Event data
 * @param userId - User ID (for user context)
 */
export async function publishEvent(
  eventName: string,
  data: Record<string, unknown>,
  userId: string
): Promise<void> {
  if (!canPublish) {
    logger.warn('INNGEST_EVENT_KEY is not set. Event will not be published.');
    return;
  }

  try {
    await inngest.send({
      name: eventName,
      data,
      user: {
        id: userId,
      },
    });
    logger.debug({ eventName, userId }, 'Event published to Inngest');
  } catch (error) {
    logger.error({ err: error, eventName, userId }, 'Failed to publish event to Inngest');
    throw error;
  }
}

