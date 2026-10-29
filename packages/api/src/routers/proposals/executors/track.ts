/**
 * TRACK proposal executors (0272) — the approval half of every governed track
 * write. Registering them is NOT optional: without an executor the star-slash-
 * star catch-all throws NOT_IMPLEMENTED, the reviewer approves, and nothing
 * happens (`__tripwires__/governed-writes-have-approval-half.test.ts`).
 *
 *   track/create               → `startTrack` (the SAME service the direct door
 *                                runs), with the id the proposal was filed under
 *                                — a reopen too (`replacesTrackId`, R8), and
 *                                "Make it a goal" (`fromEntity`, D2: the link
 *                                and an ended entity's close ride the start).
 *   track/update               → a status change (`applyTrackStatus`, with the
 *                                verdict a close carries — the approver is who
 *                                closed it), a stage
 *                                advance (`applyTrackStageAdvance`, gate OFF —
 *                                the reviewer just answered for this advance),
 *                                a params patch (`applyTrackParams`, re-validated
 *                                against the pinned params at approval), an
 *                                emergent stage (`applyTrackStageAdd`) or a
 *                                direction / KPI patch (`applyTrackDirection`).
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
  applyTrackParams,
  applyTrackDirection,
  applyTrackStageAdd,
  parseAddTrackStage,
  assertStageAdvanceable,
  assertTrackTransition,
  loadGoalCloseCriteria,
} from "../../../services/tracks/tracks-service.js";
import {
  hasTrackGoalInput,
  pickTrackGoalInput,
} from "../../../services/tracks/goal-content.js";
import { trackRepository } from "../../../services/tracks/track-repo.js";
import { readListedStepSpaces } from "../../../services/tracks/track-space-grant.js";
import { readTrackFromEntity } from "../../../services/tracks/goal-source-entity.js";
import { loadVisibleProject } from "../../../services/projects/load-visible-project.js";
import { assertWorkspaceWrite } from "../../../utils/workspace-write-access.js";
import { lifecycleConflictError } from "../../../services/lifecycle/conflict.js";
import {
  applyTrackParticipantProposal,
  registerTrackParticipantExecutors,
} from "./track-participants.js";

function innerData(proposal: { data: unknown }): Record<string, unknown> {
  return ((proposal.data as Record<string, unknown>)?.data ?? {}) as Record<
    string,
    unknown
  >;
}

export async function alreadyApproved(proposalId: string): Promise<boolean> {
  const [row] = await db
    .select({ status: proposals.status })
    .from(proposals)
    .where(eq(proposals.id, proposalId));
  return row?.status === ProposalStatus.APPROVED;
}

export async function markApproved(proposalId: string, userId: string) {
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
  // The goal hand-off (`track/assign_agent`, W3) — its own file.
  registerTrackParticipantExecutors();

  registerProposalExecutor({
    key: "track/create",
    async execute({ proposal, userId, input, deps }) {
      const data = innerData(proposal);
      const projectId = data.projectId as string | undefined;
      // The method is OPTIONAL (W1): a stage-less track's proposal names none.
      const playbookId =
        typeof data.playbookId === "string" ? data.playbookId : null;
      if (!projectId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Goal proposal is missing its project",
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
        // Re-validated by the same door against the method at approval.
        ...(data.params && typeof data.params === "object"
          ? { params: data.params as Record<string, unknown> }
          : {}),
        // The goal rides the proposal too — a lasting track's direction and
        // KPI are what it IS; replaying without them dropped both.
        ...(typeof data.direction === "string"
          ? { direction: data.direction }
          : {}),
        ...(data.kpi && typeof data.kpi === "object" ? { kpi: data.kpi } : {}),
        // What the goal holds (0345) — re-parsed by the same door; the
        // approver's start confirms the kind of work it carries.
        ...pickTrackGoalInput(data),
        // A reopen (R8): re-checked by the same door (still closed, still the
        // newest version), then linked `new --replaces--> old`.
        ...(typeof data.replacesTrackId === "string"
          ? { replacesTrackId: data.replacesTrackId }
          : {}),
        // Keep it running (R6): re-checked by the same door (still closed as
        // met), then linked `new --spawned_from--> old`.
        ...(typeof data.spawnedFromTrackId === "string"
          ? { spawnedFromTrackId: data.spawnedFromTrackId }
          : {}),
        // "Make it a goal" (D2): re-checked by the same door (still visible,
        // never converted twice), then linked `entity --promoted_to--> track`
        // and, for an entity that had ended, closed or dropped — as the
        // approver.
        fromEntity: readTrackFromEntity(data.fromEntity),
        // Decision 2a: this approval IS the consent to the spaces the
        // proposal listed, for the agent the proposal's COLUMN names.
        approvedSpaceGrant: {
          proposalId: input.proposalId,
          agentUserId: proposal.agentUserId ?? null,
          listedWorkspaceIds: readListedStepSpaces(data),
        },
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
          message: "Goal update proposal is missing its goal",
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
          message: "Goal to update no longer exists",
        });
      }
      const project = await loadVisibleProject(db, track.projectId, userId);
      if (!project) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Goal not found" });
      }
      await assertWorkspaceWrite(db, userId, {
        workspaceId: project.workspaceId,
        ownerId: project.workspaceId ? undefined : project.userId,
      });

      if (data.participant && typeof data.participant === "object") {
        // WHO IS ON IT (W3): an agent's participant change, re-checked with
        // the APPROVER as the deciding person (`track-participants.ts`).
        await applyTrackParticipantProposal({
          track,
          proposal,
          approverId: userId,
        });
      } else if (typeof data.currentStage === "string") {
        assertStageAdvanceable(track, data.currentStage);
        await applyTrackStageAdvance({
          track,
          project,
          toStage: data.currentStage,
          userId,
          // The history `actor` is the PROPOSING agent, as the proposal
          // records it — the approver is `userId`, not who drove the move.
          agentUserId: proposal.agentUserId ?? null,
          gate: false,
        });
      } else if (
        data.params &&
        typeof data.params === "object" &&
        !Array.isArray(data.params)
      ) {
        // Merged onto the answers as they stand NOW and re-validated against
        // the pinned params — a mistyped answer refuses the approval.
        await applyTrackParams(
          track,
          data.params as Record<string, unknown>,
          userId
        );
      } else if (
        data.addStage &&
        typeof data.addStage === "object" &&
        !Array.isArray(data.addStage)
      ) {
        // An EMERGENT stage (0302). Re-parsed and re-checked against the stage
        // list as it stands NOW (a key taken since refuses); `addedBy` is the
        // PROPOSING agent, as the proposal records it.
        const stage = parseAddTrackStage(data.addStage);
        await applyTrackStageAdd(
          track,
          { ...stage, key: stage.key ?? "" },
          { userId, addedBy: proposal.agentUserId ?? userId }
        );
      } else if (
        "direction" in data ||
        "kpi" in data ||
        hasTrackGoalInput(data)
      ) {
        // Direction / KPI (0302): the PATCH, merged onto the KPI as it stands
        // at approval and re-validated; `current` is stamped as stated by the
        // proposing agent at the approval moment. What the goal holds (0345)
        // rides along, re-resolved against the goal as it stands now — and
        // the APPROVER confirms the kind of work it carries.
        await applyTrackDirection(
          track,
          project,
          {
            ...("direction" in data
              ? {
                  direction:
                    typeof data.direction === "string" ? data.direction : null,
                }
              : {}),
            ...("kpi" in data
              ? {
                  kpi:
                    data.kpi && typeof data.kpi === "object"
                      ? (data.kpi as Record<string, unknown>)
                      : null,
                }
              : {}),
            ...pickTrackGoalInput(data),
          },
          {
            userId,
            statedBy: proposal.agentUserId ?? userId,
            confirmedBy: userId,
          }
        );
      } else if (
        typeof data.status === "string" &&
        (PROJECT_TRACK_STATUSES as readonly string[]).includes(data.status)
      ) {
        if (track.status !== data.status) {
          // STRICT compare-and-set on the status the move was decided from
          // (D1): a person who moved the goal since the proposal was filed
          // wins — the approval fails as stale and nothing is written. A
          // proposal filed before the belief rode it carries none.
          if (
            typeof data.expectedStatus === "string" &&
            data.expectedStatus !== track.status
          ) {
            throw lifecycleConflictError(data.expectedStatus, track.status);
          }
          // The lifecycle is re-checked at APPROVAL time: the proposal was
          // legal when filed, but the track may have moved since (dropped,
          // say) — and a closed track is final. The verdict rides the
          // proposal and is re-checked by the same rule.
          const close = {
            verdict: typeof data.verdict === "string" ? data.verdict : null,
            verdictReason:
              typeof data.verdictReason === "string"
                ? data.verdictReason
                : null,
          };
          // …and so is the criteria rule (W2): a "met" approved after a
          // criterion was sent back no longer holds.
          assertTrackTransition(
            track,
            data.status as ProjectTrackStatus,
            close,
            await loadGoalCloseCriteria(
              track,
              data.status as ProjectTrackStatus,
              userId
            )
          );
          await applyTrackStatus(
            track,
            project,
            data.status as ProjectTrackStatus,
            userId,
            close
          );
        }
      } else {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Goal update proposal carries no stage, status, params, direction, kpi, goal content, added stage or participant change",
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
          message: "Stage-gate proposal is missing its goal",
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
          // The approver resumes it; the transition names the proposal.
          actor: { kind: "human", userId },
          proposalId: proposal.id,
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
                "Goal was not paused at approval time — it had already been " +
                "resumed, closed or dropped. The gate is answered; the goal " +
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
