/**
 * Enrichment Projector
 *
 * Processes enrichment events and updates materialized tables.
 * This is an event handler that keeps projections in sync with events.
 *
 * @module @synap/database/projectors/enrichment-projector
 */

import { db } from "../client-pg.js";
import {
  entityEnrichments,
  entityRelationships,
  reasoningTraces,
} from "../schema/enrichments.js";
import type { SynapEvent } from "@synap-core/core";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "enrichment-projector" });

/**
 * Process an enrichment event and update projections
 *
 * This function is idempotent - processing the same event twice
 * will not create duplicate records.
 *
 * @param event - The SynapEvent to process
 * @returns true if the event was processed, false if skipped
 */
export async function projectEnrichmentEvent(
  event: SynapEvent,
): Promise<boolean> {
  // Only process enrichment events
  if (!event.type.startsWith("enrichment.")) {
    return false;
  }

  try {
    switch (event.type) {
      case "enrichment.entity.extracted":
        await projectEntityExtracted(event);
        break;

      case "enrichment.entity.properties.inferred":
        await projectPropertiesInferred(event);
        break;

      case "enrichment.entity.relationships.discovered":
        await projectRelationshipDiscovered(event);
        break;

      case "enrichment.entity.classified":
        await projectEntityClassified(event);
        break;

      case "enrichment.knowledge.extracted":
        await projectKnowledgeExtracted(event);
        break;

      case "enrichment.reasoning.recorded":
        await projectReasoningRecorded(event);
        break;

      default:
        logger.warn({ eventType: event.type }, "Unknown enrichment event type");
        return false;
    }

    logger.info(
      {
        eventId: event.id,
        eventType: event.type,
        userId: event.userId,
      },
      "Enrichment event projected",
    );

    return true;
  } catch (error) {
    logger.error(
      {
        err: error,
        eventId: event.id,
        eventType: event.type,
      },
      "Failed to project enrichment event",
    );
    throw error;
  }
}

/**
 * Project entity extraction event
 */
async function projectEntityExtracted(event: SynapEvent): Promise<void> {
  const data = event.data as {
    entityId: string;
    sourceMessageId: string;
    sourceThreadId: string;
    extractedBy: string;
    confidence: number;
    extractionMethod: string;
    reasoningTrace?: string;
  };

  await db
    .insert(entityEnrichments)
    .values({
      entityId: data.entityId,
      enrichmentType: "extraction",
      sourceEventId: event.id,
      agentId: data.extractedBy,
      confidence: String(data.confidence),
      data: {
        sourceMessageId: data.sourceMessageId,
        sourceThreadId: data.sourceThreadId,
        extractionMethod: data.extractionMethod,
        reasoningTrace: data.reasoningTrace,
      },
      userId: event.userId,
    })
    .onConflictDoNothing(); // Idempotent
}

/**
 * Project properties inferred event
 */
async function projectPropertiesInferred(event: SynapEvent): Promise<void> {
  const data = event.data as {
    entityId: string;
    properties: Record<string, unknown>;
    inferredBy: string;
    confidence: number;
    trigger: string;
  };

  await db
    .insert(entityEnrichments)
    .values({
      entityId: data.entityId,
      enrichmentType: "properties",
      sourceEventId: event.id,
      agentId: data.inferredBy,
      confidence: String(data.confidence),
      data: {
        properties: data.properties,
        trigger: data.trigger,
      },
      userId: event.userId,
    })
    .onConflictDoNothing();
}

/**
 * Project relationship discovered event
 */
async function projectRelationshipDiscovered(event: SynapEvent): Promise<void> {
  const data = event.data as {
    sourceEntityId: string;
    targetEntityId: string;
    relationshipType: string;
    discoveredBy: string;
    confidence: number;
    bidirectional: boolean;
    context?: string;
  };

  // Insert the primary relationship
  await db
    .insert(entityRelationships)
    .values({
      sourceEntityId: data.sourceEntityId,
      targetEntityId: data.targetEntityId,
      relationshipType: data.relationshipType as any,
      sourceEventId: event.id,
      agentId: data.discoveredBy,
      confidence: String(data.confidence),
      context: data.context,
      userId: event.userId,
    })
    .onConflictDoNothing(); // Prevent duplicates

  // If bidirectional, insert the reverse relationship
  if (data.bidirectional) {
    await db
      .insert(entityRelationships)
      .values({
        sourceEntityId: data.targetEntityId,
        targetEntityId: data.sourceEntityId,
        relationshipType: data.relationshipType as any,
        sourceEventId: event.id,
        agentId: data.discoveredBy,
        confidence: String(data.confidence),
        context: data.context,
        userId: event.userId,
      })
      .onConflictDoNothing();
  }
}

