/**
 * WHO IS ON A GOAL — the approval halves (work model W3, 0346).
 *
 *   track/assign_agent  an agent handed the goal to ANOTHER agent
 *                       (`gateAgentHandOff` with a track). Approval adds that
 *                       agent in the role and with the commitment the
 *                       proposal names.
 *   track/update        with `participant` — an agent's participant change
 *                       (its join, its answer, or a forced change of anyone
 *                       else). Dispatched from the `track/update` executor
 *                       (`executors/track.ts`) to
 *                       {@link applyTrackParticipantProposal}.
 *
 * Replays act as the APPROVER: `applyTrackParticipantChange` re-checks every
 * rule with the approver as the deciding person — adding or removing needs
 * the goal's owner or judge, an answer must still be the proposing agent's
 * own, and an agent principal is re-asked to THE route (paused since, no
 * longer acting for the person) before any row is written.
 */

import { TRPCError } from "@trpc/server";
import { db } from "@synap/database";
import type { ProjectTrack } from "@synap/database/schema";
import { registerProposalExecutor } from "../execution-registry.js";
import { reportApproved } from "./shared.js";
// The approved-marker helpers of the track executors (one copy, not two).
import { alreadyApproved, markApproved } from "./track.js";
import { getTrack } from "../../../services/tracks/tracks-service.js";
import {
  applyTrackParticipantChange,
  trackParticipantChangeSchema,
} from "../../../services/tracks/track-participants.js";
import { loadVisibleProject } from "../../../services/projects/load-visible-project.js";
import { assertWorkspaceWrite } from "../../../utils/workspace-write-access.js";

type ProposalRow = {
  data: unknown;
  targetId?: string | null;
  agentUserId?: string | null;
  subjectUserId?: string | null;
};

function innerData(proposal: { data: unknown }): Record<string, unknown> {
  return ((proposal.data as Record<string, unknown>)?.data ?? {}) as Record<
    string,
    unknown
  >;
}

/**
 * The `participant` change a `track/update` proposal carries, applied as the
 * approver. Called by the `track/update` executor after it loaded the track
 * and floored the approver's write.
 */
export async function applyTrackParticipantProposal(p: {
  track: ProjectTrack;
  proposal: ProposalRow;
  approverId: string;
}): Promise<void> {
  const parsed = trackParticipantChangeSchema.safeParse(
    innerData(p.proposal).participant
  );
  if (!parsed.success) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "The participant change in this proposal is not readable.",
    });
  }
  await applyTrackParticipantChange({
    track: p.track,
    change: parsed.data,
    personId: p.approverId,
    agentId: p.proposal.agentUserId ?? null,
    // The person the proposing agent acted for — the route's owner.
    forPersonId: p.proposal.subjectUserId ?? p.approverId,
  });
}

export function registerTrackParticipantExecutors(): void {
  registerProposalExecutor({
    key: "track/assign_agent",
    async execute({ proposal, userId, input, deps }) {
      if (await alreadyApproved(input.proposalId)) {
        return { success: true, alreadyApproved: true };
      }
      const data = innerData(proposal);
      const trackId = (data.id as string | undefined) ?? proposal.targetId;
      const agentId =
        typeof data.addAgentId === "string" ? data.addAgentId.trim() : "";
      if (!trackId || agentId === "") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Goal hand-off proposal ${input.proposalId} names no goal or no agent`,
        });
      }
      const track = await getTrack(trackId, { userId });
      if (!track) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Goal to hand on no longer exists",
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

      // The same door as the direct path, as the APPROVER (owner or judge),
      // re-asking THE route for the agent before the row is written.
      await applyTrackParticipantChange({
        track,
        change: {
          op: "add",
          principalId: agentId,
          role: data.role === "integrator" ? "integrator" : "delegate",
          ...(typeof data.commitment === "string" && data.commitment.trim()
            ? { commitment: data.commitment.trim() }
            : {}),
        },
        personId: userId,
        agentId: proposal.agentUserId ?? null,
        forPersonId: proposal.subjectUserId ?? userId,
      });

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
}
