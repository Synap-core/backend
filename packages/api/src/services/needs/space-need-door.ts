/**
 * THE ONE DOOR that fills (or clears) a space's need (founder decision D3,
 * 16 Nov 2026), shared by tRPC `needs.bind` and Hub `PUT
 * /workspaces/:workspaceId/needs/:need`, and the one read both serve.
 *
 * GOVERNED: `checkPermissionOrPropose` on the workspace, action `bind_need`
 * (`workspace/bind_need`, a gate door classed `disruptive`): a member whose
 * role writes applies at once; an agent caller (agentUserId set) files a
 * proposal, applied on approval by the `workspace/bind_need` executor
 * (`routers/proposals/executors/workspace.ts`) through the same
 * `applySpaceNeedBinding`. Which provider every run of the space uses is the
 * person's choice; an agent proposes it.
 */
import { z } from "zod";
import { NEEDS, canonicalNeedSlug } from "@synap-core/types/needs";
import { checkPermissionOrPropose } from "../../utils/permission-check.js";
import {
  applySpaceNeedBinding,
  providerServesNeedIntent,
  type SpaceNeedBindResult,
} from "./space-needs.js";
import {
  workspaceNeedCoverage,
  type SpaceNeedCoverageResult,
} from "./space-need-coverage.js";

/** The write's input, as both doors accept it. */
export const BindSpaceNeedInputSchema = z.object({
  /** The provider capability (its container id), or null to clear the need. */
  providerCapabilityId: z.string().uuid().nullable(),
});

export type SpaceNeedDoorResult =
  | { status: "proposed"; proposalId: string; summary: string; reviewUrl: string; reviewPath: string }
  | { status: "denied"; reason: string }
  | { status: "applied"; result: SpaceNeedBindResult };

/** Fill or clear one need of a space, through the gate. Throws `SpaceNeedBindError` on a refused apply. */
export async function bindSpaceNeedThroughGate(input: {
  userId: string;
  agentUserId?: string | null;
  workspaceId: string;
  need: string;
  providerCapabilityId: string | null;
  sessionId?: string | null;
}): Promise<SpaceNeedDoorResult> {
  const need = canonicalNeedSlug(input.need) ?? input.need;
  const perm = await checkPermissionOrPropose({
    userId: input.userId,
    agentUserId: input.agentUserId ?? undefined,
    workspaceId: input.workspaceId,
    subjectType: "workspace",
    action: "bind_need",
    source: input.agentUserId ? "intelligence" : "user",
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    data: { need, providerCapabilityId: input.providerCapabilityId },
  });
  if ("denied" in perm && perm.denied) {
    return { status: "denied", reason: perm.reason };
  }
  if ("proposalId" in perm) {
    return {
      status: "proposed",
      proposalId: perm.proposalId,
      summary: perm.summary,
      reviewUrl: perm.reviewUrl,
      reviewPath: perm.reviewPath,
    };
  }
  const result = await applySpaceNeedBinding({
    workspaceId: input.workspaceId,
    need,
    providerCapabilityId: input.providerCapabilityId,
    userId: input.userId,
    servesIntent: (providerId, def) =>
      providerServesNeedIntent(
        { workspaceId: input.workspaceId, userId: input.userId },
        providerId,
        def
      ),
  });
  return { status: "applied", result };
}

/** The read both doors serve: the vocabulary, and the space's needs with their state. */
export async function readSpaceNeeds(workspaceId: string): Promise<{
  vocabulary: typeof NEEDS;
  coverage: SpaceNeedCoverageResult;
}> {
  return { vocabulary: NEEDS, coverage: await workspaceNeedCoverage(workspaceId) };
}
