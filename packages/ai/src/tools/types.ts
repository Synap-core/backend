/**
 * Tool Types
 *
 * Type definitions for LangGraph tools.
 */

import type { z } from "zod";

export interface AgentToolDefinition<
  TInputSchema extends z.ZodTypeAny,
  TOutput,
> {
  name: string;
  description: string;
  schema: TInputSchema;
  execute: (
    input: z.infer<TInputSchema>,
    context: { userId: string; threadId: string },
  ) => Promise<{ result: TOutput }>;
}

export interface SemanticSearchPayload {
  results: Array<{
    entityId: string;
    title: string;
    type: string;
    preview?: string;
    fileUrl?: string;
    relevanceScore: number;
  }>;
}
