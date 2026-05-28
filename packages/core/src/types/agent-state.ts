import { z } from "zod";

export const AgentExecutionSummarySchema = z.object({
  tool: z.string(),
  status: z.enum(["success", "error", "skipped"]),
  result: z.unknown().optional(),
  error: z.string().optional(),
});

export const AgentPlannedActionSchema = z.object({
  tool: z.string(),
  params: z.record(z.string(), z.unknown()),
  reasoning: z.string(),
});

export const AgentContextSchema = z.object({
  retrievedNotesCount: z.number().min(0),
  retrievedFactsCount: z.number().min(0),
});

export const AgentIntentAnalysisSchema = z.object({
  label: z.string(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().optional(),
  needsFollowUp: z.boolean().optional(),
});

export const SuggestedActionSchema = z.object({
  type: z.string(),
  description: z.string(),
  params: z.record(z.string(), z.unknown()),
});

export const ExecutedActionSchema = z.object({
  type: z.string(),
  result: z.unknown(),
});

export const AttachmentSchema = z.object({
  type: z.string(),
  url: z.string().url(),
});

/**
 * Mirrors the AIStep interface from @synap-core/types (hub-protocol).
 * Kept as a loose schema so it tolerates forward-compat additions from IS.
 */
export const AIStepSchema = z.object({
  id: z.string(),
  type: z.string(),
  content: z.string(),
  toolName: z.string().optional(),
  toolInput: z.unknown().optional(),
  toolOutput: z.unknown().optional(),
  timestamp: z.string(),
  duration: z.number().optional(),
  error: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  status: z.enum(["pending", "running", "complete", "error"]).optional(),
});

export const AgentStateSchema = z.object({
  intentAnalysis: AgentIntentAnalysisSchema.optional(),
  context: AgentContextSchema.optional(),
  plan: z.array(AgentPlannedActionSchema),
  executionSummaries: z.array(AgentExecutionSummarySchema),
  finalResponse: z.string(),
  suggestedActions: z.array(SuggestedActionSchema).optional(),
  model: z.string().optional(),
  tokens: z.number().optional(),
  latency: z.number().optional(),
});

export type AgentStateMetadata = z.infer<typeof AgentStateSchema>;

export const ConversationMessageMetadataSchema = z.object({
  agentState: AgentStateSchema.optional(),
  suggestedActions: z.array(SuggestedActionSchema).optional(),
  executedAction: ExecutedActionSchema.optional(),
  attachments: z.array(AttachmentSchema).optional(),
  model: z.string().optional(),
  tokens: z.number().optional(),
  latency: z.number().optional(),
  /** UUID of the IntelligenceService that produced this message. */
  intelligenceServiceId: z.string().optional(),
  /** UUID of the agent that produced this message. */
  agentId: z.string().optional(),
  /** Tool calls and thinking steps captured during the IS turn. */
  aiSteps: z.array(AIStepSchema).optional(),
  /** Agent type that produced this message (e.g. "analyst", "meta"). */
  agentType: z.string().optional(),
});

export type ConversationMessageMetadata = z.infer<
  typeof ConversationMessageMetadataSchema
>;
