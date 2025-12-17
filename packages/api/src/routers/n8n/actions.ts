/**
 * n8n Actions Router
 * 
 * Provides programmatic access to Synap capabilities for n8n workflows.
 * 
 * Endpoints:
 * - createEntity: Create notes, tasks, projects
 * - searchEntities: Semantic search across user data
 * - analyzeContent: AI-powered content analysis
 */

import { router } from '../../trpc.js';
import { scopedProcedure } from '../../middleware/api-key-auth.js';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { createLogger } from '@synap/core';
import { db } from '@synap/database';
import { events } from '@synap/database';
import { createSynapEvent } from '@synap/types';

const logger = createLogger({ module: 'n8n-router' });

// ============================================================================
// Input Schemas
// ============================================================================

const CreateEntityInputSchema = z.object({
  type: z.enum(['note', 'task', 'project']),
  title: z.string().min(1).max(500).optional(),
  content: z.string().min(1),
  tags: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const SearchEntitiesInputSchema = z.object({
  query: z.string().min(1).max(1000),
  limit: z.number().int().min(1).max(100).default(10),
  type: z.enum(['note', 'task', 'project', 'all']).default('all'),
});

const AnalyzeContentInputSchema = z.object({
  content: z.string().min(1).max(10000),
  analysisTypes: z.array(
    z.enum(['tags', 'summary', 'tasks', 'sentiment'])
  ).min(1),
});

// ============================================================================
// n8n Actions Router
// ============================================================================

export const n8nActionsRouter = router({
  /**
   * Create Entity
   * 
   * Creates a note, task, or project via event sourcing.
   * 
   * Required scope: write:entities
   */
  createEntity: scopedProcedure(['write:entities'])
    .input(CreateEntityInputSchema)
    .mutation(async ({ input, ctx }) => {
      const { type, title, content, tags, metadata } = input;
      const userId = ctx.userId as string;

      logger.info({ 
        userId, 
        type, 
        keyName: ctx.apiKeyName 
      }, 'n8n: Creating entity');

      try {
        // Create generic entity event
        const event = createSynapEvent({
          type: 'entities.create.validated',
          userId,
          data: {
            entityType: type,
            title: title || 'Untitled',
            content,
            tags: tags || [],
            metadata: metadata || {},
            source: 'n8n',
          },
        });

        // Append event to event store
        await db.insert(events).values({
          id: event.id,
          userId: event.userId,
          type: event.type,
          subjectId: event.id,  // ✅ Entity ID
          subjectType: 'entity', // ✅ Subject type
          data: event.data,
          timestamp: event.timestamp,
          correlationId: event.correlationId,
          source: event.source,
        });

        logger.info({ 
          userId, 
          eventId: event.id,
          type 
        }, 'n8n: Entity created successfully');

        return {
          success: true,
          entityId: event.id,
          eventId: event.id,
          message: `${type} created successfully`,
        };

      } catch (error) {
        logger.error({ 
          err: error, 
          userId, 
          type 
        }, 'n8n: Failed to create entity');

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to create ${type}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        });
      }
    }),

  /**
   * Search Entities
   * 
   * Semantic search using vector embeddings.
   * 
   * Required scope: read:entities
   */
  searchEntities: scopedProcedure(['read:entities'])
    .input(SearchEntitiesInputSchema)
    .query(async ({ input, ctx }) => {
      const { query, limit, type } = input;
      const userId = ctx.userId as string;

      logger.info({ 
        userId, 
        query: query.substring(0, 50),
        limit,
        type,
        keyName: ctx.apiKeyName 
      }, 'n8n: Searching entities');

      try {
        // Step 1: Generate embedding from query
        const { generateEmbedding } = await import('@synap/ai-embeddings');
        const embedding = await generateEmbedding(query);

        // Step 2: Search entities by embedding similarity
        const { searchEntityVectorsRaw } = await import('@synap/database');
        // Cast db to any because VectorRepositoryDatabase interface is loose ([key: string]: unknown)
        // and Drizzle's PgDatabase doesn't have an index signature
        const results = await searchEntityVectorsRaw(db as any, { userId, embedding, limit });

        if (!results) {
          logger.warn({ userId }, 'n8n: Search returned null');
          return { results: [], query, count: 0 };
        }

        // Step 3: Filter by type if specified
        const filtered = type === 'all' 
          ? results 
          : results.filter(r => r.entityType === type);

        // Step 4: Transform results
        const searchResults = filtered.map((result) => ({
          entityId: result.entityId,
          title: result.title || 'Untitled',
          type: result.entityType,
          preview: result.preview || undefined,
          fileUrl: result.fileUrl || undefined,
          relevanceScore: result.relevanceScore,
        }));

        logger.info({ 
          userId, 
          resultCount: searchResults.length 
        }, 'n8n: Search completed');

        return {
          results: searchResults,
          query,
          count: searchResults.length,
        };

      } catch (error) {
        logger.error({ 
          err: error, 
          userId, 
          query: query.substring(0, 50) 
        }, 'n8n: Search failed');

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Search failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        });
      }
    }),

  /**
   * Analyze Content
   * 
   * AI-powered content analysis: tags, summary, tasks, sentiment.
   * 
   * Required scope: ai:analyze
   */
  analyzeContent: scopedProcedure(['ai:analyze'])
    .input(AnalyzeContentInputSchema)
    .mutation(async ({ input, ctx }) => {
      const { content, analysisTypes } = input;
      const userId = ctx.userId as string;

      logger.info({ 
        userId, 
        contentLength: content.length,
        analysisTypes,
        keyName: ctx.apiKeyName 
      }, 'n8n: Analyzing content');

      try {
        const analysis: {
          tags?: string[];
          summary?: string;
          tasks?: string[];
          sentiment?: 'positive' | 'negative' | 'neutral';
        } = {};

        // Simple heuristics for MVP (replace with Intelligence Hub later)
        if (analysisTypes.includes('tags')) {
          analysis.tags = extractTags(content);
        }

        if (analysisTypes.includes('summary')) {
          analysis.summary = generateSummary(content);
        }

        if (analysisTypes.includes('tasks')) {
          analysis.tasks = extractTasks(content);
        }

        if (analysisTypes.includes('sentiment')) {
          analysis.sentiment = analyzeSentiment(content);
        }

        logger.info({ 
          userId, 
          analysisTypes
        }, 'n8n: Analysis completed');

        return {
          success: true,
          ...analysis,
        };

      } catch (error) {
        logger.error({ 
          err: error, 
          userId 
        }, 'n8n: Analysis failed');

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Analysis failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        });
      }
    }),
});

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Extract tags from content (simple implementation)
 */
