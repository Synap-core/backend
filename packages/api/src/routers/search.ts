/**
 * Search Router - Semantic Search API
 *
 * Provides full-text and vector similarity search
 * Uses: entities, entity_vectors tables + pgvector
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import {
  db,
  entities,
  eq,
  and,
  desc,
  sqlDrizzle as sql,
} from "@synap/database";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "search-router" });

export const searchRouter = router({
  /**
   * Full-text search across entities
   * Uses PostgreSQL's tsvector for fast text search
   */
  entities: protectedProcedure
    .input(
      z.object({
        query: z.string().min(1),
        type: z.enum(["note", "task", "document", "project"]).optional(),
        limit: z.number().min(1).max(100).default(20),
      })
    )
    .query(async ({ ctx, input }) => {
      const userId = ctx.userId;

      logger.debug(
        { userId, query: input.query, type: input.type },
        "Searching entities"
      );

      // Full-text search using PostgreSQL tsvector
      // Uses GIN index on search_vector for fast performance
      const conditions = [
        eq(entities.userId, userId),
        sql`${entities.deletedAt} IS NULL`,
      ];

      if (input.type) {
        conditions.push(eq(entities.type, input.type));
      }

      // Full-text search with ranking
      // plainto_tsquery converts user input to tsquery (handles spaces, special chars)
      // ts_rank scores relevance (higher = better match)
      const results = await db.execute(sql`
        SELECT
          e.*,
          ts_rank(e.search_vector, plainto_tsquery('english', ${input.query})) as rank
        FROM ${entities} e
        WHERE ${sql.join(conditions, sql` AND `)}
          AND e.search_vector @@ plainto_tsquery('english', ${input.query})
        ORDER BY rank DESC, e.updated_at DESC
        LIMIT ${input.limit}
      `);

      logger.debug({ userId, resultCount: results.length }, "Search complete");

      // Cast results to entity type (remove rank field from response)
      const entitiesResults = results.map((r: any) => {
        const { rank, ...entity } = r;
        return entity;
      });

      return { entities: entitiesResults };
    }),

  /**
   * Semantic search using vector similarity
   * Finds entities similar to the query using embeddings
   */
  semantic: protectedProcedure
    .input(
      z.object({
        query: z.string().min(1),
        type: z.enum(["note", "task", "document", "project"]).optional(),
        limit: z.number().min(1).max(50).default(10),
        threshold: z.number().min(0).max(1).default(0.7),
      })
    )
    .query(async ({ ctx, input }) => {
      const userId = ctx.userId;

      logger.debug({ userId, query: input.query }, "Semantic search requested");

      // TODO: Implement vector search with pgvector
      // 1. Generate embedding for input.query using AI service
      // 2. Query entity_vectors using cosine similarity
      // 3. Join back to entities table
      // 4. Return ranked results

      // For now, return empty results with a note
      logger.warn(
        "Semantic search not yet implemented - requires embedding service"
      );

      return {
        entities: [],
        message: "Semantic search requires embedding service configuration",
      };
    }),

  /**
   * Find entities related to a given entity
   * Uses vector similarity + explicit relationships
   */
  related: protectedProcedure
    .input(
      z.object({
        entityId: z.string().uuid(),
        limit: z.number().min(1).max(50).default(10),
      })
    )
    .query(async ({ ctx, input }) => {
      const userId = ctx.userId;

      // Verify entity ownership
      const entity = await db.query.entities.findFirst({
        where: and(
          eq(entities.id, input.entityId),
          eq(entities.userId, userId)
        ),
      });

      if (!entity) {
        throw new Error("Entity not found");
      }

      logger.debug(
        { userId, entityId: input.entityId },
        "Finding related entities"
      );

      // TODO: Implement vector similarity search
      // 1. Get entity vector for input.entityId
      // 2. Find similar vectors using pgvector
      // 3. Join to entities table
      // 4. Rank by similarity score

      // For now, return entities of the same type (simple approach)
      const results = await db.query.entities.findMany({
        where: and(
          eq(entities.userId, userId),
          eq(entities.type, entity.type),
          sql`${entities.id} != ${input.entityId}`,
          sql`${entities.deletedAt} IS NULL`
        ),
        orderBy: [desc(entities.updatedAt)],
        limit: input.limit,
      });

      logger.debug(
        { userId, resultCount: results.length },
        "Related entities found"
      );

      return { entities: results };
    }),

  /**
   * Tag-based search
   * Find entities that have all specified tags
   */
  byTags: protectedProcedure
    .input(
      z.object({
        tagIds: z.array(z.string().uuid()).min(1),
        limit: z.number().min(1).max(100).default(20),
      })
    )
    .query(async ({ ctx, input }) => {
      const userId = ctx.userId;

      logger.debug({ userId, tagIds: input.tagIds }, "Searching by tags");

      // Find entities that have ALL the specified tags
      // This is a set intersection query
      const results = await db.execute(sql`
        SELECT e.*
        FROM entities e
        WHERE e.user_id = ${userId}
          AND e.deleted_at IS NULL
          AND (
            SELECT COUNT(DISTINCT et.tag_id)
            FROM entity_tags et
            WHERE et.entity_id = e.id
              AND et.tag_id = ANY(ARRAY[${input.tagIds.map(() => "?").join(",")}]::uuid[])
          ) = ${input.tagIds.length}
        ORDER BY e.updated_at DESC
        LIMIT ${input.limit}
      `);

      logger.debug(
        { userId, resultCount: results.length },
        "Tag search complete"
      );

      return { entities: results as any[] };
    }),
});
