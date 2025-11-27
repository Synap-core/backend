/**
 * Ingestion Engine Inngest Function
 * 
 * ⚠️ DEPRECATED: This function has been moved to synap-intelligence-hub repository.
 * 
 * This file is kept for reference only. The Ingestion Engine is now part of
 * the proprietary Intelligence Hub and should not be used in the open-source Data Pod.
 * 
 * If you need ingestion capabilities, use the Intelligence Hub via Hub Protocol.
 */

// This function has been moved to synap-intelligence-hub
// import { inngest } from '../client.js';
// import { runIngestionEngine } from '@synap/intelligence-hub';
import { getEventRepository } from '@synap/database';
import { createLogger } from '@synap/core';
import type { SynapEvent } from '@synap/types';

const logger = createLogger({ module: 'ingestion-engine-worker' });

/**
 * Ingestion Engine Worker
 * 
 * ⚠️ DEPRECATED: This function has been moved to synap-intelligence-hub repository.
 * 
 * The Ingestion Engine is now part of the proprietary Intelligence Hub.
 * Use the Intelligence Hub via Hub Protocol instead.
 */
/*
export const ingestionEngineV1 = inngest.createFunction(
  {
    id: 'ingestion-engine-v1',
    name: 'Ingestion Engine V1',
    retries: 2, // Retry on failure
  },
  {
    event: 'api/thought.captured',
  },
  async ({ event, step }) => {
    const { content, context, userId, inputType } = event.data;

    if (!userId) {
      throw new Error('userId is required in api/thought.captured event');
    }

    // Use Inngest event ID as request ID and correlation ID
    // event.id is always defined for Inngest events, but TypeScript doesn't know that
    if (!event.id) {
      throw new Error('Event ID is required');
    }
    const requestId = event.id;
    const correlationId = event.id;

    logger.info({ 
      userId, 
      requestId,
      inputType: inputType || 'text',
      contentPreview: content.slice(0, 50),
    }, 'Processing captured thought');

    // Step 1: Run Ingestion Engine
    const result = await step.run('run-ingestion-engine', async () => {
      return await runIngestionEngine({
        rawContent: content,
        inputType: (inputType as 'text' | 'voice' | 'image') ?? 'text', // MVP: text only
        userId,
        context: context || {},
        requestId,
        correlationId,
      });
    });

    logger.info({ 
      eventsCount: result.events.length,
      connectionsCount: result.connections.length,
      entityType: result.analysis?.intent,
    }, 'Ingestion engine completed');

    // Step 2: Publish events to Inngest bus
    await step.run('publish-events', async () => {
      const eventRepo = getEventRepository();
      
      for (const synapEvent of result.events) {
        // Append to Event Store
        // Cast to ensure proper type (eventRepo expects SynapEvent with Date timestamp)
        // The timestamp from createSynapEvent is always a Date, but TypeScript may not infer it correctly
        // Use type assertion via unknown to bypass JsonifyObject type issues
        const eventToAppend = synapEvent as unknown as SynapEvent;
        await eventRepo.append(eventToAppend);

        // Publish to Inngest for projector processing
        // Use dynamic import to avoid circular dependency
        const { inngest: inngestClient } = await import('../client.js');
        
        // Ensure timestamp is a Date object for Inngest payload
        // createSynapEvent always returns Date, but we need to handle serialization
        const timestamp = eventToAppend.timestamp instanceof Date 
          ? eventToAppend.timestamp 
          : new Date(eventToAppend.timestamp as unknown as string | number | Date);
        
        await inngestClient.send({
          name: 'api/event.logged',
          data: {
            id: synapEvent.id,
            type: synapEvent.type,
            aggregateId: synapEvent.aggregateId,
            aggregateType: 'entity',
            userId: synapEvent.userId,
            version: 1,
            timestamp: timestamp.toISOString(),
            data: synapEvent.data,
            metadata: { 
              version: synapEvent.version, 
              requestId: synapEvent.requestId,
              source: 'ingestion-engine-v1',
            },
            source: synapEvent.source,
            causationId: synapEvent.causationId,
            correlationId: synapEvent.correlationId,
            requestId: synapEvent.requestId,
          },
        });
      }

      return { publishedCount: result.events.length };
    });

    return {
      status: 'completed',
      eventsCount: result.events.length,
      connectionsCount: result.connections.length,
      entityType: result.analysis?.intent,
    };
  }
);
*/

