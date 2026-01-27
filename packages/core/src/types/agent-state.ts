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
});

export type ConversationMessageMetadata = z.infer<
  typeof ConversationMessageMetadataSchema
>;
