import { TRPCError } from "@trpc/server";
import { db, proposals, eq } from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import { applyProjectFiling } from "../../../services/projects/file-entities.js";
import {
  registerProposalExecutor,
  type ProposalExecutorArgs,
  type ProposalExecutorResult,
} from "../execution-registry.js";
import { reportApproved } from "./shared.js";

/**
 * Approval half of PROJECT FILING (`services/projects/file-entities.ts`).
 *
 *   project/file_entities   → file the batch (this module's executor)
 *   link/delete (belongs_to_project) → un-file the batch (`executors/link.ts`
 *                             dispatches here via {@link approveProjectFiling})
 *
 * REPLAY, never reconstruct: the SAME `applyProjectFiling` the direct path
 * runs, re-floored NOW on `proposals.subjectUserId` — the principal the
 * proposal was filed FOR, never the approver and never the payload. A row with
 * no subject has no owner to floor on and is refused.
 */
export async function approveProjectFiling(
  args: ProposalExecutorArgs,
  remove: boolean
): Promise<ProposalExecutorResult> {
  const { proposal, userId, input, deps } = args;
  const key = remove ? "link/delete" : "project/file_entities";
  const refuse = (why: string) =>
    new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `Approval for '${key}' refused: ${why} Nothing was changed.`,
    });

  const raw = (proposal.data ?? {}) as Record<string, unknown>;
  const inner = (raw.data ?? raw) as Record<string, unknown>;
  const projectId = remove ? inner.toId : inner.projectId;
  const entityIds = Array.isArray(inner.entityIds)
    ? inner.entityIds.filter((v): v is string => typeof v === "string")
    : [];
  if (typeof projectId !== "string" || entityIds.length === 0) {
    throw refuse("the proposal names no project or no records.");
  }

  // Re-approve guard: dispatch is not status-guarded.
  const [current] = await db
    .select({ status: proposals.status })
    .from(proposals)
    .where(eq(proposals.id, input.proposalId));
  if (current?.status === ProposalStatus.APPROVED) {
    return { success: true, alreadyApproved: true };
  }

  const ownerUserId = proposal.subjectUserId;
  if (!ownerUserId) {
    throw refuse(
      "the proposal records no owner (subject_user_id), so whose records these are cannot be established."
    );
  }

  const result = await applyProjectFiling({
    ownerUserId,
    projectId,
    entityIds,
    remove,
  });

  await db
    .update(proposals)
    .set({
      status: ProposalStatus.APPROVED,
      reviewedBy: userId,
      reviewedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(proposals.id, input.proposalId));

  reportApproved(deps, proposal, input.proposalId);
  deps.emitProposalReviewed(
    input.proposalId,
    proposal.workspaceId,
    "approved",
    userId
  );

  // `rows` is the statement's own count: the insert RETURNING per record, or
  // the DELETE's RETURNING. `0` = everything was already in (or already out).
  if (result.status === "filed") {
    return {
      success: true,
      primaryId: projectId,
      effect: {
        applied: "verified",
        rows: result.filed.length,
        ids: result.filed,
        subject: "relations",
      },
    };
  }
  return {
    success: true,
    primaryId: projectId,
    effect: {
      applied: "verified",
      rows: result.removedRelationIds.length,
      ids: result.removedRelationIds,
      subject: "relations",
    },
  };
}

export function registerProjectFilingExecutors(): void {
  registerProposalExecutor({
    key: "project/file_entities",
    execute: (args) => approveProjectFiling(args, false),
  });
}
