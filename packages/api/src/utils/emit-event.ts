/**
 * Event Emission Utility
 *
 * Centralizes the pattern of:
 * 1. Checking validation policy (should this be validated?)
 * 2. Routing to appropriate flow (fast-path vs standard)
 * 3. Storing events in the event log (EventRepository)
 * 4. Publishing to Inngest for async processing
 *
 * This eliminates duplication across all API routers.
 * Uses UnifiedEvent system for type safety.
 */

import { EventRepository, sql } from "@synap/database";
import { ValidationPolicyService } from "./validation-policy.js";
import { createUnifiedEvent, type UnifiedEventData } from "@synap/jobs";
import type { EventAction, SubjectType } from "@synap/jobs";
import type { EnhancedEventMetadata } from "@synap-core/core";

export interface EmitEventInput {
  /** Subject type (e.g., "entity", "document", "workspace") */
  subjectType: SubjectType | string;

  /** Action (e.g., "create", "update", "delete", or custom actions like "attach", "detach", "branch", "merge") */
  action: EventAction | string;

  /** Subject ID (the entity being acted upon) - optional for create */
  subjectId?: string;

  /** Event payload data */
  data: UnifiedEventData;

  /** User ID who initiated the action */
  userId: string;

  /** Workspace ID (for policy checks) */
  workspaceId?: string;

  /** Project ID (for policy checks) */
  projectId?: string;

  /** User role (for policy checks) */
  userRole?: string;

  /** Event source override (default: "api") */
  source?:
    | "api"
    | "automation"
    | "sync"
    | "migration"
    | "system"
    | "intelligence";

  /** Enhanced metadata */
  metadata?: EnhancedEventMetadata;
}

/**
 * Emit a request event with automatic validation routing
 *
 * This function:
 * 1. Checks validation policy
 * 2. Routes to appropriate flow (validated vs requested)
 * 3. Always logs to event repository
 *
 * Uses UnifiedEvent system for type safety.
 *
 * @example
 * ```typescript
 * await emitRequestEvent({
 *   subjectType: "entity",
 *   action: "create",
 *   subjectId: entityId,
 *   data: { id: entityId, title: "...", ... },
 *   userId: ctx.userId,
 *   workspaceId: ctx.workspaceId,
 * });
 * ```
 */
export async function emitRequestEvent(input: EmitEventInput): Promise<void> {
  const eventRepo = new EventRepository(sql);
  const { inngest } = await import("@synap/jobs");

  // Generate subjectId if not provided (for create operations)
  const subjectId = input.subjectId || input.data.id || "";

  // Check validation policy
  const policyService = new ValidationPolicyService();
  // Convert EventAction to the operation type expected by ValidationPolicyService
  const operation =
    input.action === "archive" || input.action === "restore"
      ? "update"
      : (input.action as "create" | "update" | "delete");

  const policyResult = await policyService.requiresValidation({
    operation,
    subjectType: input.subjectType,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    userRole: input.userRole,
  });

  // Build enhanced metadata
  const metadata: EnhancedEventMetadata = {
    ...input.metadata,
    validation: {
      validationPolicy: {
        source: policyResult.source, // ✅ Type-safe: matches ValidationMetadataSchema
        requiresValidation: policyResult.requiresValidation,
        reason: policyResult.reason,
      },
    },
    user: {
      action: "direct",
      platform: "web",
    },
  };

  if (policyResult.requiresValidation) {
    // STANDARD FLOW: requested → GlobalValidator → validated → executor

    // 1. Create unified requested event
    const requestedEvent = createUnifiedEvent({
      subjectType: input.subjectType as SubjectType,
      action: input.action as EventAction,
      phase: "requested",
      subjectId,
      data: input.data,
      metadata,
      userId: input.userId,
      source: input.source || "api",
    });

    // 2. Log to event repository
    // The event processor polls the DB and forwards requested events to Inngest.
    // Do NOT also call inngest.send() here — that would cause double processing.
    await eventRepo.append({
      id: requestedEvent.id,
      version: requestedEvent.version,
      type: requestedEvent.type,
      subjectId: requestedEvent.subjectId,
      subjectType: requestedEvent.subjectType,
      data: requestedEvent.data as Record<string, unknown>,
      metadata: requestedEvent.metadata as Record<string, unknown>,
      userId: requestedEvent.userId,
      source: requestedEvent.source as
        | "api"
        | "automation"
        | "sync"
        | "migration"
        | "system"
        | "intelligence",
      timestamp: requestedEvent.timestamp,
    });
  } else {
    // FAST PATH: Skip validation, go directly to executor

    // 1. Create unified validated event (skip requested)
    const validatedEvent = createUnifiedEvent({
      subjectType: input.subjectType as SubjectType,
      action: input.action as EventAction, // Cast to EventAction for createUnifiedEvent
      phase: "validated",
      subjectId,
      data: input.data,
      metadata: {
        ...metadata,
        validation: {
          ...metadata.validation,
          autoApproved: true,
          autoApproveReason: "Fast-path: No validation required",
        },
      },
      userId: input.userId,
      source: input.source || "api",
    });

    // 2. Log to event repository
    await eventRepo.append({
      id: validatedEvent.id,
      version: validatedEvent.version,
      type: validatedEvent.type,
      subjectId: validatedEvent.subjectId,
      subjectType: validatedEvent.subjectType,
      data: validatedEvent.data as Record<string, unknown>,
      metadata: validatedEvent.metadata as Record<string, unknown>,
      userId: validatedEvent.userId,
      source: validatedEvent.source as
        | "api"
        | "automation"
        | "sync"
        | "migration"
        | "system"
        | "intelligence",
      timestamp: validatedEvent.timestamp,
    });

    // 3. Send directly to executor (bypass GlobalValidator)
    await inngest.send({
      name: validatedEvent.type,
      data: validatedEvent.data,
      user: { id: input.userId },
    });
  }
}
