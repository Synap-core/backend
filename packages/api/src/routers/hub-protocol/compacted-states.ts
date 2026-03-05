/**
 * Hub Protocol - Compacted States Router
 *
 * Compacted states are structured memory snapshots produced by the compaction
 * engine at the end of a session. They contain 5 memory blocks that the bootstrap
 * assembler uses to construct the system prompt deterministically — no LLM call.
 *
 * All operations require hub-protocol.write (for create) or hub-protocol.read (for reads).
 */

import { z } from "zod";
import { router } from "../../trpc.js";
import { scopedProcedure } from "../../middleware/api-key-auth.js";
import { TRPCError } from "@trpc/server";
import { db, eq, desc } from "@synap/database";
import { compactedStates } from "@synap/database/schema";

const CompactedStateMetadataSchema = z
  .object({
    compactionDurationMs: z.number().optional(),
    qualityScore: z.number().min(0).max(1).optional(),
    messagesCompacted: z.number().int().optional(),
    midSessionCompaction: z.boolean().optional(),
    previousStateId: z.string().optional(),
  })
  .optional();

export const compactedStatesRouter = router({
  /**
   * Create a new compacted state for a channel.
   *
   * Version is auto-incremented if not provided.
   * Returns the created state with its assigned version.
   */
  create: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        channelId: z.string().uuid(),
        sessionId: z.string().uuid().optional(),
        // Version is optional — auto-incremented if not provided
        version: z.number().int().positive().optional(),

        // The five memory blocks
        identityBlock: z.string().default(""),
        userModelBlock: z.string().default(""),
        continuityBlock: z.string().default(""),
        activeGoalsBlock: z.string().default(""),
        entityContextBlock: z.string().default(""),

        // Compression metrics
        rawTokenCount: z.number().int().optional(),
        compressedTokenCount: z.number().int().optional(),

        // Operational
        compactionModel: z.string().optional(),
        metadata: CompactedStateMetadataSchema,
      })
    )
    .mutation(async ({ input }) => {
      // Auto-increment version if not provided
      let version = input.version;
      if (version === undefined) {
        const latest = await db.query.compactedStates.findFirst({
          where: eq(compactedStates.channelId, input.channelId),
          orderBy: [desc(compactedStates.version)],
          columns: { version: true },
        });
        version = (latest?.version ?? 0) + 1;
      }

      const [created] = await db
        .insert(compactedStates)
        .values({
          channelId: input.channelId,
          sessionId: input.sessionId ?? null,
          version,
          identityBlock: input.identityBlock,
          userModelBlock: input.userModelBlock,
          continuityBlock: input.continuityBlock,
          activeGoalsBlock: input.activeGoalsBlock,
          entityContextBlock: input.entityContextBlock,
          rawTokenCount: input.rawTokenCount ?? null,
          compressedTokenCount: input.compressedTokenCount ?? null,
          compactionModel: input.compactionModel ?? null,
          metadata: input.metadata ?? null,
        })
        .returning();

      return created;
    }),

  /**
   * Get the latest compacted state for a channel.
   *
   * This is the primary read path — called by the bootstrap assembler
   * at the start of every new session.
   *
   * Returns null if no state exists yet (brand new channel).
   */
  getLatest: scopedProcedure(["hub-protocol.read"])
    .input(z.object({ channelId: z.string().uuid() }))
    .query(async ({ input }) => {
      const state = await db.query.compactedStates.findFirst({
        where: eq(compactedStates.channelId, input.channelId),
        orderBy: [desc(compactedStates.version)],
      });

      return state ?? null;
    }),

  /**
   * Get a specific compacted state by ID.
   */
  get: scopedProcedure(["hub-protocol.read"])
    .input(z.object({ stateId: z.string().uuid() }))
    .query(async ({ input }) => {
      const state = await db.query.compactedStates.findFirst({
        where: eq(compactedStates.id, input.stateId),
      });

      if (!state) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Compacted state not found",
        });
      }

      return state;
    }),

  /**
   * List recent compacted states for a channel (for debugging / version history).
   */
  list: scopedProcedure(["hub-protocol.read"])
    .input(
      z.object({
        channelId: z.string().uuid(),
        limit: z.number().int().min(1).max(20).default(5),
      })
    )
    .query(async ({ input }) => {
      const rows = await db.query.compactedStates.findMany({
        where: eq(compactedStates.channelId, input.channelId),
        orderBy: [desc(compactedStates.version)],
        limit: input.limit,
        // Return metadata + metrics but not full block content for list view
        columns: {
          id: true,
          channelId: true,
          sessionId: true,
          version: true,
          createdAt: true,
          rawTokenCount: true,
          compressedTokenCount: true,
          compactionModel: true,
          metadata: true,
        },
      });

      return rows;
    }),
});
