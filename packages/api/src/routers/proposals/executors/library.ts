import { TRPCError } from "@trpc/server";
import { defaultImportBuildDeps } from "../../../services/imports/build.js";
import {
  applyLibraryOrganize,
  LibraryOrganizeOpSchema,
  markOrganizeProposalApproved,
  organizeProposalApproved,
} from "../../../services/library/organize.js";
import {
  registerProposalExecutor,
  type ProposalExecutorArgs,
  type ProposalExecutorResult,
} from "../execution-registry.js";
import { reportApproved } from "./shared.js";

/**
 * Approval half of an agent's LIBRARY ORGANISATION
 * (`library/organize`, `services/library/organize.ts`).
 *
 * REPLAY, never reconstruct: the approved `ops` are re-parsed with the door's
 * own schema and applied by the SAME code the person's own edits run
 * (`curateLibrary`, then `buildLibraryGroup` per build request), re-floored
 * NOW on `proposals.subjectUserId` — the person the proposal was filed for,
 * never the payload. A row with no subject has no owner and is refused.
 * Atomic for the curate ops (a bad op writes nothing); a build that cannot
 * run (nothing new, a bundle still in review) is reported in `refusals`.
 */
export async function approveLibraryOrganize(
  args: ProposalExecutorArgs,
  /** Test seam: the apply (default: the real curate + build doors). */
  apply: typeof applyLibraryOrganize = applyLibraryOrganize
): Promise<ProposalExecutorResult> {
  const { proposal, userId, input, deps, ctx } = args;
  const refuse = (why: string) =>
    new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `Approval for 'library/organize' refused: ${why} Nothing was changed.`,
    });

  const raw = (proposal.data ?? {}) as Record<string, unknown>;
  const inner = (raw.data ?? raw) as Record<string, unknown>;
  const parsed = LibraryOrganizeOpSchema.array().min(1).safeParse(inner.ops);
  if (!parsed.success) {
    throw refuse("the proposal holds no valid Library operations.");
  }

  // Re-approve guard: dispatch is not status-guarded.
  if (await organizeProposalApproved(input.proposalId)) {
    return { success: true, alreadyApproved: true };
  }

  const ownerUserId = proposal.subjectUserId;
  if (!ownerUserId) {
    throw refuse(
      "the proposal records no owner (subject_user_id), so whose Library this is cannot be established."
    );
  }

  const applied = await apply({
    ownerUserId,
    ops: parsed.data,
    depsFor: (run) =>
      defaultImportBuildDeps({
        userId: ownerUserId,
        workspaceId: run.workspaceId,
        trpcCtx: { ...ctx, userId: ownerUserId },
      }),
  });

  await markOrganizeProposalApproved(input.proposalId, userId);

  reportApproved(deps, proposal, input.proposalId);
  deps.emitProposalReviewed(
    input.proposalId,
    proposal.workspaceId,
    "approved",
    userId
  );

  const groupIds = [
    ...new Set([
      ...(applied.curate?.createdGroupIds ?? []),
      ...(applied.curate?.changedGroupIds ?? []),
    ]),
  ];
  const refusals = applied.builds
    .filter((b) => b.result.status === "refused")
    .map(
      (b) =>
        `The build of group ${b.groupId} did not run: ${b.result.reason ?? "refused"}.`
    );
  const filed = applied.builds.filter((b) => b.result.proposalId);
  return {
    success: true,
    ...(groupIds[0] ? { primaryId: groupIds[0] } : {}),
    effect:
      groupIds.length || filed.length
        ? {
            applied: "verified",
            rows: groupIds.length + filed.length,
            ids: [...groupIds, ...filed.map((b) => b.result.proposalId!)],
            subject: "library_groups",
          }
        : {
            applied: "none",
            reason:
              "Every operation was already in place (or every build was refused).",
          },
    ...(refusals.length ? { refusals } : {}),
  };
}

export function registerLibraryExecutors(): void {
  registerProposalExecutor({
    key: "library/organize",
    execute: (args) => approveLibraryOrganize(args),
  });
}
