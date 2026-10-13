/**
 * The jobs half of the `moveStatus` door (work model L2): an automation step
 * that moves a thing's lifecycle status.
 *
 * Same three steps as the api door (`services/lifecycle/move-status.ts`), with
 * this package's governance: resolve + classify → `checkAutomationWriteOrPropose`
 * (`entity.transition`, `lifecycleMove`) → `applyStatusMove` (one
 * compare-and-set: columns = truth, `properties[slug]` = read projection, and
 * the owed event in the same transaction) → `dispatchLifecycleTransition`
 * (the ONE event, carrying the automation chain so the depth/cycle guards see
 * it, retried by the sweeper if delivery fails). A proposed move is filed as
 * `entity/transition`; its approval replays the move (api executor).
 *
 * The automation is the actor (`system`, strict compare-and-set), attributed to
 * its owner.
 */
import {
  db,
  applyStatusMove,
  classifyStatusMove,
  resolveStatusMoveTarget,
  type ApplyStatusMoveResult,
} from "@synap/database";
import {
  dispatchLifecycleTransition,
  type SideEffectPayload,
  type TransitionEmitContext,
} from "@synap/events";
import { checkAutomationWriteOrPropose } from "./automation-governance.js";
import { automationMovesSentence } from "@synap-core/types/proposals";

export type AutomationStatusMoveResult =
  | ApplyStatusMoveResult
  | { status: "proposed"; proposalId: string }
  | { status: "denied"; reason: string }
  | { status: "refused"; code: string; reason: string };

/** The lifecycle property slug of an entity's kind, or null. */
export async function lifecycleSlugOf(
  entityId: string,
  workspaceId: string | null
): Promise<string | null> {
  const r = await resolveStatusMoveTarget(db, { entityId, workspaceId });
  return r.ok ? r.target.lifecycle.propertySlug : null;
}

export async function moveStatusFromAutomation(input: {
  ownerId: string;
  workspaceId: string;
  entityId: string;
  to: string;
  reason?: string;
  automationContext?: SideEffectPayload["automationContext"] & {
    focusSessionId?: string | null;
  };
  stepRunId?: string;
  nodeId?: string;
  producerAgentUserId?: string | null;
}): Promise<AutomationStatusMoveResult> {
  const resolved = await resolveStatusMoveTarget(db, {
    entityId: input.entityId,
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
      reason: `"${input.to}" is not a status of ${target.entityType ?? "this kind"}`,
    };
  }
  if (target.current === input.to) {
    return { status: "unchanged", current: input.to };
  }
  const ctx = input.automationContext;
  const gate = await checkAutomationWriteOrPropose({
    ownerId: input.ownerId,
    workspaceId: input.workspaceId,
    subjectType: "entity",
    action: "transition",
    lifecycleMove,
    data: {
      id: input.entityId,
      entityId: input.entityId,
      role: null,
      facetId: null,
      property: target.lifecycle.propertySlug,
      expectedFrom: target.current,
      to: input.to,
      reason: input.reason ?? null,
    },
    // The rule's own reason is its WHY; the default sentence is the pod's
    // words about the move, kept out of `reasoning`.
    ...(input.reason
      ? { reasoning: input.reason }
      : {
          policyReason: automationMovesSentence(
            target.lifecycle.propertySlug,
            input.to
          ),
        }),
    subjectProfileSlug: target.entityType ?? undefined,
    automationRunId: ctx?.automationRunId,
    correlationId: ctx?.rootRunId,
    sessionId: ctx?.focusSessionId ?? undefined,
    stepRunId: input.stepRunId,
    nodeId: input.nodeId,
    producerAgentUserId: input.producerAgentUserId ?? undefined,
  });
  if ("denied" in gate) return { status: "denied", reason: gate.reason };
  if ("proposed" in gate) {
    return { status: "proposed", proposalId: gate.proposalId };
  }
  const result = await applyStatusMove(db, {
    target,
    expectedFrom: target.current,
    to: input.to,
    actor: { kind: "system", userId: input.ownerId },
    sessionId: ctx?.focusSessionId ?? null,
    reason: input.reason ?? null,
    lensWorkspaceId: input.workspaceId,
    // Replayed by the dispatcher, so a retried delivery keeps the chain.
    emitContext: (ctx
      ? {
          automationContext: {
            automationRunId: ctx.automationRunId,
            automationId: ctx.automationId,
            chainDepth: ctx.chainDepth,
            rootRunId: ctx.rootRunId,
            chainAutomationIds: ctx.chainAutomationIds,
          },
        }
      : {}) satisfies TransitionEmitContext,
  });
  if (result.status === "moved") {
    await dispatchLifecycleTransition(result.transition.transitionId);
  }
  return result;
}

/**
 * An ALREADY-APPROVED write that carries a status (the legacy `.validated`
 * materializer): governance happened at proposal time, so this only moves —
 * same compare-and-set write, same ONE event. A role's status names its facet.
 * Returns `null` when the target has no lifecycle (the caller keeps the value
 * as a plain property).
 */
export async function applyApprovedStatusMove(input: {
  entityId: string;
  facetId?: string | null;
  to: string;
  userId: string;
  workspaceId: string | null;
  proposalId?: string | null;
}): Promise<ApplyStatusMoveResult | null> {
  const resolved = await resolveStatusMoveTarget(db, {
    entityId: input.entityId,
    facetId: input.facetId,
    workspaceId: input.workspaceId,
  });
  if (!resolved.ok) return null;
  const result = await applyStatusMove(db, {
    target: resolved.target,
    to: input.to,
    actor: { kind: "system", userId: input.userId },
    proposalId: input.proposalId ?? null,
    lensWorkspaceId: input.workspaceId,
  });
  if (result.status === "moved") {
    await dispatchLifecycleTransition(result.transition.transitionId);
  }
  return result;
}
