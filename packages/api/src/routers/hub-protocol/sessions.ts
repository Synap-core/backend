/**
 * Hub Protocol - Sessions Router
 *
 * Sessions are bounded interaction periods within a channel.
 * The intelligence service creates and manages sessions to track
 * which messages have been compacted and which are new.
 *
 * All operations require hub-protocol.write scope.
 * Sessions are internal system data — not directly user-visible.
 *
 * SECURITY — every procedure here is floored by the CALLER's channel
 * visibility. A `sessions` row has no owner and no workspace column; its only
 * scoping column is `channel_id`, so visibility is derived from the channel via
 * `sessionVisibilityWhere` / `channelVisibilityWhere` (the one door — see
 * `utils/session-visibility.ts`). Without that floor, any holder of a
 * hub-protocol key could read, mutate, or close another user's session by
 * guessing a UUID. Per the convention in `hub-protocol/context.ts`, an
 * invisible row returns NOT_FOUND — never a 403 — so the two cases stay
 * indistinguishable and no existence oracle is created.
 */

import { z } from "zod";
import { router } from "../../trpc.js";
import { scopedProcedure } from "../../middleware/api-key-auth.js";
import { TRPCError } from "@trpc/server";
import { db, eq, and, desc } from "@synap/database";
import { sessions, channels, SessionStatus } from "@synap/database/schema";
import { channelVisibilityWhere } from "../../utils/channel-visibility.js";
import { sessionVisibilityWhere } from "../../utils/session-visibility.js";

/**
 * Floor a channel-scoped procedure: the caller must be able to SEE the channel
 * before any session under it is read or created. NOT_FOUND on invisible.
 */
async function assertChannelVisible(channelId: string, userId: string) {
  const row = await db
    .select({ id: channels.id })
    .from(channels)
    .where(and(eq(channels.id, channelId), channelVisibilityWhere(userId)))
    .limit(1);

  if (!row[0]) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Channel not found" });
  }
}

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
    .mutation(async ({ input, ctx }) => {
      await assertChannelVisible(input.channelId, ctx.userId!);

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
    .query(async ({ input, ctx }) => {
      await assertChannelVisible(input.channelId, ctx.userId!);

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
    .query(async ({ input, ctx }) => {
      const rows = await db
        .select()
        .from(sessions)
        .where(
          and(
            eq(sessions.id, input.sessionId),
            sessionVisibilityWhere(ctx.userId!)
          )
        )
        .limit(1);

      const session = rows[0];

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
    .query(async ({ input, ctx }) => {
      await assertChannelVisible(input.channelId, ctx.userId!);

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
    .mutation(async ({ input, ctx }) => {
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
        .where(
          and(eq(sessions.id, sessionId), sessionVisibilityWhere(ctx.userId!))
        )
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
    .mutation(async ({ input, ctx }) => {
      const [updated] = await db
        .update(sessions)
        .set({
          status: SessionStatus.CLOSED,
          endedAt: new Date(),
          ...(input.producedStateId
            ? { producedStateId: input.producedStateId }
            : {}),
        })
        .where(
          and(
            eq(sessions.id, input.sessionId),
            sessionVisibilityWhere(ctx.userId!)
          )
        )
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
