/**
 * The approval half of the whiteboard place door (`placeOnBoard`,
 * services/whiteboards/place-on-board.ts). Each executor replays the SAME core
 * the door runs when governance grants the write, as the APPROVER:
 *
 *  - `whiteboard/place`: `applyPlacement` with the proposal's placement key
 *    (so the shape ids are the ones the proposal announced) and no pending
 *    mark (the person approved it); `placedBy` names the agent, the person and
 *    the proposal.
 *  - `whiteboard/update_shapes` / `whiteboard/delete_shapes`:
 *    `applyShapeChanges`. A shape that is gone since the proposal refuses the
 *    approval (nothing half-applied); the proposal stays pending.
 *
 * Floor: the approver's own `edit` on the board's room
 * (`resolveBoardForApprover`). Replays are idempotent (records replace
 * themselves by id), and the proposal flips to APPROVED only after the write
 * landed.
 */

import { TRPCError } from "@trpc/server";
import { db, eq, and, proposals, transitionProposal } from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import {
  BoardResourceRefSchema,
  BoardPlacementOptionsSchema,
  BoardShapeUpdateSchema,
} from "@synap-core/types/whiteboard";
import {
  registerProposalExecutor,
  type ProposalRow,
} from "../execution-registry.js";
import { reportApproved } from "./shared.js";
import {
  BoardPlaceError,
  applyPlacement,
  applyShapeChanges,
  resolveBoardForApprover,
} from "../../../services/whiteboards/place-on-board.js";

type Row = ProposalRow;

function innerData(proposal: Row): Record<string, unknown> {
  return ((proposal.data as Record<string, unknown>)?.data ?? {}) as Record<
    string,
    unknown
  >;
}

function bad(message: string): TRPCError {
  return new TRPCError({ code: "BAD_REQUEST", message });
}

/** A place-door refusal, as the approval surface words it. */
function asTrpc(err: unknown): unknown {
  if (!(err instanceof BoardPlaceError)) return err;
  const code =
    err.status === 404
      ? "NOT_FOUND"
      : err.status === 403
        ? "FORBIDDEN"
        : err.status === 409
          ? "CONFLICT"
          : err.status === 400
            ? "BAD_REQUEST"
            : "INTERNAL_SERVER_ERROR";
  return new TRPCError({
    code,
    message: `${err.message} (reason: ${err.reason})`,
  });
}

function viewIdOf(data: Record<string, unknown>): string {
  const viewId = data.viewId;
  if (typeof viewId !== "string" || !viewId) {
    throw bad("Whiteboard proposal is missing its board (viewId).");
  }
  return viewId;
}

/** Who placed it: the person it was for, the agent, the proposal. */
function placedByOf(proposal: Row, approverUserId: string) {
  return {
    userId: proposal.subjectUserId ?? approverUserId,
    ...(proposal.agentUserId ? { agentUserId: proposal.agentUserId } : {}),
    proposalId: proposal.id,
  };
}

async function markApproved(
  proposalId: string,
  userId: string
): Promise<boolean> {
  const [claimed] = await transitionProposal(db, {
    to: ProposalStatus.APPROVED,
    set: { reviewedBy: userId, reviewedAt: new Date(), updatedAt: new Date() },
    where: and(
      eq(proposals.id, proposalId),
      eq(proposals.status, ProposalStatus.PENDING)
    ),
  }).returning({ id: proposals.id });
  return Boolean(claimed);
}

/** Register the whiteboard/* approve executors. */
export function registerWhiteboardExecutors(): void {
  registerProposalExecutor({
    key: "whiteboard/place",
    async execute({ proposal, userId, input, deps }) {
      const data = innerData(proposal);
      const viewId = viewIdOf(data);
      const resources = BoardResourceRefSchema.array().safeParse(
        data.resources
      );
      const options = BoardPlacementOptionsSchema.optional().safeParse(
        data.options
      );
      const placementKey = data.placementKey;
      if (
        !resources.success ||
        resources.data.length === 0 ||
        !options.success ||
        typeof placementKey !== "string"
      ) {
        throw bad(
          "Whiteboard placement proposal is missing its resources or placement key."
        );
      }
      try {
        const board = await resolveBoardForApprover(viewId, userId);
        await applyPlacement({
          board,
          userId: proposal.subjectUserId ?? userId,
          agentUserId: proposal.agentUserId ?? null,
          resources: resources.data,
          options: options.data,
          placementKey,
          placedBy: placedByOf(proposal, userId),
          pending: false,
        });
      } catch (err) {
        throw asTrpc(err);
      }
      if (!(await markApproved(input.proposalId, userId))) {
        return { success: true, alreadyApproved: true };
      }
      reportApproved(deps, proposal, input.proposalId);
      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return { success: true };
    },
  });

  registerProposalExecutor({
    key: "whiteboard/update_shapes",
    async execute({ proposal, userId, input, deps }) {
      const data = innerData(proposal);
      const viewId = viewIdOf(data);
      const update = BoardShapeUpdateSchema.array().safeParse(data.update);
      if (!update.success || update.data.length === 0) {
        throw bad("Whiteboard change proposal is missing its shape changes.");
      }
      try {
        const board = await resolveBoardForApprover(viewId, userId);
        await applyShapeChanges({
          board,
          update: update.data,
          actor: placedByOf(proposal, userId),
        });
      } catch (err) {
        throw asTrpc(err);
      }
      if (!(await markApproved(input.proposalId, userId))) {
        return { success: true, alreadyApproved: true };
      }
      reportApproved(deps, proposal, input.proposalId);
      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return { success: true };
    },
  });

  registerProposalExecutor({
    key: "whiteboard/delete_shapes",
    async execute({ proposal, userId, input, deps }) {
      const data = innerData(proposal);
      const viewId = viewIdOf(data);
      const shapeIds = Array.isArray(data.shapeIds)
        ? data.shapeIds.filter(
            (id): id is string =>
              typeof id === "string" && id.startsWith("shape:")
          )
        : [];
      if (shapeIds.length === 0) {
        throw bad("Whiteboard removal proposal is missing its shape ids.");
      }
      try {
        const board = await resolveBoardForApprover(viewId, userId);
        await applyShapeChanges({
          board,
          remove: shapeIds,
          actor: placedByOf(proposal, userId),
        });
      } catch (err) {
        throw asTrpc(err);
      }
      if (!(await markApproved(input.proposalId, userId))) {
        return { success: true, alreadyApproved: true };
      }
      reportApproved(deps, proposal, input.proposalId);
      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return { success: true };
    },
  });
}
