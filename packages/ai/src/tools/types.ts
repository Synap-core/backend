import type { z } from 'zod';
import type { SemanticSearchResult } from '../agent/types.js';

export interface AgentToolContext {
  userId: string;
  threadId: string;
}

export interface AgentToolExecutionMetadata {
  durationMs: number;
  logs?: string[];
}

export interface AgentToolExecutionResult<TResult> {
  success: boolean;
  result: TResult;
  metadata: AgentToolExecutionMetadata;
}

export interface ToolExecutionResult {
  success: boolean;
  result?: AgentToolExecutionResult<unknown>;
  error?: string;
}

export interface AgentToolDefinition<
  TSchema extends z.ZodTypeAny,
  TResult
> {
  name: string;
  description: string;
  schema: TSchema;
  execute: (
    input: z.infer<TSchema>,
    context: AgentToolContext
  ) => Promise<AgentToolExecutionResult<TResult>>;
}

export interface CreateEntityPayload {
  entityId: string;
  eventId: string;
  aggregateVersion: number;
  fileUrl?: string;
  filePath?: string;
  fileSize?: number;
  fileChecksum?: string;
}

export interface SemanticSearchPayload {
  results: SemanticSearchResult[];
}

