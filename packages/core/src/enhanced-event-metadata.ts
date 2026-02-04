/**
 * Enhanced Event Metadata
 *
 * Captures HOW/WHY an event happened, not WHAT happened.
 * All sections optional - only include what's relevant.
 *
 * Extends the base EventMetadata with new sections for:
 * - Validation context (proposals, approvals)
 * - User context (session, device, platform)
 * - Message context (source message, thread)
 * - IoT context (future)
 * - Enterprise context (future)
 */

import { z } from "zod";
import type { EventMetadata } from "./event-metadata.js";

// ============================================================================
// VALIDATION METADATA (NEW)
// ============================================================================

export const ValidationMetadataSchema = z.object({
  proposalId: z.string().uuid().optional(), // If created from proposal
  proposalStatus: z.enum(["pending", "approved", "rejected"]).optional(),
  reviewedBy: z.string().optional(), // User ID who reviewed
  reviewedAt: z.coerce.date().optional(),
  reviewNotes: z.string().optional(),
  autoApproved: z.boolean().optional(), // Was it auto-approved?
  autoApproveReason: z.string().optional(), // Why auto-approved?
  validationPolicy: z
    .object({
      source: z.enum([
        "global-default",
        "workspace-preference",
        "system-override",
      ]),
      requiresValidation: z.boolean(),
      reason: z.string(),
    })
    .optional(),
});

export type ValidationMetadata = z.infer<typeof ValidationMetadataSchema>;

// ============================================================================
// USER METADATA (NEW)
// ============================================================================

export const UserMetadataSchema = z.object({
  action: z.enum(["direct", "via_proposal", "via_automation", "via_agent"]),
  sessionId: z.string().optional(), // User session
  deviceId: z.string().optional(), // Device used
  platform: z.enum(["web", "mobile", "cli", "api"]).optional(),
  ipAddress: z.string().optional(), // For audit
  userAgent: z.string().optional(),
});

export type UserMetadata = z.infer<typeof UserMetadataSchema>;

// ============================================================================
// MESSAGE METADATA (NEW)
// ============================================================================

export const MessageMetadataSchema = z.object({
  messageId: z.string().uuid(), // If created from message
  threadId: z.string().uuid(),
  messageRole: z.enum(["user", "assistant", "system"]),
  messageContent: z.string().optional(), // Snippet
  position: z
    .object({
      start: z.number(),
      end: z.number(),
    })
    .optional(),
});

export type MessageMetadata = z.infer<typeof MessageMetadataSchema>;

// ============================================================================
// ENHANCED AI METADATA (extends existing)
// ============================================================================

