/**
 * Typesense Search Router
 * Global search across all collections using Typesense
 */

import { z } from "zod";
import { protectedProcedure, router } from "../trpc.js";
import {
  searchService,
  collectionService,
  indexingService,
} from "@synap/search";
import { inngest } from "@synap/jobs";

export const typesenseRouter = router({
  /**
   * Unified search across all collections
   */
  search: protectedProcedure
    .input(
      z.object({
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
    .query(async ({ input, ctx }) => {
      return await searchService.search({
        query: input.query,
        userId: ctx.userId,
        workspaceId: input.workspaceId,
        collections: input.collections,
        limit: input.limit,
        page: input.page,
      });
    }),

  /**
   * Search within specific collection
   */
  searchCollection: protectedProcedure
    .input(
      z.object({
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
    .query(async ({ input, ctx }) => {
      return await searchService.searchCollection(
        input.collection,
        input.query,
        {
          userId: ctx.userId,
          workspaceId: input.workspaceId,
          limit: input.limit,
          page: input.page,
        }
      );
    }),

  /**
   * Get collection statistics
   */
  getStats: protectedProcedure.query(async () => {
    return await collectionService.getCollectionStats();
  }),

  /**
   * Get indexing queue status
   */
  getQueueStatus: protectedProcedure.query(async () => {
    return indexingService.getQueueStatus();
  }),

  /**
   * Trigger reindex for workspace
   */
  reindex: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        collections: z.array(z.string()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // TODO: Check if user has admin permission for workspace

      // Trigger reindex job
      await inngest.send({
        name: "search.reindex.requested",
        data: {
          workspaceId: input.workspaceId,
          collections: input.collections,
          userId: ctx.userId,
        },
      });

      return {
        status: "queued",
        message: "Reindex job has been queued",
      };
    }),

  /**
   * Initialize collections (admin only)
   */
  initializeCollections: protectedProcedure.mutation(async () => {
    // TODO: Check if user is system admin

    await collectionService.initializeCollections();

    return {
      status: "initialized",
      message: "All collections have been initialized",
    };
  }),
});
