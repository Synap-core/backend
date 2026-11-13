/**
 * Whiteboards Router - Version control for collaborative canvases
 *
 * Handles snapshot creation, version history, and restoration
 * for Yjs-based whiteboards.
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import { db, eq, desc, and, readDocumentVersionContent } from "@synap/database";
import { views, documents, documentVersions } from "@synap/database/schema";
import { TRPCError } from "@trpc/server";

/**
 * Refuse a restore the open room will refuse: a room that failed to load the
 * board (the realtime server's own flag, `YjsRoomStateReply.loadFailed`) or
 * whose state cannot be decoded is a CONFLICT with the reason; a realtime
 * server that does not answer is SERVICE_UNAVAILABLE. A closed room passes.
 */
async function assertRoomTakesRestore(
  yjsRoomId: string,
  documentId: string
): Promise<void> {
  const { readLiveRecords, BoardSceneReadError } =
    await import("../services/whiteboards/read-board-scene.js");
  try {
    await readLiveRecords(yjsRoomId, documentId);
  } catch (err) {
    if (err instanceof BoardSceneReadError) {
      throw new TRPCError({
        code:
          err.reason === "live_unavailable"
            ? "SERVICE_UNAVAILABLE"
            : "CONFLICT",
        message: `The version was not restored: ${err.message}`,
        cause: err,
      });
    }
    throw err;
  }
}

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

      if (!view.documentId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Whiteboard not properly initialized",
        });
      }

      const yjsRoomId = view.yjsRoomId ?? `whiteboard-${view.documentId}`;

      // Publish snapshot job via pg-boss
      const { getBoss } = await import("@synap/jobs");

      await getBoss().send("whiteboard-snapshot", {
        viewId: input.viewId,
        documentId: view.documentId,
        yjsRoomId,
        message: input.message || "Manual snapshot",
        userId: ctx.userId,
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

      const [versions, doc] = await Promise.all([
        db.query.documentVersions.findMany({
          where: eq(documentVersions.documentId, view.documentId),
          orderBy: desc(documentVersions.createdAt),
          limit: input.limit,
        }),
        db.query.documents.findFirst({
          where: eq(documents.id, view.documentId),
          columns: { currentVersion: true, lastSavedVersion: true },
        }),
      ]);

      return {
        versions,
        latest: doc
          ? {
              currentVersion: doc.currentVersion,
              lastSavedVersion: doc.lastSavedVersion ?? 0,
            }
          : { currentVersion: 1, lastSavedVersion: 0 },
      };
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

      if (!view?.documentId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Whiteboard not found",
        });
      }

      const yjsRoomId = view.yjsRoomId ?? `whiteboard-${view.documentId}`;

      // Get version
      // Get version: one OF THIS BOARD'S document (a version id of another
      // document is "not found", never restored into this board).
      const found = await db.query.documentVersions.findFirst({
        where: eq(documentVersions.id, input.versionId),
      });
      const version =
        found && found.documentId === view.documentId ? found : undefined;

      if (!version) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Version not found",
        });
      }

      // A room that failed to load its saved content refuses a restore (the
      // realtime bridge answers 409 inside the job, where the person never
      // sees it: their "Restoring…" never ended). Ask the room first and say
      // why here; a realtime server that does not answer is a refusal too.
      await assertRoomTakesRestore(yjsRoomId, view.documentId);

      // Publish restore job via pg-boss
      const { getBoss } = await import("@synap/jobs");

      const content = await readDocumentVersionContent(version);

      await getBoss().send("whiteboard-restore", {
        viewId: input.viewId,
        versionId: input.versionId,
        yjsRoomId,
        content,
        userId: ctx.userId,
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
    .query(async ({ input, ctx }) => {
      // Get version: one OF THIS BOARD'S document (a version id of another
      // document is "not found", never restored into this board).
      const found = await db.query.documentVersions.findFirst({
        where: eq(documentVersions.id, input.versionId),
      });
      const version =
        found && found.documentId === view.documentId ? found : undefined;

      if (!version) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Version not found",
        });
      }

      // Verify the parent document belongs to the caller (the version row has
      // no user/workspace of its own).
      const [doc] = await db
        .select({ userId: documents.userId })
        .from(documents)
        .where(eq(documents.id, version.documentId))
        .limit(1);
      if (!doc || doc.userId !== ctx.userId) {
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
          size: version.size || version.content.length,
          message: version.message,
          author: version.author,
          createdAt: version.createdAt,
          hasStoredSnapshot: !!version.storageKey,
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

      const version = remainingVersions.find((v) => v.id === input.versionId);
      if (!version) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Version not found",
        });
      }

      await db
        .delete(documentVersions)
        .where(eq(documentVersions.id, input.versionId));

      if (version.storageKey) {
        const { storage } = await import("@synap/storage");
        await storage.delete(version.storageKey).catch(() => undefined);
      }

      return { success: true };
    }),
});
