/**
 * Whiteboards Router - Version control for collaborative canvases
 *
 * Handles snapshot creation, version history, and restoration
 * for Yjs-based whiteboards.
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import { db, eq, desc, and } from "@synap/database";
import { views, documentVersions } from "@synap/database/schema";
import { TRPCError } from "@trpc/server";

export const whiteboardsRouter = router({
  /**
   * Save current whiteboard state as a version
   * User can trigger via Cmd+S or "Save Version" button
   */
  saveVersion: protectedProcedure
    .input(
      z.object({
        viewId: z.string().uuid(),
        message: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Get view
      const view = await db.query.views.findFirst({
        where: and(eq(views.id, input.viewId), eq(views.userId, ctx.userId)),
      });

      if (!view) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Whiteboard not found",
        });
      }

      if (!view.documentId || !view.yjsRoomId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Whiteboard not properly initialized",
        });
      }

      // Publish snapshot event (async processing)
      const { inngest } = await import("@synap/jobs");

      await inngest.send({
        name: "whiteboards.snapshot.requested",
        data: {
          viewId: input.viewId,
          documentId: view.documentId,
          yjsRoomId: view.yjsRoomId,
          message: input.message || "Manual snapshot",
          userId: ctx.userId,
        },
        user: { id: ctx.userId },
      });

      return {
        status: "saving",
        message: "Snapshot in progress",
      };
    }),

  /**
   * List all versions for a whiteboard
   */
  listVersions: protectedProcedure
    .input(
      z.object({
        viewId: z.string().uuid(),
        limit: z.number().min(1).max(50).default(20),
      })
    )
    .query(async ({ input, ctx }) => {
      // Get view
      const view = await db.query.views.findFirst({
        where: and(eq(views.id, input.viewId), eq(views.userId, ctx.userId)),
      });

      if (!view?.documentId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Whiteboard not found",
        });
      }

      // Get versions
      const versions = await db.query.documentVersions.findMany({
        where: eq(documentVersions.documentId, view.documentId),
        orderBy: desc(documentVersions.createdAt),
        limit: input.limit,
      });

      return { versions };
    }),

  /**
   * Restore whiteboard to a previous version
   */
  restoreVersion: protectedProcedure
    .input(
      z.object({
        viewId: z.string().uuid(),
        versionId: z.string().uuid(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Get view
      const view = await db.query.views.findFirst({
        where: and(eq(views.id, input.viewId), eq(views.userId, ctx.userId)),
      });

      if (!view?.yjsRoomId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Whiteboard not found",
        });
      }

      // Get version
      const version = await db.query.documentVersions.findFirst({
        where: eq(documentVersions.id, input.versionId),
      });

      if (!version) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Version not found",
        });
      }

      // Publish restore event
      const { inngest } = await import("@synap/jobs");

      await inngest.send({
        name: "whiteboards.restore.requested",
        data: {
          viewId: input.viewId,
          versionId: input.versionId,
          yjsRoomId: view.yjsRoomId,
          content: version.content,
          userId: ctx.userId,
        },
        user: { id: ctx.userId },
      });

      return {
        status: "restoring",
        message: "Restoring whiteboard...",
      };
    }),

  /**
   * Get version preview metadata
   */
  getVersionPreview: protectedProcedure
    .input(
      z.object({
        versionId: z.string().uuid(),
      })
    )
    .query(async ({ input }) => {
      const version = await db.query.documentVersions.findFirst({
        where: eq(documentVersions.id, input.versionId),
      });

      if (!version) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Version not found",
        });
      }

      // Parse Yjs state to extract basic metadata
      // (Full parsing requires Yjs, done client-side for preview)
      return {
        version,
        metadata: {
          size: version.content.length,
          message: version.message,
          author: version.author,
          createdAt: version.createdAt,
        },
      };
    }),

  /**
   * Delete old versions (cleanup)
   */
  deleteVersion: protectedProcedure
    .input(
      z.object({
        viewId: z.string().uuid(),
        versionId: z.string().uuid(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Get view
      const view = await db.query.views.findFirst({
        where: and(eq(views.id, input.viewId), eq(views.userId, ctx.userId)),
      });

      if (!view) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Whiteboard not found",
        });
      }

      // Delete version (but keep at least one)
      const remainingVersions = await db.query.documentVersions.findMany({
        where: eq(documentVersions.documentId, view.documentId!),
      });

      if (remainingVersions.length <= 1) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Cannot delete the last version",
        });
      }

      await db
        .delete(documentVersions)
        .where(eq(documentVersions.id, input.versionId));

      return { success: true };
    }),
});
