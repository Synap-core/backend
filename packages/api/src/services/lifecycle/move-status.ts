/**
 * `moveStatus` — THE door for moving a thing's lifecycle status (work model
 * L2, founder W12–W14). Every surface uses it: an agent, a UI drag, the stage
 * door, sync, the entity update door when it carries the lifecycle key.
 *
 *   resolve the target (kind → entity row, role → facet row) + its lifecycle
 *   → classify the target option (category, humanOnly)
 *   → GOVERN: `checkPermissionOrPropose(entity.transition, lifecycleMove)` —
 *     RBAC for a person; for an agent the engine's floor: a human-only option
 *     always proposes, into done/lost proposes by default, other moves execute
 *   → WRITE: `applyStatusMove` (@synap/database) — one compare-and-set
 *     statement writing the columns (the truth) and `properties[slug]` (the
 *     read projection). Agents are strict CAS; a person's move wins.
 *   → EMIT: `emitLifecycleTransition` (@synap/events) — the ONE event.
 *
 * A proposed agent move is SUCCESS (the person reviews it). Its approval
 * replays the move with the agent's original `expectedFrom`
 * (`executors/entity-transition.ts`), so a person moving the thing meanwhile
 * makes that approval fail as stale instead of overwriting them.
 */
import {
  db,
  applyStatusMove,
  classifyStatusMove,
  resolveStatusMoveTarget,
  type ApplyStatusMoveResult,
  type StatusMoveActor,
} from "@synap/database";
import { emitLifecycleTransition } from "@synap/events";
import { checkPermissionOrPropose } from "../../utils/permission-check.js";

export interface MoveStatusInput {
  entityId: string;
  /** Role-profile slug: move the ROLE's status (its facet), not the kind's. */
  role?: string | null;
  /** Name the facet when a role is attached more than once. */
  facetId?: string | null;
  /** What the mover saw. `undefined` = not expressed (the current value). */
  expectedFrom?: string | null;
  to: string;
  actor: StatusMoveActor;
  sessionId?: string | null;
  reason?: string | null;
  /** The caller's workspace lens (governance + trigger routing for pod-wide kinds). */
  workspaceId?: string | null;
  /** OR-ed into governance (never downgrades). */
  forcePropose?: boolean;
  /** An approved proposal replaying this move — governance already decided. */
  approvedProposalId?: string | null;
}

export type MoveStatusResult =
  | ApplyStatusMoveResult
  | {
      status: "proposed";
      proposalId: string;
      reviewUrl?: string;
      proposalType: string;
    }
  | { status: "denied"; reason: string }
  | {
      status: "refused";
      code:
        "NOT_FOUND" | "NO_LIFECYCLE" | "ROLE_NOT_ATTACHED" | "UNKNOWN_OPTION";
      reason: string;
    };

export async function moveStatus(
  input: MoveStatusInput
): Promise<MoveStatusResult> {
  const resolved = await resolveStatusMoveTarget(db, {
    entityId: input.entityId,
    role: input.role,
    facetId: input.facetId,
    workspaceId: input.workspaceId,
  });
  if (!resolved.ok) {
    return { status: "refused", code: resolved.code, reason: resolved.reason };
  }
  const { target } = resolved;
  const lifecycleMove = classifyStatusMove(target.lifecycle, input.to);
  if (!lifecycleMove) {
    return {
      status: "refused",
      code: "UNKNOWN_OPTION",
      reason: `"${input.to}" is not a status of ${target.role ?? target.entityType ?? "this kind"} (${target.lifecycle.options.map((o) => o.key).join(", ")})`,
    };
  }
  const agent = input.actor.kind === "agent";
  // An agent acting on a belief that is already false never files a proposal
  // that could only fail at approval.
  if (
    agent &&
    input.expectedFrom !== undefined &&
    (input.expectedFrom ?? null) !== target.current
  ) {
    return {
      status: "conflict",
      expectedFrom: input.expectedFrom ?? null,
      actual: target.current,
    };
  }
  if (target.current === input.to) {
    return { status: "unchanged", current: input.to };
  }

  const governanceWorkspaceId = target.workspaceId ?? input.workspaceId ?? null;
  let receiptId: string | undefined;
  if (input.actor.kind !== "system" && !input.approvedProposalId) {
    const perm = await checkPermissionOrPropose({
      userId: input.actor.userId,
      agentUserId: input.actor.agentUserId ?? undefined,
      workspaceId: governanceWorkspaceId,
      subjectType: "entity",
      action: "transition",
      source: agent ? "agent" : "user",
      lifecycleMove,
      forcePropose: input.forcePropose,
      reasoning:
        input.reason ??
        `Move ${target.lifecycle.propertySlug} from "${target.current ?? "none"}" to "${input.to}".`,
      sessionId: input.sessionId ?? undefined,
      data: {
        id: input.entityId,
        entityId: input.entityId,
        role: target.role,
        facetId: target.facetId,
        property: target.lifecycle.propertySlug,
        // The belief the approval replays against (strict CAS).
        expectedFrom: target.current,
        to: input.to,
        reason: input.reason ?? null,
      },
    });
    if ("denied" in perm && perm.denied) {
      return { status: "denied", reason: perm.reason };
    }
    if ("proposalId" in perm) {
      return {
        status: "proposed",
        proposalId: perm.proposalId,
        reviewUrl: perm.reviewUrl,
        proposalType: perm.proposalType,
      };
    }
    receiptId = "granted" in perm ? perm.autoApprovedProposalId : undefined;
  }

  const result = await applyStatusMove(db, {
    target,
    expectedFrom: input.expectedFrom,
    to: input.to,
    actor: input.actor,
    sessionId: input.sessionId,
    reason: input.reason,
    proposalId: input.approvedProposalId ?? receiptId ?? null,
    lensWorkspaceId: input.workspaceId,
  });
  if (result.status === "moved") {
    await emitLifecycleTransition(result.transition);
  }
  return result;
}
