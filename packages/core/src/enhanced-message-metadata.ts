/**
 * Enhanced Message Metadata
 *
 * Captures everything about a message: AI reasoning, links, approval context, etc.
 * Extends ConversationMessageMetadata with new sections.
 */

import { z } from "zod";
import { randomUUID } from "crypto";
import type { ConversationMessageMetadata } from "./types/agent-state.js";

// ============================================================================
// AI CONTEXT (Enhanced)
// ============================================================================

export const EnhancedAIMessageMetadataSchema = z.object({
  agent: z.string().min(1),
  agentType: z
    .enum(["orchestrator", "specialist", "tool", "user-proxy"])
    .optional(),

  // Multi-step reasoning (NEW)
  steps: z
    .array(
      z.object({
        step: z.number(),
        type: z.enum([
          "thinking",
          "planning",
          "tool_call",
          "tool_result",
          "decision",
          "observation",
        ]),
        content: z.string(),
        timestamp: z.coerce.date(),
        toolName: z.string().optional(),
        toolInput: z.unknown().optional(),
        toolResult: z.unknown().optional(),
        durationMs: z.number().optional(),
      })
    )
    .optional(),

  // Process thoughts (NEW)
  processThoughts: z
    .array(
      z.object({
        step: z.number(),
        type: z.enum(["thinking", "planning", "decision"]),
        content: z.string(),
        timestamp: z.coerce.date(),
        context: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .optional(),

  // Agent-to-agent calls (NEW)
  agentCalls: z
    .array(
      z.object({
        targetAgent: z.string(),
        purpose: z.string(),
        context: z.record(z.string(), z.unknown()),
        result: z.enum(["success", "failure", "partial"]).optional(),
        durationMs: z.number().optional(),
      })
    )
    .optional(),

  // Confidence & Reasoning
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

  // Token usage
  usage: z
    .object({
      promptTokens: z.number(),
      completionTokens: z.number(),
      totalTokens: z.number(),
    })
    .optional(),
});

export type EnhancedAIMessageMetadata = z.infer<
  typeof EnhancedAIMessageMetadataSchema
>;

// ============================================================================
// APPROVAL CONTEXT (NEW)
// ============================================================================

export const ApprovalMetadataSchema = z.object({
  proposalId: z.string().uuid().optional(), // If this message approves/rejects a proposal
  proposalAction: z.enum(["approve", "reject", "request_changes"]).optional(),
  reviewNotes: z.string().optional(),
  reviewedBy: z.string().optional(), // User ID
  reviewedAt: z.coerce.date().optional(),
});

export type ApprovalMetadata = z.infer<typeof ApprovalMetadataSchema>;

// ============================================================================
// LINKS (NEW - Denormalized for performance)
// ============================================================================

export const MessageLinkMetadataSchema = z.object({
  targetType: z.string(),
  targetId: z.string().uuid(),
  relationshipType: z.string(),
  position: z
    .object({
      start: z.number(),
      end: z.number(),
    })
    .optional(),
});

export type MessageLinkMetadata = z.infer<typeof MessageLinkMetadataSchema>;

// ============================================================================
// ENHANCED MESSAGE METADATA (Complete)
// ============================================================================

/**
 * Enhanced Message Metadata Schema
 *
 * Extends ConversationMessageMetadata with new sections for:
 * - Enhanced AI context (steps, process thoughts, agent calls)
 * - Approval context (proposals, reviews)
 * - Links (denormalized for performance)
 * - Entity extraction (enhanced)
 * - Proposals (enhanced)
 * - Attachments
 */
export const EnhancedMessageMetadataSchema = z.object({
  // AI Context (enhanced)
  ai: EnhancedAIMessageMetadataSchema.optional(),

  // Approval Context (NEW)
  approval: ApprovalMetadataSchema.optional(),

  // Links (NEW - Denormalized)
  links: z.array(MessageLinkMetadataSchema).optional(),

  // Entity Extraction (existing, enhanced)
  entities: z
    .array(
      z.object({
        entityId: z.string().uuid(),
        entityType: z.string(),
        confidence: z.number(),
        extractionMethod: z.enum(["explicit", "implicit", "relationship"]),
      })
    )
    .optional(),

  // Proposals (existing, enhanced)
  proposals: z
    .array(
      z.object({
        proposalId: z.string().uuid(),
        targetType: z.string(),
        targetId: z.string().uuid().optional(),
        operation: z.enum(["create", "update", "delete"]),
        confidence: z.number(),
        reasoning: z.string(),
      })
    )
    .optional(),

  // Attachments (NEW)
  attachments: z
    .array(
      z.object({
        type: z.enum(["file", "image", "document", "entity"]),
        id: z.string().uuid(),
        url: z.string().url().optional(),
        name: z.string().optional(),
      })
    )
    .optional(),

  // Legacy fields (from ConversationMessageMetadata)
  agentState: z.any().optional(), // Keep for backward compatibility
  suggestedActions: z.array(z.any()).optional(),
  executedAction: z.any().optional(),
  model: z.string().optional(),
  tokens: z.number().optional(),
  latency: z.number().optional(),

  // Custom extensibility
  custom: z.record(z.string(), z.unknown()).optional(),
});

export type EnhancedMessageMetadata = z.infer<
  typeof EnhancedMessageMetadataSchema
>;

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Convert ConversationMessageMetadata to EnhancedMessageMetadata
 */
export function enhanceMessageMetadata(
  metadata?: ConversationMessageMetadata | null
): EnhancedMessageMetadata | undefined {
  if (!metadata) return undefined;

  // Convert attachments if they exist (old format to new format)
  const enhancedAttachments = metadata.attachments
    ? metadata.attachments.map((att) => ({
        type: (att.type as "file" | "image" | "document" | "entity") || "file",
        id: randomUUID(), // Generate ID if not present
        url: att.url,
        name: undefined,
      }))
    : undefined;

  return {
    // Keep existing fields
    agentState: metadata.agentState,
    suggestedActions: metadata.suggestedActions,
    executedAction: metadata.executedAction,
    model: metadata.model,
    tokens: metadata.tokens,
    latency: metadata.latency,
    // Convert attachments
    attachments: enhancedAttachments,
    // New fields are optional
  };
}

/**
 * Check if metadata has approval context
 */
export function hasApprovalMetadata(
  metadata: unknown
): metadata is EnhancedMessageMetadata & { approval: ApprovalMetadata } {
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    "approval" in metadata &&
    typeof (metadata as any).approval === "object"
  );
}

/**
 * Check if metadata has AI context
 */
export function hasAIMessageMetadata(
  metadata: unknown
): metadata is EnhancedMessageMetadata & { ai: EnhancedAIMessageMetadata } {
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    "ai" in metadata &&
    typeof (metadata as any).ai === "object"
  );
}
