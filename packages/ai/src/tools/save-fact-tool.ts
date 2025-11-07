import { z } from 'zod';
import { knowledgeService } from '@synap/domain';
import { generateEmbedding } from '../clients/embeddings.js';
import type {
  AgentToolContext,
  AgentToolDefinition,
  AgentToolExecutionResult,
} from './types.js';

const saveFactInputSchema = z.object({
  fact: z.string().min(1).max(2000),
  confidence: z.number().min(0).max(1).default(0.5),
  sourceEntityId: z.string().uuid().optional(),
  sourceMessageId: z.string().uuid().optional(),
});

export interface SaveFactResult {
  factId: string;
  confidence: number;
  recordedAt: string;
}

const toExecutionResult = (
  payload: SaveFactResult,
  startedAt: number,
  logs: string[]
): AgentToolExecutionResult<SaveFactResult> => ({
  success: true,
  result: payload,
  metadata: {
    durationMs: Date.now() - startedAt,
    logs,
  },
});

export const saveFactTool: AgentToolDefinition<
  typeof saveFactInputSchema,
  SaveFactResult
> = {
  name: 'saveFact',
  description:
    'Persists an enduring fact about the user or their work. Use for stable preferences, objectives, or insights.',
  schema: saveFactInputSchema,
  execute: async (input, context: AgentToolContext) => {
    const logs: string[] = [];
    const startedAt = Date.now();

    const embedding = await generateEmbedding(input.fact);
    logs.push('Generated embedding for fact.');

    const record = await knowledgeService.recordFact({
      userId: context.userId,
      fact: input.fact,
      confidence: input.confidence,
      sourceEntityId: input.sourceEntityId,
      sourceMessageId: input.sourceMessageId,
      embedding,
    });

    logs.push(`Saved knowledge fact ${record.id} for user ${context.userId}.`);

    return toExecutionResult(
      {
        factId: record.id,
        confidence: record.confidence,
        recordedAt: record.createdAt.toISOString(),
      },
      startedAt,
      logs
    );
  },
};


