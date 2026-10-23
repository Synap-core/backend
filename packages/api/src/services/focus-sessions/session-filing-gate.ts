/**
 * FILING, gated on its own — where a session belongs (its project, its space,
 * its track step) is the person's call, so an AGENT's filing is a proposal
 * (`forcePropose`) — except an agent filing its OWN FRESH session into the
 * project the person named, which the pod's own-organise class row may apply
 * directly with a receipt and Undo (FB1020 B3, `own-organise.ts`). It is decided HERE, before the update membrane,
 * as its OWN proposal, exactly like a hand-off (`agent-hand-off.ts`).
 *
 * WHY SPLIT. The filing fields used to force the WHOLE update to a proposal, so
 * a rename, a progress tick or a goal change sent in the same call waited on a
 * person too — and rode through on the filing's approval, unnamed (a stale goal
 * did exactly that on 2026-10-20). Now the filing proposal carries the filing
 * and nothing else; the rest of the patch takes the ordinary governance
 * decision of the update door.
 *
 * Who never reaches this door: a PERSON filing their own session (no
 * `agentUserId`) — never forced, written with the rest of the patch.
 *
 * ONE gate, both doors that file: `updateFocusSession` (MCP
 * `synap_update_session`: project, space, track) and Hub
 * `PATCH /focus-sessions/:id` (track). Approval lands through the
 * `focus_session/update` executor, which re-floors every target.
 */
import { checkPermissionOrPropose } from "../../utils/permission-check.js";
import type { SessionTrackFiling } from "../tracks/session-track-filing.js";
import { sessionNameField } from "./session-update-goal.js";
import { ownWorkOrganiseForSessionFiling } from "../governance/own-organise.js";

export type SessionFilingDecision =
  | {
      status: "granted";
      /**
       * The receipt an AGENT's filing was applied under (FB1020 B3: its own
       * fresh session, into a project the person named). The update door
       * stamps the filing's Undo on it.
       */
      receiptId?: string;
    }
  | { status: "denied"; reason: string }
  | {
      status: "proposed";
      proposalId: string;
      proposalType?: string;
      summary?: string;
      reviewPath?: string;
      reviewUrl?: string;
    };

/** What a patch files, already floored by its door. `undefined` = untouched. */
export interface SessionFilingPatch {
  /** `null` unfiles. */
  projectId?: string | null;
  /** Display only — names the project in the title. */
  projectName?: string;
  /** `null` makes the session personal. */
  workspaceId?: string | null;
  /** Display only — names the space in the title. */
  workspaceName?: string | null;
  /** Resolved by `resolveSessionTrackFiling`. */
  trackFiling?: SessionTrackFiling;
}

export function hasSessionFiling(p: SessionFilingPatch): boolean {
  return (
    p.projectId !== undefined ||
    p.workspaceId !== undefined ||
    p.trackFiling !== undefined
  );
}

/**
 * The filing half of a `focus_session/update` payload: the fields the executor
 * applies (it RE-floors and RE-resolves each) plus their display-only names.
 * `null` (unfile, make personal) must survive, hence `!== undefined`.
 */
export function sessionFilingFields(
  p: SessionFilingPatch
): Record<string, unknown> {
  return {
    ...(p.projectId !== undefined ? { projectId: p.projectId } : {}),
    ...(p.projectId !== undefined && p.projectName
      ? { projectName: p.projectName }
      : {}),
    ...(p.workspaceId !== undefined
      ? {
          workspaceId: p.workspaceId,
          ...(p.workspaceName ? { workspaceName: p.workspaceName } : {}),
        }
      : {}),
    ...(p.trackFiling
      ? {
          trackId: p.trackFiling.set.trackId,
          trackStage: p.trackFiling.set.trackStage,
          ...(p.trackFiling.trackName
            ? { trackName: p.trackFiling.trackName }
            : {}),
          ...(p.trackFiling.stageName
            ? { stageName: p.trackFiling.stageName }
            : {}),
          ...(p.trackFiling.projectName
            ? { trackProjectName: p.trackFiling.projectName }
            : {}),
        }
      : {}),
  };
}

/** Ask governance for an AGENT's filing, as its own forced proposal. */
export async function gateSessionFiling(p: {
  userId: string;
  agentUserId: string;
  workspaceId: string | null | undefined;
  session: { id: string; title?: string | null; goal: string };
  filing: SessionFilingPatch;
  reasoning?: string;
}): Promise<SessionFilingDecision> {
  const perm = await checkPermissionOrPropose({
    userId: p.userId,
    agentUserId: p.agentUserId,
    workspaceId: p.workspaceId ?? undefined,
    subjectType: "focus_session",
    action: "update",
    source: "intelligence",
    // Where a session belongs is the person's call — UNLESS the agent files
    // its OWN FRESH session into the project the person named (FB1020 B3):
    // then only the pod's own-organise class row may apply it directly.
    ...((await ownWorkOrganiseForSessionFiling({
      agentUserId: p.agentUserId,
      sessionId: p.session.id,
      filing: p.filing,
    }))
      ? { forcePropose: false, ownWorkOrganise: true }
      : { forcePropose: true }),
    ...(p.reasoning ? { reasoning: p.reasoning } : {}),
    data: {
      id: p.session.id,
      ...sessionNameField(p.session),
      ...sessionFilingFields(p.filing),
    },
  });
  if ("denied" in perm && perm.denied) {
    return { status: "denied", reason: perm.reason };
  }
  if ("proposalId" in perm) {
    return {
      status: "proposed",
      proposalId: perm.proposalId,
      proposalType: perm.proposalType,
      summary: perm.summary,
      reviewPath: perm.reviewPath,
      reviewUrl: perm.reviewUrl,
    };
  }
  return {
    status: "granted",
    ...("granted" in perm && perm.autoApprovedProposalId
      ? { receiptId: perm.autoApprovedProposalId }
      : {}),
  };
}
