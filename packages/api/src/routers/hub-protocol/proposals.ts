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
import { db, proposals, eq, and, desc, count } from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import { proposalUserFloor } from "../proposals/scope-conditions.js";
import { mergeProposalRevision } from "../../services/proposals/proposals-service.js";
import {
  PROPOSAL_STATUS_FILTERS,
  withProposalClass,
  type ProposalStatusFilter,
} from "./rest/_codecs/proposal.js";

/** Filter string → the stored `proposals.status` value ("all" = no filter). */
export const PROPOSAL_STATUS_BY_FILTER = {
  pending: ProposalStatus.PENDING,
  approved: ProposalStatus.APPROVED,
  rejected: ProposalStatus.REJECTED,
  auto_approved: ProposalStatus.AUTO_APPROVED,
  reverted: ProposalStatus.REVERTED,
  approval_failed: ProposalStatus.APPROVAL_FAILED,
  withdrawn: ProposalStatus.WITHDRAWN,
  expired: ProposalStatus.EXPIRED,
} as const satisfies Record<
  Exclude<ProposalStatusFilter, "all">,
  ProposalStatus
>;

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
        status: z.enum(PROPOSAL_STATUS_FILTERS).default("pending"),
        // Filter to a single focus session's proposals — the REST mirror of the
        // tRPC `proposals.list` sessionId filter, so external/BYOA agents can ask
        // "what has the AI proposed inside this session" without a tRPC client.
        sessionId: z.string().uuid().optional(),
        // Bounded, and paired with `offset` + a `total` in the result. Before
        // this, `limit` had no ceiling, there was no `offset` at all, and the
        // response carried no count — so every caller rendered `items.length`
        // as if it were the number of pending decisions. Three surfaces showed
        // three different totals for one question (322 / 100 / 50), two of them
        // page sizes wearing a total's clothes, and rows past the first page
        // were unreachable through this door entirely.
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
      })
    )
    .query(async ({ input, ctx }) => {
      // The SAME user floor `proposals.list` / `proposals.groups` / `signals`
      // build (`proposalUserFloor`, routers/proposals/scope-conditions.ts) —
      // LENS ∪ OWNERSHIP. Without a floor at all, the optional-workspaceId
      // filter degrades to a null-where that returns EVERY proposal on the pod
      // (all users, all workspaces).
      //
      // The floor is kept as its own condition and `workspaceId` is AND-ed on
      // top, rather than passing the three-state through
      // `buildProposalScopeConditions`: that builder REPLACES the floor with an
      // equality when a concrete workspace is named, which is safe only because
      // its tRPC callers separately run the `assertProposalWorkspaceRead`
      // editor+ gate. This door has no such gate, so replacing the floor here
      // would let any hub caller name any workspace id and read it.
      const conditions = [proposalUserFloor(ctx.userId as string)];

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
        conditions.push(
          eq(proposals.status, PROPOSAL_STATUS_BY_FILTER[input.status])
        );
      }

      const where = conditions.length > 0 ? and(...conditions) : undefined;

      // COUNT the matching set, not the returned page. `total` is what a caller
      // needs to say "12 of 322"; without it the only honest thing a UI can
      // render is "at least N", and none of them did.
      const [items, counted] = await Promise.all([
        db.query.proposals.findMany({
          where,
          orderBy: desc(proposals.createdAt),
          limit: input.limit,
          offset: input.offset,
        }),
        db.select({ total: count() }).from(proposals).where(where),
      ]);

      const total = Number(counted[0]?.total ?? 0);

      return {
        // Class + lifetime stamped through the SAME door the REST/MCP codecs
        // use, so a `view=full` row and a `view=basic` row can never disagree
        // about what class a proposal is.
        proposals: items.map((row) => withProposalClass(row)),
        total,
        limit: input.limit,
        offset: input.offset,
        // Derived here rather than left to each caller to recompute from three
        // fields — the recomputation is exactly where an off-by-one lands.
        hasMore: input.offset + items.length < total,
      };
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
      // AUTHORITY: this door passes a raw caller-supplied `proposalId` and used
      // to reach the revise core with NO ownership/review predicate — any
      // hub-protocol.write key could rewrite the `summary`/`reasoning` a human
      // reads before approving ANY pending proposal on the pod. The
      // reviewer-authority ladder (`computeCanReviewApproval`) now runs INSIDE
      // `mergeProposalRevision` — the one shared core all three revise doors
      // (tRPC / Hub / MCP) funnel through — so it cannot be missed here again.
      // `ctx.userId` is the authenticated key owner (an agent key is remapped to
      // its human owner by `api-key-auth.ts`), which is what the ladder gates on.

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
