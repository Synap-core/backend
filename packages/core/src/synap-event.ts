/**
 * SynapEvent v1 - The Immutable Event Contract
 *
 * This is the single source of truth for event structure in the Synap system.
 * All events must conform to this schema.
 *
 * Phase 1: Event Store Foundation
 * - Defines the core event contract
 * - Provides type-safe event creation
 * - Validates events before storage
 */

import { z } from "zod";
import { randomUUID } from "crypto";
import { ValidationError } from "./errors.js";

// ============================================================================
// CORE EVENT SCHEMA
// ============================================================================

/**
 * SynapEvent v1 Schema
 *
 * The immutable contract that all events must satisfy.
 * This schema is validated at the EventRepository level before insertion.
 */
export const SynapEventSchema = z.object({
  // Event Identity
  id: z.string().uuid(),
  version: z.literal("v1"), // Schema version for future migrations

  // Event Classification
  type: z.string().min(1).max(128), // e.g., 'note.creation.requested', 'task.completed'

  // Event Sourcing: What is this event about?
  subjectId: z.string().uuid().optional(), // Optional for system events
  subjectType: z.string().optional(), // e.g., 'tag', 'entity', 'document'

  // Event Data (the core payload - what happened)
  data: z.record(z.string(), z.unknown()), // Event payload (validated by specific event type schemas)

  // Event Metadata (extensible context - how/why it happened)
  // This is where AI enrichments, import context, sync info, etc. live
  metadata: z.record(z.string(), z.unknown()).optional(),

  // Ownership
  userId: z.string().min(1), // Required for multi-tenant isolation
  source: z
    .enum(["api", "automation", "sync", "migration", "system", "intelligence"])
    .default("api"),
  timestamp: z.date().default(() => new Date()),

  // Tracing
  correlationId: z.string().uuid().optional(), // For grouping related events
  causationId: z.string().uuid().optional(), // For event chains (A caused B)

  // Request Tracking (for async responses)
  requestId: z.string().uuid().optional(), // For linking API requests to events
});

export type SynapEvent = z.infer<typeof SynapEventSchema>;

// ============================================================================
// EVENT TYPE SCHEMAS
// ============================================================================

/**
 * Event Type Registry
 *
 * Each event type has its own data schema for validation.
 * This ensures type safety and validation at the event level.
 *
 * To add a new event type:
 * 1. Define its data schema here
 * 2. Add it to the EventTypeSchemas object
 * 3. Use validateEventData() to validate event data
 */
