/**
 * Hub Insights Router
 * 
 * Receives insights from Intelligence Hub via Hub Protocol.
 * Converts HubInsight actions to SynapEvents and publishes them to Inngest.
 * 
 * Endpoint: POST /hub/insights
 * Authentication: Hub Protocol OAuth2 token (from Intelligence Hub)
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { HubInsightSchema, type HubInsight } from '@synap/hub-protocol';
import { createSynapEvent } from '@synap/types';
import { inngest } from '@synap/jobs';
import { createLogger } from '@synap/core';
import { randomUUID } from 'crypto';

const logger = createLogger({ module: 'hub-insights-api' });

// ============================================================================
// REQUEST SCHEMA
// ============================================================================

const InsightsRequestSchema = z.object({
  insights: z.array(HubInsightSchema),
  // Optional: Request metadata
  meta: z.object({
    hubId: z.string().optional(),
    timestamp: z.string().optional(),
  }).optional(),
});

type InsightsRequest = z.infer<typeof InsightsRequestSchema>;

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Map HubInsight action to SynapEvent type
 */
function getEventTypeFromAction(action: NonNullable<HubInsight['actions']>[0]): string {
  if (action.eventType === 'create_entity') {
    // Check data for entity type if needed, or assume it's in eventType
    // But based on schema, eventType IS the event type (e.g. 'task.creation.requested')
    return action.eventType;
  }
  
  // If eventType is already a valid event type, return it
  return action.eventType;
}

/**
 * Convert HubInsight action to SynapEvent data
 */
function actionToEventData(action: NonNullable<HubInsight['actions']>[0], insight: HubInsight): Record<string, unknown> {
  // Base data from action
  const baseData = {
    ...action.data,
  };
  
  // Add insight metadata for context
  // Note: HubInsight schema doesn't have top-level title/description
  // We can use analysis title if available
  if (insight.analysis?.title) {
    baseData.insightTitle = insight.analysis.title;
  }
  
  // Add metadata if present
  if (insight.metadata) {
    baseData.insightMetadata = insight.metadata;
  }
  
  return baseData;
}

// ============================================================================
// ROUTER
// ============================================================================

export const hubInsightsRouter = new Hono();

/**
 * POST /hub/insights
 * 
 * Receives insights from Intelligence Hub and converts them to events.
 * 
 * Request Body:
 * {
 *   "insights": [
 *     {
 *       "version": "1.0",
 *       "type": "action_plan",
 *       "correlationId": "uuid",
 *       "title": "Create note",
 *       "description": "...",
 *       "actions": [
 *         {
 *           "type": "create_entity",
 *           "entityType": "note",
 *           "data": { ... }
 *         }
 *       ]
 *     }
 *   ]
 * }
 * 
 * Response:
 * {
 *   "success": true,
 *   "eventsPublished": 2,
 *   "eventIds": ["uuid1", "uuid2"]
 * }
 */
hubInsightsRouter.post('/hub/insights', async (c) => {
  try {
    // 1. Parse and validate request
    const body = await c.req.json();
    const request: InsightsRequest = InsightsRequestSchema.parse(body);
    
    logger.info(
      { 
        insightsCount: request.insights.length,
        hubId: request.meta?.hubId,
      },
      'Received insights from Intelligence Hub'
    );
    
    // 2. Get userId from auth context (set by auth middleware)
    const userId = c.get('userId' as any) as string;
    if (!userId) {
      logger.error('No userId found in auth context');
      return c.json({ error: 'Unauthorized' }, 401);
    }
    
    // 3. Convert each insight to events
    const eventIds: string[] = [];
    // Define Action type helper since HubInsight['actions'] is optional
    type HubAction = NonNullable<HubInsight['actions']>[0];
    const failedActions: Array<{ action: HubAction; error: string }> = [];
    
    for (const insight of request.insights) {
      const actions = insight.actions || [];
      
      logger.debug(
        { 
          insightType: insight.type,
          actionsCount: actions.length,
          correlationId: insight.correlationId,
        },
        'Processing insight'
      );
      
      for (const action of actions) {
        try {
          // 4. Map action type to event type
          const eventType = getEventTypeFromAction(action);
          
          // 5. Extract or generate aggregateId
          const aggregateId = (action.data.entityId as string) || 
                            (action.data.id as string) || 
                            randomUUID();
          
          // 6. Convert action data to event data
          const eventData = actionToEventData(action, insight);
          
          // 7. Create SynapEvent
          const event = createSynapEvent({
            type: eventType as any, // Cast to any/EventType as dynamic string might not match strict enum
            userId,
            aggregateId,
            data: eventData,
            source: 'automation',
            correlationId: insight.correlationId,
            causationId: insight.metadata?.eventId as string | undefined,
          });
          
          logger.debug(
            {
              eventType,
              eventId: event.id,
              aggregateId,
              actionType: action.eventType,
            },
            'Created SynapEvent from action'
          );
          
          // 8. Publish to Inngest
          await inngest.send({
            name: 'api/event.logged',
            data: {
              id: event.id,
              type: event.type,
              aggregateId: event.aggregateId,
              aggregateType: 'entity',
              userId: event.userId,
              version: 1,
              timestamp: event.timestamp.toISOString(),
              data: event.data,
              metadata: { 
                version: event.version,
                requestId: event.requestId,
              },
              source: event.source,
              causationId: event.causationId,
              correlationId: event.correlationId,
            },
          });
          
          eventIds.push(event.id);
          
          logger.info(
            {
              eventId: event.id,
              eventType,
              aggregateId,
            },
            'Published event to Inngest'
          );
        } catch (error) {
          logger.error(
            { 
              err: error,
              action: action.eventType,
              actionData: action.data,
            },
            'Failed to process action'
          );
          
          failedActions.push({
            action,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }
    }
    
    // 9. Return response
    const response = {
      success: true,
      eventsPublished: eventIds.length,
      eventIds,
      ...(failedActions.length > 0 && {
        failedActions: failedActions.map(f => ({
          type: f.action.eventType,
          error: f.error,
        })),
      }),
    };
    
    logger.info(
      {
        eventsPublished: eventIds.length,
        failedActions: failedActions.length,
      },
      'Insights processed successfully'
    );
    
    return c.json(response);
  } catch (error) {
    logger.error({ err: error }, 'Error processing insights');
    
    if (error instanceof z.ZodError) {
      return c.json(
        {
          error: 'Validation error',
          details: error.errors,
        },
        400
      );
    }
    
    return c.json(
      {
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      500
    );
  }
});
