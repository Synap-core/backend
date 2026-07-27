/**
 * Hub Protocol - Proposals Router
 *
 * Allows Intelligence Hub to manage proposals on behalf of users.
 * Key operation: AI can update (revise) a pending proposal it created,
 * without re-running the full event pipeline.
 */

import { z } from "zod";
import { router } from "../../trpc.js";
import { scopedProcedure } from "../../middleware/api-key-auth.js";
import { db, proposals, eq, and, desc } from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import { userVisibleWhere } from "../../utils/user-visible-where.js";
import { mergeProposalRevision } from "../../services/proposals/proposals-service.js";

export const proposalsRouter = router({
  /**
   * List proposals for a user/workspace
   * Requires: hub-protocol.read scope
   */
  listProposals: scopedProcedure(["hub-protocol.read"])
    .input(
      z.object({
        userId: z.string(),
        workspaceId: z.string().uuid().optional(),
        targetType: z
          .enum(["document", "entity", "relation", "workspace", "view"])
          .optional(),
        status: z
          .enum(["pending", "approved", "rejected", "all"])
          .default("pending"),
        // Filter to a single focus session's proposals — the REST mirror of the
        // tRPC `proposals.list` sessionId filter, so external/BYOA agents can ask
        // "what has the AI proposed inside this session" without a tRPC client.
        sessionId: z.string().uuid().optional(),
        limit: z.number().default(50),
      })
    )
    .query(async ({ input, ctx }) => {
      // Scope to the caller's own workspaces (+ pod-wide) — without this the
      // optional-workspaceId filter degrades to a null-where that returns EVERY
      // proposal on the pod (all users, all workspaces).
      const conditions = [
        userVisibleWhere(proposals.workspaceId, ctx.userId as string),
      ];

      if (input.workspaceId) {
        conditions.push(eq(proposals.workspaceId, input.workspaceId));
      }
      if (input.targetType) {
        conditions.push(eq(proposals.targetType, input.targetType));
      }
      if (input.sessionId) {
        conditions.push(eq(proposals.sessionId, input.sessionId));
      }
      if (input.status !== "all") {
        const statusMap = {
          pending: ProposalStatus.PENDING,
          approved: ProposalStatus.APPROVED,
          rejected: ProposalStatus.REJECTED,
        } as const;
        conditions.push(eq(proposals.status, statusMap[input.status]));
      }

      const items = await db.query.proposals.findMany({
        where: conditions.length > 0 ? and(...conditions) : undefined,
        orderBy: desc(proposals.createdAt),
        limit: input.limit,
      });

      return { proposals: items };
    }),

  /**
   * Update a pending proposal (AI revises its own suggestion before user approves)
   *
   * Use case: AI created a proposal to update entity X. Before the user approves,
   * the AI discovers better information and wants to revise the proposal data.
   * This is a direct DB update — no event pipeline re-run needed.
   *
   * Requires: hub-protocol.write scope
   * Constraint: proposal must still be in "pending" status
   */
  updateProposal: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        proposalId: z.string().uuid(),
        /** New data payload (replaces existing proposal.data) */
        data: z.record(z.string(), z.unknown()),
        /** Optional: update the human-readable summary of the change */
        summary: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // The IS `update_proposal` tool sends FLAT INNER fields ("Must match the
      // original proposal's structure (e.g. entity fields for entity
      // proposals)") — or a composite `{ operations }`. Route through the ONE
      // shared revise core as an INNER patch: for a nested-reader envelope it
      // now lands in `data.data` (the slot the approve executors read) instead
      // of as junk top-level keys — the silent-drop bug — while flat envelopes
      // (document / composite / capability.* / workspace/*) still merge at the
      // top level. The core row-locks + asserts PENDING (CONFLICT, not silent
      // success) and appends a `revisionHistory` entry.
      await mergeProposalRevision({
        proposalId: input.proposalId,
        actorId: ctx.userId as string,
        patch: { kind: "inner", fields: input.data },
        summary: input.summary,
      });

      return {
        success: true,
        proposalId: input.proposalId,
        message: "Proposal updated successfully",
      };
    }),
});