function extractTags(content: string): string[] {
  // Extract hashtags
  const hashtags = content.match(/#\w+/g) || [];
  const cleanedHashtags = hashtags.map(t => t.substring(1));

  // Extract keywords (simple frequency analysis)
  const stopWords = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been',
    'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  ]);

  const words = content
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 3 && !stopWords.has(word));

  const frequency = new Map<string, number>();
  words.forEach(word => {
    frequency.set(word, (frequency.get(word) || 0) + 1);
  });

  const topKeywords = Array.from(frequency.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([word]) => word);

  return [...new Set([...cleanedHashtags, ...topKeywords])];
}

/**
 * Generate summary (simple implementation)
 */
function generateSummary(content: string): string {
  const firstSentence = content.match(/^[^.!?]+[.!?]/)?.[0];
  return firstSentence || content.substring(0, 100) + '...';
}

/**
 * Extract tasks from content
 */
function extractTasks(content: string): string[] | undefined {
  const taskPattern = /(?:^|\n)[-*•]\s+(.+?)(?:\n|$)/g;
  const tasks: string[] = [];
  let match;
  
  while ((match = taskPattern.exec(content)) !== null) {
    tasks.push(match[1].trim());
  }
  
  return tasks.length > 0 ? tasks : undefined;
}

/**
 * Analyze sentiment (simple implementation)
 */
function analyzeSentiment(content: string): 'positive' | 'negative' | 'neutral' {
  const positiveWords = ['great', 'good', 'excellent', 'happy', 'love', 'amazing', 'wonderful'];
  const negativeWords = ['bad', 'terrible', 'awful', 'hate', 'problem', 'issue', 'fail'];
  
  const lowerContent = content.toLowerCase();
  const positiveCount = positiveWords.filter(w => lowerContent.includes(w)).length;
  const negativeCount = negativeWords.filter(w => lowerContent.includes(w)).length;
  
  if (positiveCount > negativeCount) return 'positive';
  if (negativeCount > positiveCount) return 'negative';
  return 'neutral';
}
