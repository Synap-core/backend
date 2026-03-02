/**
 * Hub Protocol - Search Router
 *
 * Handles all search operations using Search Service (Typesense)
 */

import { z } from "zod";
import { router } from "../../trpc.js";
import { scopedProcedure } from "../../middleware/api-key-auth.js";
import { sql } from "@synap/database";
import { intelligenceHubClient } from "../../clients/intelligence-hub.js";

export const searchRouter = router({
  /**
   * Unified search using Search Service (Typesense)
   * Requires: hub-protocol.read scope
   *
   * Replaces simple ILIKE search with Typesense for better relevance
   */
  search: scopedProcedure(["hub-protocol.read"])
    .input(
      z.object({
        userId: z.string(),
        query: z.string().min(1).max(500),
        workspaceId: z.string().optional(),
        collections: z
          .array(
            z.enum([
              "entities",
              "documents",
              "views",
              "projects",
              "chat_threads",
              "agents",
            ])
          )
          .optional(),
        limit: z.number().min(1).max(100).default(20),
        page: z.number().min(1).default(1),
      })
    )
    .query(async ({ input }) => {
      const { searchService } = await import("@synap/search");

      return await searchService.search({
        query: input.query,
        userId: input.userId,
        workspaceId: input.workspaceId,
        collections: input.collections,
        limit: input.limit,
        page: input.page,
      });
    }),

  /**
   * Search within specific collection
   * Requires: hub-protocol.read scope
   */
  searchCollection: scopedProcedure(["hub-protocol.read"])
    .input(
      z.object({
        userId: z.string(),
        collection: z.enum([
          "entities",
          "documents",
          "views",
          "projects",
          "chat_threads",
          "agents",
        ]),
        query: z.string().min(1).max(500),
        workspaceId: z.string().optional(),
        limit: z.number().min(1).max(100).default(20),
        page: z.number().min(1).default(1),
      })
    )
    .query(async ({ input }) => {
      const { searchService } = await import("@synap/search");

      return await searchService.searchCollection(
        input.collection,
        input.query,
        {
          userId: input.userId,
          workspaceId: input.workspaceId,
          limit: input.limit,
          page: input.page,
        }
      );
    }),

  /**
   * Search entities (legacy - delegates to unified search)
   * Requires: hub-protocol.read scope
   * @deprecated Use search() instead for better relevance
   */
  searchEntities: scopedProcedure(["hub-protocol.read"])
    .input(
      z.object({
        userId: z.string(),
        query: z.string(),
        type: z
          .enum([
            "note",
            "task",
            "document",
            "project",
            "contact",
            "meeting",
            "idea",
          ])
          .optional(),
        limit: z.number().min(1).max(100).default(20),
      })
    )
    .query(async ({ input }) => {
      // Use Search Service for better relevance
      const { searchService } = await import("@synap/search");

      const results = await searchService.searchCollection(
        "entities",
        input.query,
        {
          userId: input.userId,
          limit: input.limit,
        }
      );

      // Filter by type if specified
      let filteredResults = results.results;
      if (input.type) {
        filteredResults = results.results.filter(
          (r) => r.document?.entityType === input.type
        );
      }

      return {
        entities: filteredResults.map((r) => r.document).filter(Boolean),
      };
    }),

  /**
   * Search documents via Typesense (full-text search with relevance ranking)
   * Requires: hub-protocol.read scope
   */
  searchDocuments: scopedProcedure(["hub-protocol.read"])
    .input(
      z.object({
        userId: z.string(),
        query: z.string(),
        type: z.enum(["text", "markdown", "code", "pdf", "docx"]).optional(),
        limit: z.number().min(1).max(50).default(10),
      })
    )
    .query(async ({ input }) => {
      const { searchService } = await import("@synap/search");

      const searchResults = await searchService.searchCollection(
        "documents",
        input.query,
        {
          userId: input.userId,
          limit: input.limit,
        }
      );

      let docs = searchResults.results
        .map((r) => r.document)
        .filter(Boolean) as Array<{
        id: string;
        title: string;
        type: string;
        language?: string;
        updatedAt: string;
        createdAt: string;
      }>;

      if (input.type) {
        docs = docs.filter((d) => d.type === input.type);
      }

      return {
        documents: docs.map((d) => ({
          id: d.id,
          title: d.title,
          type: d.type,
          language: d.language,
          updatedAt: d.updatedAt,
          createdAt: d.createdAt,
        })),
      };
    }),

  /**
   * Vector search (semantic search across entities + documents)
   * Requires: hub-protocol.read scope
   */
  vectorSearch: scopedProcedure(["hub-protocol.read"])
    .input(
      z.object({
        userId: z.string(),
        query: z.string(),
        types: z.array(z.string()).optional(),
        limit: z.number().min(1).max(50).default(10),
      })
    )
    .query(async ({ input }) => {
      // 1. Generate embedding for query
      let embedding: number[];
      try {
        embedding = await intelligenceHubClient.generateEmbedding(input.query);
      } catch (error) {
        console.error("Failed to generate embedding:", error);
        // Return empty results if embedding fails
        return {
          results: [],
          embeddingGenerated: false,
        };
      }

      const embeddingStr = `[${embedding.join(",")}]`;

      // 2. Vector similarity search using pgvector
      const results = await sql`
        SELECT 
          e.id,
          e.type,
          e.title,
          e.preview,
          e.created_at,
          1 - (ev.embedding <=> ${embeddingStr}::vector) as similarity
        FROM entity_vectors ev
        JOIN entities e ON ev.entity_id = e.id
        WHERE 
          ev.user_id = ${input.userId}
          AND e.deleted_at IS NULL
          ${input.types ? sql`AND e.type = ANY(${input.types})` : sql``}
        ORDER BY similarity DESC
        LIMIT ${input.limit}
      `;

      return {
        results: results.map((r: any) => ({
          id: r.id,
          type: r.type,
          title: r.title,
          preview: r.preview,
          similarity: r.similarity,
          createdAt: r.created_at,
        })),
        embeddingGenerated: true,
      };
    }),
});
