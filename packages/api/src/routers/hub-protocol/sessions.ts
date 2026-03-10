/**
 * Hub Protocol - Sessions Router
 *
 * Sessions are bounded interaction periods within a channel.
 * The intelligence service creates and manages sessions to track
 * which messages have been compacted and which are new.
 *
 * All operations require hub-protocol.write scope.
 * Sessions are internal system data — not directly user-visible.
 */

import { z } from "zod";
import { router } from "../../trpc.js";
import { scopedProcedure } from "../../middleware/api-key-auth.js";
import { TRPCError } from "@trpc/server";
import { db, eq, and, desc } from "@synap/database";
import { sessions, SessionStatus } from "@synap/database/schema";

export const sessionsRouter = router({
  /**
   * Get or create the active session for a channel.
   *
   * If an active session exists, return it.
   * If none exists, create a new one.
   *
   * Used at session start to ensure exactly one active session per channel.
   */
  getOrCreate: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        channelId: z.string().uuid(),
        bootstrapStateId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ input }) => {
      // Check for existing active session
      const existing = await db.query.sessions.findFirst({
        where: and(
          eq(sessions.channelId, input.channelId),
          eq(sessions.status, SessionStatus.ACTIVE)
        ),
        orderBy: [desc(sessions.startedAt)],
      });

      if (existing) {
        return existing;
      }

      // Create new session
      const [created] = await db
        .insert(sessions)
        .values({
          channelId: input.channelId,
          bootstrapStateId: input.bootstrapStateId ?? null,
          status: SessionStatus.ACTIVE,
        })
        .returning();

      return created;
    }),

  /**
   * Get the active session for a channel (read-only).
   * Returns null if no active session exists.
   */
  getActive: scopedProcedure(["hub-protocol.read"])
    .input(z.object({ channelId: z.string().uuid() }))
    .query(async ({ input }) => {
      const session = await db.query.sessions.findFirst({
        where: and(
          eq(sessions.channelId, input.channelId),
          eq(sessions.status, SessionStatus.ACTIVE)
        ),
        orderBy: [desc(sessions.startedAt)],
      });

      return session ?? null;
    }),

  /**
   * Get a session by ID.
   */
  get: scopedProcedure(["hub-protocol.read"])
    .input(z.object({ sessionId: z.string().uuid() }))
    .query(async ({ input }) => {
      const session = await db.query.sessions.findFirst({
        where: eq(sessions.id, input.sessionId),
      });

      if (!session) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Session not found",
        });
      }

      return session;
    }),

  /**
   * List recent sessions for a channel (newest first).
   */
  list: scopedProcedure(["hub-protocol.read"])
    .input(
      z.object({
        channelId: z.string().uuid(),
        limit: z.number().int().min(1).max(50).default(10),
      })
    )
    .query(async ({ input }) => {
      const rows = await db.query.sessions.findMany({
        where: eq(sessions.channelId, input.channelId),
        orderBy: [desc(sessions.startedAt)],
        limit: input.limit,
      });

      return rows;
    }),

  /**
   * Update session metrics and/or status.
   *
   * Called by the intelligence service to:
   * - Increment token usage after each agent response
   * - Set status to 'compacting' when starting compaction
   * - Set status to 'closed' + link producedStateId after compaction
   * - Link bootstrapStateId after initial state is created
   */
  update: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        sessionId: z.string().uuid(),
        status: z.enum(["active", "compacting", "closed"]).optional(),
        endedAt: z.string().datetime().optional(),
        bootstrapStateId: z.string().uuid().optional(),
        producedStateId: z.string().uuid().optional(),
        totalTokensUsed: z.number().int().min(0).optional(),
        messageCount: z.number().int().min(0).optional(),
        compactionCount: z.number().int().min(0).optional(),
        lastActivityAt: z.string().datetime().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const { sessionId, ...updates } = input;

      const updateData: Record<string, any> = {};
      if (updates.status !== undefined)
        updateData.status = updates.status as SessionStatus;
      if (updates.endedAt !== undefined)
        updateData.endedAt = new Date(updates.endedAt);
      if (updates.bootstrapStateId !== undefined)
        updateData.bootstrapStateId = updates.bootstrapStateId;
      if (updates.producedStateId !== undefined)
        updateData.producedStateId = updates.producedStateId;
      if (updates.totalTokensUsed !== undefined)
        updateData.totalTokensUsed = updates.totalTokensUsed;
      if (updates.messageCount !== undefined)
        updateData.messageCount = updates.messageCount;
      if (updates.compactionCount !== undefined)
        updateData.compactionCount = updates.compactionCount;
      if (updates.lastActivityAt !== undefined)
        updateData.lastActivityAt = new Date(updates.lastActivityAt);

      const [updated] = await db
        .update(sessions)
        .set(updateData)
        .where(eq(sessions.id, sessionId))
        .returning();

      if (!updated) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Session not found",
        });
      }

      return updated;
    }),

  /**
   * Close a session (set status='closed', endedAt=now).
   * Convenience mutation combining update + status transition.
   */
  close: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        sessionId: z.string().uuid(),
        producedStateId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const [updated] = await db
        .update(sessions)
        .set({
          status: SessionStatus.CLOSED,
          endedAt: new Date(),
          ...(input.producedStateId
            ? { producedStateId: input.producedStateId }
            : {}),
        })
        .where(eq(sessions.id, input.sessionId))
        .returning();

      if (!updated) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Session not found",
        });
      }

      return updated;
    }),
});
