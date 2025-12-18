/**
 * Hub Insight Transformation
 * 
 * Transforms HubInsight into SynapEvent objects
 */

import type { HubInsight } from '@synap/hub-protocol';
import { createSynapEvent } from '@synap/core';
import type { EventType } from '@synap/events';
import { isValidEventType } from '@synap/events';
import { ValidationError } from '@synap/core';
import { createLogger } from '@synap/core';

const logger = createLogger({ module: 'hub-transform' });

/**
 * Transform a HubInsight into SynapEvent objects
 * 
 * @param insight - The insight to transform
 * @param userId - User ID
 * @param requestId - Request ID (for correlation)
 * @returns Array of SynapEvent objects
 * @throws ValidationError if insight cannot be transformed
 */
export function transformInsightToEvents(
  insight: HubInsight,
  userId: string,
  requestId: string
): Array<ReturnType<typeof createSynapEvent>> {
  const events: Array<ReturnType<typeof createSynapEvent>> = [];
  
  // Verify that the insight type is supported
  if (insight.type !== 'action_plan' && insight.type !== 'automation') {
    throw new ValidationError(
      `Insight type '${insight.type}' cannot be transformed into events. Only 'action_plan' and 'automation' are supported.`,
      { insightType: insight.type }
    );
  }
  
  // If no actions, return empty array
  if (!insight.actions || insight.actions.length === 0) {
    logger.warn({ insightType: insight.type }, 'Insight has no actions to transform');
    return events;
  }
  
  // Transform each action into an event
  for (const [index, action] of insight.actions.entries()) {
    // Validate that the event type is valid
    if (!isValidEventType(action.eventType)) {
      throw new ValidationError(
        `Invalid event type: '${action.eventType}'. Action index: ${index}`,
        { eventType: action.eventType, actionIndex: index }
      );
    }
    
    // Create the event
    const event = createSynapEvent({
      type: action.eventType as EventType,
      data: action.data,
      userId,
      aggregateId: action.aggregateId,
      source: 'automation', // Hub insights are considered automations
      correlationId: insight.correlationId,
      requestId,
      metadata: {
        ...action.metadata,
        requiresConfirmation: action.requiresConfirmation,
        priority: action.priority,
        hubInsightType: insight.type,
        hubConfidence: insight.confidence,
        hubReasoning: insight.reasoning,
      },
    });
    
    events.push(event);
  }
  
  logger.debug({ 
    insightType: insight.type, 
    eventsCount: events.length 
  }, 'Transformed insight to events');
  
  return events;
}

