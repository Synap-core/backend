/**
 * TRACK proposal executors (0272) — the approval half of every governed track
 * write. Registering them is NOT optional: without an executor the star-slash-
 * star catch-all throws NOT_IMPLEMENTED, the reviewer approves, and nothing
 * happens (`__tripwires__/governed-writes-have-approval-half.test.ts`).
 *
 *   track/create               → `startTrack` (the SAME service the direct door
 *                                runs), with the id the proposal was filed under.
 *   track/update               → a status change (`applyTrackStatus`) or a stage
 *                                advance (`applyTrackStageAdvance`, gate OFF —
 *                                the reviewer just answered for this advance).
 *   track/playbook.stage_gate  → flip the paused track back to active. APPROVAL
 *                                RESUMES, IT NEVER RUNS (same contract as
 *                                `focus_session/playbook.stage_gate`).
 *
 * Replays act as the APPROVER. Unlike `project/*` (whose repository update is
 * owner-predicated, which is why those executors act as the project owner),
 * no track write is owner-floored: the approver's own write floor on the
 * project (`assertWorkspaceWrite`, re-run inside the service) is exactly the
 * authority an approval confers.
 */

import { TRPCError } from "@trpc/server";
import { db, proposals, eq } from "@synap/database";
import {
  PROJECT_TRACK_STATUSES,
  ProposalStatus,
  type ProjectTrackStatus,
} from "@synap/database/schema";
import { CHECK_GATE_METADATA_KEY } from "@synap-core/types/focus-sessions";
import {
  registerProposalExecutor,
  type ProposalEffect,
} from "../execution-registry.js";
import { assertApplied, reportApproved } from "./shared.js";
import {
  startTrack,
  getTrack,
  applyTrackStatus,
  applyTrackStageAdvance,
  assertStageAdvanceable,
  assertTrackTransition,
} from "../../../services/tracks/tracks-service.js";
import { trackRepository } from "../../../services/tracks/track-repo.js";
import { loadVisibleProject } from "../../../services/projects/load-visible-project.js";
import { assertWorkspaceWrite } from "../../../utils/workspace-write-access.js";

function innerData(proposal: { data: unknown }): Record<string, unknown> {
  return ((proposal.data as Record<string, unknown>)?.data ?? {}) as Record<
    string,
    unknown
  >;
}

async function alreadyApproved(proposalId: string): Promise<boolean> {
  const [row] = await db
    .select({ status: proposals.status })
    .from(proposals)
    .where(eq(proposals.id, proposalId));
  return row?.status === ProposalStatus.APPROVED;
}

async function markApproved(proposalId: string, userId: string) {
  await db
    .update(proposals)
    .set({
      status: ProposalStatus.APPROVED,
      reviewedBy: userId,
      reviewedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(proposals.id, proposalId));
}

export function registerTrackExecutors(): void {
  registerProposalExecutor({
    key: "track/create",
    async execute({ proposal, userId, input, deps }) {
      const data = innerData(proposal);
      const projectId = data.projectId as string | undefined;
      const playbookId = data.playbookId as string | undefined;
      if (!projectId || !playbookId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Track proposal is missing its project or method",
        });
      }
      if (await alreadyApproved(input.proposalId)) {
        return { success: true, alreadyApproved: true };
      }

      // The SAME door the direct path runs: both visibility floors, the scope
      // check and the write floor are re-evaluated at approval time, and the
      // method is pinned as it stands NOW. The replay must APPLY, never
      // re-propose — see `assertApplied`.
      const result = await startTrack({
        projectId,
        playbookId,
        name: typeof data.name === "string" ? data.name : undefined,
        id: typeof data.id === "string" ? data.id : undefined,
        actor: { userId },
      });
      assertApplied(result);

      await markApproved(input.proposalId, userId);
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
    key: "track/update",
    async execute({ proposal, userId, input, deps }) {
      const data = innerData(proposal);
      const trackId = (data.id as string | undefined) ?? proposal.targetId;
      if (!trackId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Track update proposal is missing its track",
        });
      }
      if (await alreadyApproved(input.proposalId)) {
        return { success: true, alreadyApproved: true };
      }

      const actor = { userId };
      const track = await getTrack(trackId, actor);
      if (!track) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Track to update no longer exists",
        });
      }
      const project = await loadVisibleProject(db, track.projectId, userId);
      if (!project) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Track not found" });
      }
      await assertWorkspaceWrite(db, userId, {
        workspaceId: project.workspaceId,
        ownerId: project.workspaceId ? undefined : project.userId,
      });

      if (typeof data.currentStage === "string") {
        assertStageAdvanceable(track, data.currentStage);
        await applyTrackStageAdvance({
          track,
          project,
          toStage: data.currentStage,
          userId,
          gate: false,
        });
      } else if (
        typeof data.status === "string" &&
        (PROJECT_TRACK_STATUSES as readonly string[]).includes(data.status)
      ) {
        if (track.status !== data.status) {
          // The table is re-checked at APPROVAL time: the proposal was legal
          // when filed, but the track may have moved since (archived, say).
          // Replaying unchecked would revive it — and a revived live method
          // collides with `uniq_project_tracks_live_method`.
          assertTrackTransition(track, data.status as ProjectTrackStatus);
          await applyTrackStatus(
            track,
            project,
            data.status as ProjectTrackStatus,
            userId
          );
        }
      } else {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Track update proposal carries neither a stage nor a status",
        });
      }

      await markApproved(input.proposalId, userId);
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
    key: "track/playbook.stage_gate",
    async execute({ proposal, userId, input, deps }) {
      const trackId = proposal.targetId;
      if (!trackId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Stage-gate proposal is missing its track target",
        });
      }
      // Resume ONLY from `paused`, guarded in the WHERE so the decision and the
      // write cannot disagree. A track since completed/archived stays so.
      // Through the repository: the resume emits `track.update.completed`, and
      // clears any check-gate marker (a resumed track is held by nothing).
      const row = await (
        await trackRepository()
      ).transitionStatus(
        trackId,
        {
          from: "paused",
          to: "active",
          dropMetadataKey: CHECK_GATE_METADATA_KEY,
        },
        userId
      );
      const resumed = row ? [{ id: row.id }] : [];

      const effect: ProposalEffect =
        resumed.length > 0
          ? {
              applied: "verified",
              rows: resumed.length,
              ids: resumed.map((r) => r.id),
              subject: "track",
            }
          : {
              applied: "none",
              reason:
                "Track was not paused at approval time — it had already been " +
                "resumed, completed or archived. The gate is answered; the track " +
                "keeps the state its owner left it in.",
            };

      await markApproved(input.proposalId, userId);
      reportApproved(deps, proposal, input.proposalId);
      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return { success: true, effect };
    },
  });
}
