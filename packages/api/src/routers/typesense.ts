/**
 * Typesense Search Router
 * Global search across all collections using Typesense
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../trpc.js";
import {
  searchService,
  collectionService,
  indexingService,
} from "@synap/search";
import { getBoss } from "@synap/jobs";
import { db, eq, and } from "@synap/database";
import { workspaceMembers } from "@synap/database/schema";

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
            z.enum(["entities", "documents", "views", "channels", "agents"])
          )
          .optional(),
        limit: z.number().min(1).max(100).default(20),
        page: z.number().min(1).default(1),
        entityTypes: z.array(z.string()).optional(),
        documentTypes: z.array(z.string()).optional(),
        viewTypes: z.array(z.string()).optional(),
        tags: z.array(z.string()).optional(),
        status: z.array(z.string()).optional(),
        prefix: z.boolean().default(false),
        facetBy: z.array(z.string()).optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      try {
        return await searchService.search({
          query: input.query,
          userId: ctx.userId,
          workspaceId: input.workspaceId,
          collections: input.collections,
          limit: input.limit,
          page: input.page,
          entityTypes: input.entityTypes,
          documentTypes: input.documentTypes,
          viewTypes: input.viewTypes,
          tags: input.tags,
          status: input.status,
          prefix: input.prefix,
          facetBy: input.facetBy,
        });
      } catch (error: any) {
        const message =
          error?.message ||
          (typeof error === "string" ? error : "Search failed");
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Search failed: ${message}`,
          cause: error,
        });
      }
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
          "channels",
          "agents",
        ]),
        query: z.string().min(1).max(500),
        workspaceId: z.string().optional(),
        limit: z.number().min(1).max(100).default(20),
        page: z.number().min(1).default(1),
        entityTypes: z.array(z.string()).optional(),
        documentTypes: z.array(z.string()).optional(),
        viewTypes: z.array(z.string()).optional(),
        tags: z.array(z.string()).optional(),
        status: z.array(z.string()).optional(),
        prefix: z.boolean().default(false),
        facetBy: z.array(z.string()).optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      try {
        return await searchService.searchCollection(
          input.collection,
          input.query,
          {
            userId: ctx.userId,
            workspaceId: input.workspaceId,
            limit: input.limit,
            page: input.page,
            entityTypes: input.entityTypes,
            documentTypes: input.documentTypes,
            viewTypes: input.viewTypes,
            tags: input.tags,
            status: input.status,
            prefix: input.prefix,
            facetBy: input.facetBy,
          }
        );
      } catch (error: any) {
        const message =
          error?.message ||
          (typeof error === "string" ? error : "Search failed");
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Search failed: ${message}`,
          cause: error,
        });
      }
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
      // Check user has admin/owner permission for workspace
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(
          eq(workspaceMembers.workspaceId, input.workspaceId),
          eq(workspaceMembers.userId, ctx.userId)
        ),
      });

      if (!membership || !["owner", "admin"].includes(membership.role)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only workspace owners/admins can trigger reindex",
        });
      }

      // Trigger reindex job via pg-boss
      const boss = getBoss();
      await boss.send("search-reindex", {
        workspaceId: input.workspaceId,
        collections: input.collections,
        userId: ctx.userId,
      });

      return {
        status: "queued",
        message: "Reindex job has been queued",
      };
    }),

  /**
   * Initialize collections (admin only)
   */
  initializeCollections: protectedProcedure.mutation(async ({ ctx }) => {
    if (!["admin", "owner"].includes(ctx.workspaceRole ?? "")) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Only workspace admins can initialize search collections.",
      });
    }

    await collectionService.initializeCollections();

    return {
      status: "initialized",
      message: "All collections have been initialized",
    };
  }),
});
