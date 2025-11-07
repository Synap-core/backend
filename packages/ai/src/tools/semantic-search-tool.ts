import { db, entities } from '@synap/database';
import { z } from 'zod';
import { vectorService } from '@synap/domain';
import { generateEmbedding } from '../clients/embeddings.js';
import { createLogger } from '@synap/core';
import type {
  AgentToolDefinition,
  AgentToolExecutionResult,
  AgentToolContext,
  SemanticSearchPayload,
} from './types.js';
import type { SemanticSearchResult } from '../agent/types.js';

const MAX_CANDIDATES = 200;
const MAX_RESULTS = 25;

const logger = createLogger({ module: 'semantic-search-tool' });

const semanticSearchInputSchema = z.object({
  query: z.string().min(1),
  limit: z.number().min(1).max(MAX_RESULTS).default(5),
});

const entityRowSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    title: z.string().nullable().optional(),
    preview: z.string().nullable().optional(),
    fileUrl: z.string().nullable().optional(),
    filePath: z.string().nullable().optional(),
    userId: z.string().nullable().optional(),
    updatedAt: z.union([z.date(), z.string(), z.number()]).optional(),
  })
  .passthrough();

const normaliseText = (value?: string | null) =>
  value ? value.toLowerCase() : '';

const computeRelevance = (queryTokens: string[], candidate: string) => {
  const candidateTokens = candidate.split(/\s+/);
  const matches = candidateTokens.filter((token) =>
    queryTokens.some((queryToken) => token.startsWith(queryToken))
  );
  return matches.length / Math.max(candidateTokens.length, 1);
};

const rankResults = (
  rows: ReadonlyArray<z.infer<typeof entityRowSchema>>,
  query: string,
  limit: number,
  userId: string
): SemanticSearchResult[] => {
  const trimmedQuery = query.trim().toLowerCase();
  if (trimmedQuery.length === 0) {
    return [];
  }

  const tokens = trimmedQuery.split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return [];
  }

  const scored = rows
    .filter((row) => !row.userId || row.userId === userId)
    .map((row) => {
      const titleScore = computeRelevance(tokens, normaliseText(row.title));
      const previewScore = computeRelevance(tokens, normaliseText(row.preview));
      return {
        entityId: row.id,
        title: row.title ?? 'Untitled',
        type: row.type,
        preview: row.preview ?? undefined,
        fileUrl: row.fileUrl ?? undefined,
        relevanceScore: Math.max(titleScore, previewScore),
      } satisfies SemanticSearchResult;
    })
    .filter((item) => item.relevanceScore > 0)
    .sort((a, b) => b.relevanceScore - a.relevanceScore);

  return scored.slice(0, limit);
};

const toExecutionResult = (
  payload: SemanticSearchPayload,
  startedAt: number
): AgentToolExecutionResult<SemanticSearchPayload> => ({
  success: true,
  result: payload,
  metadata: {
    durationMs: Date.now() - startedAt,
  },
});

const fetchCandidateRows = async () => {
  const rows = await db.select().from(entities).limit(MAX_CANDIDATES);
  return entityRowSchema.array().parse(rows);
};

export const semanticSearchTool: AgentToolDefinition<
  typeof semanticSearchInputSchema,
  SemanticSearchPayload
> = {
  name: 'semanticSearch',
  description:
    'Returns the most relevant entities for a natural language query using lightweight token overlap scoring.',
  schema: semanticSearchInputSchema,
  execute: async (input, context: AgentToolContext) => {
    const startedAt = Date.now();

    let ranked: SemanticSearchResult[] = [];

    try {
      const embedding = await generateEmbedding(input.query);
      const vectorResults = await vectorService.searchByEmbedding({
        userId: context.userId,
        embedding,
        limit: input.limit,
      });

      ranked = vectorResults.map((result) => ({
        entityId: result.entityId,
        title: result.title ?? 'Untitled',
        type: result.entityType,
        preview: result.preview ?? undefined,
        fileUrl: result.fileUrl ?? undefined,
        relevanceScore: result.relevanceScore,
      } satisfies SemanticSearchResult));

      logger.debug({ count: ranked.length }, 'Vector search results generated');
    } catch (error) {
      logger.error({ err: error }, 'Vector search failed; falling back to token ranking');
    }

    if (ranked.length === 0) {
      logger.warn({ userId: context.userId }, 'Vector search returned no results; falling back to token ranking');
      const candidates = await fetchCandidateRows();
      ranked = rankResults(candidates, input.query, input.limit, context.userId);
    }

    return toExecutionResult(
      {
        results: ranked,
      },
      startedAt
    );
  },
};

