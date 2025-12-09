/**
 * Entities Data Router - CRUD + Vector Search
 * 
 * Data Pod operations for entities using existing pgvector infrastructure
 */

import { z } from 'zod';
import { router, protectedProcedure } from '../trpc.js';
import { db, sql, eq, desc, and, isNull, ilike, or } from '@synap/database';
import { entities } from '@synap/database/schema';
import { intelligenceHubClient } from '../clients/intelligence-hub.js';

const EntityTypeSchema = z.enum(['task', 'contact', 'meeting', 'idea', 'note', 'project']);

/**
 * Entities Data Router
 * CRUD operations + Vector semantic search
 */
export const entitiesDataRouter = router({
  /**
   * Create entity
   */
  create: protectedProcedure
    .input(z.object({
      type: EntityTypeSchema,
      title: z.string(),
      description: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      // Create entity
      const [entity] = await db.insert(entities).values({
        userId: ctx.userId,
        type: input.type,
        title: input.title,
        preview: input.description,
      }).returning();
      
      // Generate and store embedding (async, non-blocking)
      generateAndStoreEmbedding(entity.id, ctx.userId, entity.type, entity.title ?? '', input.description)
        .catch(err => console.error('Failed to generate embedding:', err));
      
      return { entity };
    }),
  
  /**
   * List entities with pagination
   */
  list: protectedProcedure
    .input(z.object({
      type: EntityTypeSchema.optional(),
      limit: z.number().min(1).max(100).default(50),
      offset: z.number().min(0).default(0),
    }))
    .query(async ({ input, ctx }) => {
      const results = await db.query.entities.findMany({
        where: and(
          eq(entities.userId, ctx.userId),
          isNull(entities.deletedAt),
          input.type ? eq(entities.type, input.type) : undefined
        ),
        orderBy: [desc(entities.createdAt)],
        limit: input.limit,
        offset: input.offset,
      });
      
      return { entities: results };
    }),
  
  /**
   * Get entity by ID
   */
  get: protectedProcedure
    .input(z.object({
      id: z.string().uuid(),
    }))
    .query(async ({ input, ctx }) => {
      const entity = await db.query.entities.findFirst({
        where: and(
          eq(entities.id, input.id),
          eq(entities.userId, ctx.userId),
          isNull(entities.deletedAt)
        ),
      });
      
      if (!entity) {
        throw new Error('Entity not found');
      }
      
      return { entity };
    }),
  
  /**
   * Text search (keyword matching)
   */
  textSearch: protectedProcedure
    .input(z.object({
      query: z.string(),
      type: EntityTypeSchema.optional(),
      limit: z.number().min(1).max(50).default(20),
    }))
    .query(async ({ input, ctx }) => {
      const searchPattern = `%${input.query}%`;
      
      const results = await db.query.entities.findMany({
        where: and(
          eq(entities.userId, ctx.userId),
          isNull(entities.deletedAt),
          input.type ? eq(entities.type, input.type) : undefined,
          or(
            ilike(entities.title, searchPattern),
            ilike(entities.preview, searchPattern)
          )
        ),
        orderBy: [desc(entities.createdAt)],
        limit: input.limit,
      });
      
      return { entities: results };
    }),
  
  /**
   * Vector semantic search using pgvector
   * Reuses existing entity_vectors table!
   */
  vectorSearch: protectedProcedure
    .input(z.object({
      query: z.string(),
      type: EntityTypeSchema.optional(),
      limit: z.number().min(1).max(50).default(10),
      minSimilarity: z.number().min(0).max(1).default(0.5),
    }))
    .query(async ({ input, ctx }): Promise<{
      entities: Array<{
        id: string;
        type: string;
        title: string | null;
        preview: string | null;
        similarity: number;
        createdAt: Date;
      }>;
      embeddingGenerated: boolean;
    }> => {
      // Generate embedding for query
      let embedding: number[];
      try {
        embedding = await intelligenceHubClient.generateEmbedding(input.query);
      } catch (error) {
        console.error('Failed to generate embedding, falling back to text search:', error);
        // Fallback to text search (simplified)
        const results = await db.query.entities.findMany({
          where: and(
            eq(entities.userId, ctx.userId),
            isNull(entities.deletedAt),
            input.type ? eq(entities.type, input.type) : undefined,
          ),
          orderBy: [desc(entities.createdAt)],
          limit: input.limit,
        });
        return { 
          entities: results.map(e => ({
            id: e.id,
            type: e.type,
            title: e.title,
            preview: e.preview,
            similarity: 0,
            createdAt: e.createdAt,
          })),
          embeddingGenerated: false,
        };
      }
      
      // Vector similarity search using pgvector
      const embeddingStr = `[${embedding.join(',')}]`;
      
      const results = await sql`
        SELECT 
          ev.entity_id,
          ev.entity_type,
          ev.title,
          ev.preview,
          e.id,
          e.type,
          e.created_at,
          1 - (ev.embedding <=> ${embeddingStr}::vector) as similarity
        FROM entity_vectors ev
        JOIN entities e ON ev.entity_id = e.id
        WHERE ev.user_id = ${ctx.userId}
          AND e.deleted_at IS NULL
          ${input.type ? sql`AND ev.entity_type = ${input.type}` : sql``}
        ORDER BY similarity DESC
        LIMIT ${input.limit}
      `;
      
      // Filter by minimum similarity
      const filtered = results.filter((r: any) => r.similarity >= input.minSimilarity);
      
      return {
        entities: filtered.map((r: any) => ({
          id: r.entity_id,
          type: r.entity_type,
          title: r.title,
          preview: r.preview,
          similarity: r.similarity,
          createdAt: r.created_at,
        })),
        embeddingGenerated: true,
      };
    }),
  
  /**
   * Update entity
   */
  update: protectedProcedure
    .input(z.object({
      id: z.string().uuid(),
      title: z.string().optional(),
      description: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const [updated] = await db.update(entities)
        .set({
          title: input.title,
          preview: input.description,
          updatedAt: new Date(),
        })
        .where(and(
          eq(entities.id, input.id),
          eq(entities.userId, ctx.userId)
        ))
        .returning();
      
      if (!updated) {
        throw new Error('Entity not found');
      }
      
      // Re-generate embedding
      if (input.title || input.description) {
        generateAndStoreEmbedding(
          updated.id,
          ctx.userId,
          updated.type,
          updated.title || '',
          input.description
        ).catch(err => console.error('Failed to update embedding:', err));
      }
      
      return { entity: updated };
    }),
  
  /**
   * Delete entity (soft delete)
   */
  delete: protectedProcedure
    .input(z.object({
      id: z.string().uuid(),
    }))
    .mutation(async ({ input, ctx }) => {
      await db.update(entities)
        .set({ deletedAt: new Date() })
        .where(and(
          eq(entities.id, input.id),
          eq(entities.userId, ctx.userId)
        ));
      
      return { success: true };
    }),
});

/**
 * Helper: Generate and store embedding for entity
 */
async function generateAndStoreEmbedding(
  entityId: string,
  userId: string,
  entityType: string,
  title: string,
  description?: string
): Promise<void> {
  const textToEmbed = `${title} ${description || ''}`.trim();
  
  try {
    const embedding = await intelligenceHubClient.generateEmbedding(textToEmbed);
    const embeddingStr = `[${embedding.join(',')}]`;
    
    // Upsert into entity_vectors
    await sql`
      INSERT INTO entity_vectors (entity_id, user_id, embedding, entity_type, title, preview)
      VALUES (${entityId}, ${userId}, ${embeddingStr}::vector, ${entityType}, ${title}, ${description || null})
      ON CONFLICT (entity_id) DO UPDATE SET
        embedding = ${embeddingStr}::vector,
        title = ${title},
        preview = ${description || null},
        updated_at = NOW()
    `;
    
    console.log(`✅ Generated embedding for entity ${entityId}`);
  } catch (error) {
    console.error(`❌ Failed to generate embedding for ${entityId}:`, error);
    throw error;
  }
}
