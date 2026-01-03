/**
 * Inngest Client for API Mutations
 * 
 * Phase 4: Shared Inngest client for publishing command events
 * 
 * This client is used by tRPC mutations to publish intent events.
 * It's separate from the jobs package client to avoid circular dependencies.
 */

import { Inngest } from 'inngest';
import { config, createLogger } from '@synap-core/core';

const logger = createLogger({ module: 'api-inngest-client' });

// Allow Inngest SDK to handle defaults/env vars automatically
// This matches the working implementation in capture.ts
export const inngest = new Inngest({
  id: 'synap-api-commands',
});

const canPublish = Boolean(config.inngest.eventKey || config.server.nodeEnv !== 'production');

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

