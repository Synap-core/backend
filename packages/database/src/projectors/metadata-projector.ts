/**
 * Metadata Projector
 * 
 * Processes event metadata and updates materialized tables.
 * 
 * This projector extracts AI metadata from regular events (entity.created, etc.)
 * and materializes them for efficient querying.
 * 
 * Key Pattern:
 * - Events are the source of truth
 * - Metadata provides context (AI, import, sync)
 * - Projections optimize query performance
 * 
 * @module @synap/database/projectors/metadata-projector
 */

import { db } from '../client-pg.js';
import { entityEnrichments, entityRelationships, reasoningTraces } from '../schema/enrichments.js';
import type { SynapEvent, EventMetadata } from '@synap-core/core';
import { createLogger } from '@synap-core/core';

const logger = createLogger({ module: 'metadata-projector' });

/**
 * Check if metadata has AI context
 */
function hasAIMetadata(metadata: unknown): metadata is EventMetadata & { ai: NonNullable<EventMetadata['ai']> } {
  return (
    typeof metadata === 'object' &&
    metadata !== null &&
    'ai' in metadata &&
    typeof (metadata as any).ai === 'object' &&
    (metadata as any).ai !== null
  );
}

/**
 * Process an event and extract any AI metadata into projections
 * 
 * This function is called for ALL events and only projects when
 * AI metadata is present.
 * 
 * @param event - The SynapEvent to process
 * @returns true if AI metadata was projected, false otherwise
 */
export async function projectEventMetadata(event: SynapEvent): Promise<boolean> {
  // Only process events with AI metadata
  if (!event.metadata || !hasAIMetadata(event.metadata)) {
    return false;
  }

  const ai = event.metadata.ai;
  const entityId = event.aggregateId;

  // Must have an aggregate ID (entity) to project enrichments
  if (!entityId) {
    logger.debug({ eventId: event.id, eventType: event.type }, 'Event has AI metadata but no aggregateId');
    return false;
  }

  try {
    // Project extraction metadata
    if (ai.extraction) {
      await db.insert(entityEnrichments).values({
        entityId,
        enrichmentType: 'extraction',
        sourceEventId: event.id,
        agentId: ai.agent,
        confidence: String(ai.confidence?.score ?? 0.5),
        data: {
          sourceMessageId: ai.extraction.extractedFrom.messageId,
          sourceThreadId: ai.extraction.extractedFrom.threadId,
          extractionMethod: ai.extraction.method,
          content: ai.extraction.extractedFrom.content,
        },
        userId: event.userId,
      }).onConflictDoNothing();
    }

    // Project classification metadata
    if (ai.classification) {
      await db.insert(entityEnrichments).values({
        entityId,
        enrichmentType: 'classification',
        sourceEventId: event.id,
        agentId: ai.agent,
        confidence: String(Math.max(...ai.classification.categories.map(c => c.confidence), 0)),
        data: {
          categories: ai.classification.categories,
          tags: ai.classification.tags,
          method: ai.classification.method,
        },
        userId: event.userId,
      }).onConflictDoNothing();
    }

    // Project inferred properties
    if (ai.inferredProperties) {
      await db.insert(entityEnrichments).values({
        entityId,
        enrichmentType: 'properties',
        sourceEventId: event.id,
        agentId: ai.agent,
        confidence: String(ai.confidence?.score ?? 0.5),
        data: {
          properties: ai.inferredProperties,
        },
        userId: event.userId,
      }).onConflictDoNothing();
    }

    // Project relationships
    if (ai.relationships) {
      for (const rel of ai.relationships.relationships) {
        await db.insert(entityRelationships).values({
          sourceEntityId: entityId,
          targetEntityId: rel.targetEntityId,
          relationshipType: rel.type as any,
          sourceEventId: event.id,
          agentId: ai.agent,
          confidence: String(rel.confidence),
          userId: event.userId,
        }).onConflictDoNothing();

        // If bidirectional, insert reverse
        if (rel.bidirectional) {
          await db.insert(entityRelationships).values({
            sourceEntityId: rel.targetEntityId,
            targetEntityId: entityId,
            relationshipType: rel.type as any,
            sourceEventId: event.id,
            agentId: ai.agent,
            confidence: String(rel.confidence),
            userId: event.userId,
          }).onConflictDoNothing();
        }
      }
    }

    // Project reasoning traces
    if (ai.reasoning) {
      await db.insert(reasoningTraces).values({
        subjectType: 'entity',
        subjectId: entityId,
        sourceEventId: event.id,
        agentId: ai.agent,
        steps: ai.reasoning.steps,
        outcome: ai.reasoning.outcome ?? { action: 'unknown', confidence: 0 },
        metrics: ai.reasoning.durationMs ? { totalDurationMs: ai.reasoning.durationMs } : undefined,
        userId: event.userId,
      }).onConflictDoNothing();
    }

    logger.info({
      eventId: event.id,
      eventType: event.type,
      entityId,
      agent: ai.agent,
    }, 'AI metadata projected');

    return true;
  } catch (error) {
    logger.error({
      err: error,
      eventId: event.id,
      eventType: event.type,
    }, 'Failed to project AI metadata');
    throw error;
  }
}

/**
 * Rebuild all projections from events with AI metadata
 * 
 * Use this for disaster recovery or schema migrations.
 * 
 * @param fromTimestamp - Optional start timestamp (for incremental rebuilds)
 */
export async function rebuildMetadataProjections(
  fromTimestamp?: Date
): Promise<{ processed: number; projected: number; errors: number }> {
  const { events } = await import('../schema/events.js');
  const { asc, isNotNull } = await import('drizzle-orm');

  logger.info({ fromTimestamp }, 'Starting metadata projection rebuild');

  // Get all events with metadata
  const allEvents = await db.query.events.findMany({
    where: isNotNull(events.metadata),
    orderBy: [asc(events.timestamp)],
  });

  let processed = 0;
  let projected = 0;
  let errors = 0;

  for (const event of allEvents) {
    try {
      if (fromTimestamp && event.timestamp < fromTimestamp) {
        continue;
      }

      // Convert to SynapEvent format
      const synapEvent: SynapEvent = {
        id: event.id,
        version: 'v1',
        type: event.type,
        data: event.data as Record<string, unknown>,
        metadata: event.metadata as Record<string, unknown>,
        userId: event.userId,
        source: (event.source || 'api') as SynapEvent['source'],
        timestamp: event.timestamp,
        correlationId: event.correlationId || undefined,
      };

      processed++;
      
      const wasProjected = await projectEventMetadata(synapEvent);
      if (wasProjected) {
        projected++;
      }
    } catch (error) {
      logger.error({ err: error, eventId: event.id }, 'Error rebuilding event');
      errors++;
    }
  }

  logger.info({ processed, projected, errors }, 'Metadata projection rebuild complete');

  return { processed, projected, errors };
}