export const EnhancedAIMetadataSchema = z.object({
  // Base AI metadata (from event-metadata.ts)
  agent: z.string().min(1),
  agentType: z
    .enum(["orchestrator", "specialist", "tool", "user-proxy"])
    .optional(),

  // Confidence & Reasoning (enhanced)
  confidence: z
    .object({
      score: z.number().min(0).max(1),
      reasoning: z.string().optional(),
      factors: z
        .array(
          z.object({
            name: z.string(),
            weight: z.number(),
          })
        )
        .optional(),
    })
    .optional(),

  // Process Thoughts (NEW)
  processThoughts: z
    .array(
      z.object({
        step: z.number(),
        type: z.enum([
          "thinking",
          "planning",
          "decision",
          "observation",
          "tool_call",
        ]),
        content: z.string(),
        timestamp: z.coerce.date(),
        context: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .optional(),

  // Agent-to-Agent Communication (NEW)
  agentCall: z
    .object({
      callerAgent: z.string(),
      targetAgent: z.string(),
      purpose: z.string(),
      context: z.record(z.string(), z.unknown()),
      result: z.enum(["success", "failure", "partial"]).optional(),
      durationMs: z.number().optional(),
    })
    .optional(),

  // Extraction Context (existing, enhanced)
  extraction: z
    .object({
      extractedFrom: z.object({
        messageId: z.string().uuid(),
        threadId: z.string().uuid(),
        content: z.string().optional(),
        position: z
          .object({
            start: z.number(),
            end: z.number(),
          })
          .optional(),
      }),
      method: z.enum(["explicit", "implicit", "relationship", "pattern_match"]),
      confidence: z.number().min(0).max(1),
    })
    .optional(),

  // Reasoning Trace (existing, enhanced)
  reasoning: z
    .object({
      steps: z.array(
        z.object({
          type: z.enum([
            "thinking",
            "tool_call",
            "tool_result",
            "decision",
            "observation",
          ]),
          content: z.string(),
          timestamp: z.coerce.date(),
          toolName: z.string().optional(),
          toolResult: z.unknown().optional(),
        })
      ),
      outcome: z
        .object({
          action: z.string(),
          confidence: z.number().min(0).max(1),
          alternatives: z
            .array(
              z.object({
                action: z.string(),
                confidence: z.number().min(0).max(1),
              })
            )
            .optional(),
        })
        .optional(),
      durationMs: z.number().optional(),
      tokenCount: z.number().optional(),
    })
    .optional(),

  // Relationships (existing)
  relationships: z
    .array(
      z.object({
        targetEntityId: z.string().uuid(),
        type: z.string(),
        confidence: z.number().min(0).max(1),
        bidirectional: z.boolean().default(false),
      })
    )
    .optional(),

  // Classification (existing)
  classification: z
    .object({
      categories: z.array(
        z.object({
          name: z.string(),
          confidence: z.number().min(0).max(1),
        })
      ),
      tags: z.array(z.string()).optional(),
      method: z.enum(["embedding_similarity", "llm_analysis", "rule_based"]),
    })
    .optional(),

  // Inferred Properties (existing)
  inferredProperties: z.record(z.string(), z.unknown()).optional(),
});

export type EnhancedAIMetadata = z.infer<typeof EnhancedAIMetadataSchema>;

// ============================================================================
// IOT METADATA (NEW - Future)
// ============================================================================

export const IoTMetadataSchema = z.object({
  deviceId: z.string(),
  deviceType: z.string(),
  sensorType: z.string().optional(),
  location: z
    .object({
      lat: z.number(),
      lng: z.number(),
    })
    .optional(),
  reading: z.record(z.string(), z.unknown()).optional(), // Sensor data
  timestamp: z.coerce.date(),
});

export type IoTMetadata = z.infer<typeof IoTMetadataSchema>;

// ============================================================================
// ENTERPRISE METADATA (NEW - Future)
// ============================================================================

export const EnterpriseMetadataSchema = z.object({
  approvalChain: z
    .array(
      z.object({
        approverId: z.string(),
        role: z.string(),
        status: z.enum(["pending", "approved", "rejected"]),
        notes: z.string().optional(),
        timestamp: z.coerce.date(),
      })
    )
    .optional(),
  complianceChecks: z
    .array(
      z.object({
        checkType: z.string(),
        status: z.enum(["pass", "fail", "warning"]),
        details: z.string().optional(),
      })
    )
    .optional(),
  auditTrail: z
    .array(
      z.object({
        action: z.string(),
        performedBy: z.string(),
        timestamp: z.coerce.date(),
        details: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .optional(),
});

export type EnterpriseMetadata = z.infer<typeof EnterpriseMetadataSchema>;

// ============================================================================
// ENHANCED EVENT METADATA (Complete)
// ============================================================================

/**
 * Enhanced Event Metadata Schema
 *
 * Extends base EventMetadata with new sections for validation, user, message, IoT, and enterprise context.
 */
export const EnhancedEventMetadataSchema = z.object({
  // AI Context (enhanced)
  ai: EnhancedAIMetadataSchema.optional(),

  // Validation Context (NEW)
  validation: ValidationMetadataSchema.optional(),

  // User Context (NEW)
  user: UserMetadataSchema.optional(),

  // Message Context (NEW)
  message: MessageMetadataSchema.optional(),

  // Import Context (existing)
  import: z
    .object({
      source: z.enum([
        "notion",
        "obsidian",
        "roam",
        "logseq",
        "markdown",
        "csv",
        "api",
        "other",
      ]),
      externalId: z.string().optional(),
      externalUrl: z.string().url().optional(),
      importedAt: z.coerce.date(),
      batchId: z.string().uuid().optional(),
      transformed: z.boolean().default(false),
      transformationNotes: z.string().optional(),
    })
    .optional(),

  // Sync Context (existing)
  sync: z
    .object({
      deviceId: z.string(),
      platform: z.enum(["ios", "android", "web", "desktop", "cli"]),
      syncedAt: z.coerce.date(),
      offline: z.boolean().default(false),
      conflictResolution: z
        .enum(["client_wins", "server_wins", "merged"])
        .optional(),
    })
    .optional(),

  // Automation Context (existing)
  automation: z
    .object({
      ruleId: z.string().uuid(),
      ruleName: z.string(),
      trigger: z.object({
        type: z.string(),
        event: z.string().optional(),
        schedule: z.string().optional(),
      }),
      executionId: z.string().uuid().optional(),
    })
    .optional(),

  // IoT Context (NEW - Future)
  iot: IoTMetadataSchema.optional(),

  // Enterprise Context (NEW - Future)
  enterprise: EnterpriseMetadataSchema.optional(),

  // Custom Extensibility
  custom: z.record(z.string(), z.unknown()).optional(),
});

export type EnhancedEventMetadata = z.infer<typeof EnhancedEventMetadataSchema>;

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Convert base EventMetadata to EnhancedEventMetadata
 */
export function enhanceEventMetadata(
  metadata?: EventMetadata
): EnhancedEventMetadata | undefined {
  if (!metadata) return undefined;

  // Convert base AI metadata to enhanced format
  const enhancedAi = metadata.ai
    ? {
        agent: metadata.ai.agent,
        confidence: metadata.ai.confidence,
        extraction: metadata.ai.extraction
          ? {
              ...metadata.ai.extraction,
              extractedFrom: {
                ...metadata.ai.extraction.extractedFrom,
                position: undefined, // Add if available
              },
              confidence: 0.5, // Default confidence if not provided
            }
          : undefined,
        classification: metadata.ai.classification,
        relationships: metadata.ai.relationships?.relationships,
        reasoning: metadata.ai.reasoning
          ? {
              ...metadata.ai.reasoning,
              steps: metadata.ai.reasoning.steps.map((step) => ({
                ...step,
                timestamp: step.timestamp || new Date(),
                toolName: undefined,
                toolResult: undefined,
              })),
              outcome: metadata.ai.reasoning.outcome
                ? {
                    ...metadata.ai.reasoning.outcome,
                    alternatives: metadata.ai.reasoning.outcome.alternatives
                      ? metadata.ai.reasoning.outcome.alternatives.map((alt) =>
                          typeof alt === "string"
                            ? { action: alt, confidence: 0.5 }
                            : alt
                        )
                      : undefined,
                  }
                : undefined,
            }
          : undefined,
        inferredProperties: metadata.ai.inferredProperties,
      }
    : undefined;

  return {
    ...metadata,
    ai: enhancedAi,
  };
}

/**
 * Check if metadata has validation context
 */
export function hasValidationMetadata(
  metadata: unknown
): metadata is EnhancedEventMetadata & { validation: ValidationMetadata } {
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    "validation" in metadata &&
    typeof (metadata as any).validation === "object"
  );
}

/**
 * Check if metadata has message context
 */
export function hasMessageMetadata(
  metadata: unknown
): metadata is EnhancedEventMetadata & { message: MessageMetadata } {
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    "message" in metadata &&
    typeof (metadata as any).message === "object"
  );
}