/**
 * Project entity classified event
 */
async function projectEntityClassified(event: SynapEvent): Promise<void> {
  const data = event.data as {
    entityId: string;
    classifications: Array<{
      category: string;
      confidence: number;
      tags?: string[];
    }>;
    classifiedBy: string;
    method: string;
  };

  await db
    .insert(entityEnrichments)
    .values({
      entityId: data.entityId,
      enrichmentType: "classification",
      sourceEventId: event.id,
      agentId: data.classifiedBy,
      confidence: String(
        Math.max(...data.classifications.map((c) => c.confidence)),
      ),
      data: {
        classifications: data.classifications,
        method: data.method,
      },
      userId: event.userId,
    })
    .onConflictDoNothing();
}

/**
 * Project knowledge extracted event
 */
async function projectKnowledgeExtracted(event: SynapEvent): Promise<void> {
  const data = event.data as {
    fact: string;
    factType: string;
    sourceEntityId?: string;
    sourceMessageId?: string;
    extractedBy: string;
    confidence: number;
  };

  // If there's a source entity, create an enrichment for it
  if (data.sourceEntityId) {
    await db
      .insert(entityEnrichments)
      .values({
        entityId: data.sourceEntityId,
        enrichmentType: "knowledge",
        sourceEventId: event.id,
        agentId: data.extractedBy,
        confidence: String(data.confidence),
        data: {
          fact: data.fact,
          factType: data.factType,
          sourceMessageId: data.sourceMessageId,
        },
        userId: event.userId,
      })
      .onConflictDoNothing();
  }
}

/**
 * Project reasoning recorded event
 */
async function projectReasoningRecorded(event: SynapEvent): Promise<void> {
  const data = event.data as {
    subjectType: string;
    subjectId: string;
    agentId: string;
    steps: Array<{
      type: string;
      content: string;
      timestamp: Date;
      metadata?: Record<string, unknown>;
    }>;
    outcome: {
      action: string;
      confidence: number;
      alternatives?: string[];
    };
    metrics?: {
      totalDurationMs: number;
      tokenCount?: number;
      toolCallCount?: number;
    };
  };

  await db
    .insert(reasoningTraces)
    .values({
      subjectType: data.subjectType as any,
      subjectId: data.subjectId,
      sourceEventId: event.id,
      agentId: data.agentId,
      steps: data.steps,
      outcome: data.outcome,
      metrics: data.metrics,
      userId: event.userId,
    })
    .onConflictDoNothing();
}

/**
 * Rebuild all enrichment projections from events
 *
 * Use this for disaster recovery or schema migrations.
 *
 * @param fromTimestamp - Optional start timestamp (for incremental rebuilds)
 */
export async function rebuildEnrichmentProjections(
  fromTimestamp?: Date,
): Promise<{ processed: number; errors: number }> {
  const { events } = await import("../schema/events.js");
  const { asc, like } = await import("drizzle-orm");

  logger.info({ fromTimestamp }, "Starting enrichment projection rebuild");

  // Get all enrichment events
  const query = db.query.events.findMany({
    where: like(events.type, "enrichment.%"),
    orderBy: [asc(events.timestamp)],
  });

  let processed = 0;
  let errors = 0;

  // Note: In production, this should use a cursor-based approach
  // for large datasets to avoid memory issues
  const allEvents = await query;

  for (const event of allEvents) {
    try {
      // Convert to SynapEvent format
      const synapEvent: SynapEvent = {
        id: event.id,
        version: "v1",
        type: event.type,
        data: event.data as Record<string, unknown>,
        userId: event.userId,
        source: (event.source || "api") as SynapEvent["source"],
        timestamp: event.timestamp,
        correlationId: event.correlationId || undefined,
      };

      if (fromTimestamp && event.timestamp < fromTimestamp) {
        continue;
      }

      await projectEnrichmentEvent(synapEvent);
      processed++;
    } catch (error) {
      logger.error({ err: error, eventId: event.id }, "Error rebuilding event");
      errors++;
    }
  }

  logger.info({ processed, errors }, "Enrichment projection rebuild complete");

  return { processed, errors };
}
