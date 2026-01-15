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
 */

import { EventRepository } from "@synap/database";
import { db } from "@synap/database";
import { ValidationPolicyService } from "./validation-policy.js";

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
  
  /** Workspace ID (for policy checks) */
  workspaceId?: string;
  
  /** Project ID (for policy checks) */
  projectId?: string;
  
  /** User role (for policy checks) */
  userRole?: string;
}

/**
 * Emit a request event with automatic validation routing
 * 
 * This function:
 * 1. Checks validation policy
 * 2. Routes to appropriate flow (validated vs requested)
 * 3. Always logs to event repository
 * 
 * @example
 * ```typescript
 * await emitRequestEvent({
 *   type: "entities.create.requested",
 *   subjectId: entityId,
 *   subjectType: "entity",
 *   data: { id: entityId, title: "...", ... },
 *   userId: ctx.userId,
 *   workspaceId: ctx.workspaceId,
 * });
 * ```
 */
export async function emitRequestEvent(input: EmitEventInput): Promise<void> {
  const { randomUUID } = await import("crypto");
  const eventRepo = new EventRepository(db.$client);
  const { inngest } = await import("@synap/jobs");
  
  // Extract operation from event type (e.g., "entities.create.requested" → "create")
  const parts = input.type.split('.');
  const operation = parts[1] as 'create' | 'update' | 'delete';
  
  // Check validation policy
  const policyService = new ValidationPolicyService();
  const policyResult = await policyService.requiresValidation({
    operation,
    subjectType: input.subjectType,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    userRole: input.userRole,
  });
  
  if (policyResult.requiresValidation) {
    // STANDARD FLOW: requested → GlobalValidator → validated → executor
    
    // 1. Log requested event
    await eventRepo.append({
      id: randomUUID(),
      version: "v1",
      type: input.type, // e.g., "entities.create.requested"
      subjectId: input.subjectId,
      subjectType: input.subjectType,
      data: input.data,
      userId: input.userId,
      source: "api",
      timestamp: new Date(),
      metadata: {
        validationPolicy: policyResult.reason,
        policySource: policyResult.source,
      },
    });
    
    // 2. Send to GlobalValidator
    await inngest.send({
      name: input.type,
      data: input.data,
      user: { id: input.userId },
    });
  } else {
    // FAST PATH: Skip validation, go directly to executor
    
    const validatedType = input.type.replace('.requested', '.validated');
    
    // 1. Log validated event (skip requested)
    await eventRepo.append({
      id: randomUUID(),
      version: "v1",
      type: validatedType, // e.g., "entities.create.validated"
      subjectId: input.subjectId,
      subjectType: input.subjectType,
      data: input.data,
      userId: input.userId,
      source: "api",
      timestamp: new Date(),
      metadata: {
        validationPolicy: policyResult.reason,
        policySource: policyResult.source,
        fastPath: true, // Flag for audit
      },
    });
    
    // 2. Send directly to executor (bypass GlobalValidator)
    await inngest.send({
      name: validatedType,
      data: input.data,
      user: { id: input.userId },
    });
  }
}
