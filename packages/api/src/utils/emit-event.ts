/**
 * Event Emission Utility
 * 
 * Centralizes the pattern of:
 * 1. Storing events in the event log (EventRepository)
 * 2. Publishing to Inngest for async processing
 * 
 * This eliminates duplication across all API routers.
 */

import { EventRepository } from "@synap/database";
import { db } from "@synap/database";

export interface EmitEventInput {
  /** Event type (e.g., "entities.create.requested") */
  type: string;
  
  /** Subject ID (the entity being acted upon) */
  subjectId: string;
  
  /** Subject type (e.g., "entity", "document", "workspace") */
  subjectType: string;
  
  /** Event payload data */
  data: Record<string, any>;
  
  /** User ID who initiated the action */
  userId: string;
}

/**
 * Emit a request event to both the event log and Inngest
 * 
 * @example
 * ```typescript
 * await emitRequestEvent({
 *   type: "entities.create.requested",
 *   subjectId: entityId,
 *   subjectType: "entity",
 *   data: { id: entityId, title: "...", ... },
 *   userId: ctx.userId,
 * });
 * ```
 */
export async function emitRequestEvent(input: EmitEventInput): Promise<void> {
  const { randomUUID } = await import("crypto");
  
  // 1. Store in event log for audit trail
  const eventRepo = new EventRepository(db.$client);
  await eventRepo.append({
    id: randomUUID(),
    version: "v1",
    type: input.type,
    subjectId: input.subjectId,
    subjectType: input.subjectType,
    data: input.data,
    userId: input.userId,
    source: "api",
    timestamp: new Date(),
    metadata: {},
  });

  // 2. Publish to Inngest for async processing (validation → execution)
  const { inngest } = await import("@synap/jobs");
  await inngest.send({
    name: input.type,
    data: input.data,
    user: { id: input.userId },
  });
}