export const EventTypeSchemas = {
  // Entity creation intent
  "entities.create.requested": z.object({
    content: z.string().optional(),
    title: z.string().optional(),
    type: z.string().optional(), // note | task | project
    tags: z.array(z.string()).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),

  // Entity creation confirmed
  "entities.create.validated": z.object({
    entityId: z.string().uuid(),
    type: z.string(),
    filePath: z.string().optional(),
    fileUrl: z.string().url().optional(),
  }),

  // Entity update intent
  "entities.update.requested": z.object({
    entityId: z.string().uuid(),
    changes: z.record(z.string(), z.unknown()).optional(),
    content: z.string().optional(),
    title: z.string().optional(),
  }),

  // Entity update confirmed
  "entities.update.validated": z.object({
    entityId: z.string().uuid(),
    previousVersion: z.number().int().nonnegative().optional(),
    newVersion: z.number().int().positive().optional(),
  }),

  // Chat thread branch creation
  "chat_threads.branch.requested": z.object({
    parentThreadId: z.string().uuid(),
    branchPurpose: z.string(),
    agentId: z.string().optional(),
    agentType: z
      .enum([
        "default",
        "meta",
        "prompting",
        "knowledge-search",
        "code",
        "writing",
        "action",
      ])
      .optional(),
    agentConfig: z.record(z.string(), z.unknown()).optional(),
    inheritContext: z.boolean().default(true),
  }),

  // Chat thread branch creation confirmed
  "chat_threads.branch.validated": z.object({
    threadId: z.string().uuid(),
    parentThreadId: z.string().uuid(),
    branchPurpose: z.string(),
    agentId: z.string().optional(),
  }),

  // Chat thread merge
  "chat_threads.merge.requested": z.object({
    branchId: z.string().uuid(),
    parentThreadId: z.string().uuid(),
    summary: z.string().optional(),
  }),

  // Chat thread merge confirmed
  "chat_threads.merge.validated": z.object({
    branchId: z.string().uuid(),
    parentThreadId: z.string().uuid(),
    summary: z.string().optional(),
  }),

  // Chat thread archive
  "chat_threads.archive.requested": z.object({
    threadId: z.string().uuid(),
  }),

  // Chat thread archive confirmed
  "chat_threads.archive.validated": z.object({
    threadId: z.string().uuid(),
  }),

  // Thread entity linking (fast-path, no validation needed)
  "thread_entities.link.requested": z.object({
    threadId: z.string().uuid(),
    entityId: z.string().uuid(),
    relationshipType: z
      .enum([
        "used_as_context",
        "created",
        "updated",
        "referenced",
        "inherited_from_parent",
      ])
      .default("referenced"),
    sourceMessageId: z.string().uuid().optional(),
  }),

  // Thread document linking (fast-path, no validation needed)
  "thread_documents.link.requested": z.object({
    threadId: z.string().uuid(),
    documentId: z.string().uuid(),
    relationshipType: z
      .enum([
        "used_as_context",
        "created",
        "updated",
        "referenced",
        "inherited_from_parent",
      ])
      .default("referenced"),
    sourceMessageId: z.string().uuid().optional(),
  }),
} as const;

/**
 * Event Type for Schema Validation
 *
 * This is a subset of EventType from event-types.ts
 * Only event types with validation schemas are included here.
 */
export type EventTypeWithSchema = keyof typeof EventTypeSchemas;

/**
 * Validate event data against its type-specific schema
 *
 * @param eventType - The event type (must be in EventTypeSchemas)
 * @param data - The event data to validate
 * @returns Validated event data
 * @throws Error if event type is unknown or data is invalid
 */
export function validateEventData<T extends EventTypeWithSchema>(
  eventType: T,
  data: unknown
): z.infer<(typeof EventTypeSchemas)[T]> {
  const schema = EventTypeSchemas[eventType];
  if (!schema) {
    throw new ValidationError(
      `Unknown event type: ${eventType}. Add it to EventTypeSchemas.`,
      { eventType }
    );
  }
  return schema.parse(data) as z.infer<(typeof EventTypeSchemas)[T]>;
}

// ============================================================================
// EVENT FACTORY
// ============================================================================

/**
 * Create a SynapEvent with automatic ID and timestamp
 *
 * V0.6: Updated to accept EventType from EventTypes constant
 *
 * This factory function ensures all events are created with:
 * - Unique UUID
 * - Current timestamp
 * - Validated data (if event type has a schema in EventTypeSchemas)
 *
 * @param input - Event creation parameters
 * @returns Validated SynapEvent
 */
export function createSynapEvent(input: {
  type: string; // Accepts generated (e.g., 'entities.create.requested') and system event types
  data: Record<string, unknown>; // Event payload
  userId: string;
  subjectId?: string;
  subjectType?: string;
  source?: SynapEvent["source"];
  correlationId?: string;
  causationId?: string;
  requestId?: string;
  metadata?: Record<string, unknown>; // Optional metadata
}): SynapEvent {
  // Validate event data against type-specific schema if schema exists
  let validatedData: Record<string, unknown> = input.data;
  if (input.type in EventTypeSchemas) {
    try {
      validatedData = validateEventData(
        input.type as EventTypeWithSchema,
        input.data
      );
    } catch (error) {
      // If validation fails, log warning but continue (for backward compatibility)
      console.warn(`Event data validation failed for ${input.type}:`, error);
    }
  }

  return SynapEventSchema.parse({
    id: randomUUID(),
    version: "v1",
    type: input.type,
    subjectId: input.subjectId,
    subjectType: input.subjectType,
    data: validatedData,
    metadata: input.metadata,
    userId: input.userId,
    source: input.source || "api",
    timestamp: new Date(),
    correlationId: input.correlationId,
    causationId: input.causationId,
    requestId: input.requestId,
  });
}

/**
 * Create a SynapEvent from raw data (for deserialization)
 *
 * Use this when reading events from the database or receiving from external sources.
 * Validates the entire event structure.
 *
 * @param raw - Raw event data (may be from database or API)
 * @returns Validated SynapEvent
 * @throws Error if event is invalid
 */
export function parseSynapEvent(raw: unknown): SynapEvent {
  // Handle database timestamps (may be strings)
  const parsed =
    typeof raw === "object" && raw !== null && "timestamp" in raw
      ? {
          ...raw,
          timestamp:
            raw.timestamp instanceof Date
              ? raw.timestamp
              : new Date(raw.timestamp as string),
        }
      : raw;

  return SynapEventSchema.parse(parsed);
}
