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
  and,
  eq,
  isNull,
  or,
  entities,
  entityFacets,
  profiles,
  relations,
  applyStatusMove,
  canonicalLifecycleOptionKey,
  classifyStatusMove,
  resolveStatusMoveTarget,
  type ApplyStatusMoveResult,
  type ResolveTargetResult,
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

/**
 * Resolve the ROLE an automation addresses: by its facet id, or by entity +
 * role slug. `viaRelation` reaches the role on a related thing when the entity
 * does not wear it itself: the one entity this entity points to with that
 * relation type (e.g. a person `works_at` their company) and that wears the
 * role. None, or several, is ROLE_NOT_ATTACHED: never a guess.
 */
export async function resolveAutomationRoleTarget(input: {
  facetId?: string;
  entityId?: string;
  role?: string;
  viaRelation?: string;
  workspaceId: string;
}): Promise<ResolveTargetResult> {
  if (input.facetId) {
    const [facet] = await db
      .select({ entityId: entityFacets.entityId })
      .from(entityFacets)
      .where(
        and(eq(entityFacets.id, input.facetId), isNull(entityFacets.deletedAt))
      )
      .limit(1);
    if (!facet)
      return {
        ok: false,
        code: "NOT_FOUND",
        reason: `Role not found: ${input.facetId}`,
      };
    return resolveStatusMoveTarget(db, {
      entityId: facet.entityId,
      facetId: input.facetId,
      workspaceId: input.workspaceId,
    });
  }
  if (!input.entityId || !input.role) {
    return {
      ok: false,
      code: "NOT_FOUND",
      reason: "Name the role by facetId, or by entityId and facetSlug.",
    };
  }
  let entityId = input.entityId;
  if (input.viaRelation) {
    const [own] = await db
      .select({ id: entityFacets.id })
      .from(entityFacets)
      .innerJoin(profiles, eq(profiles.id, entityFacets.profileId))
      .where(
        and(
          eq(entityFacets.entityId, input.entityId),
          eq(profiles.slug, input.role),
          isNull(entityFacets.deletedAt)
        )
      )
      .limit(1);
    if (!own) {
      const wearers = await db
        .selectDistinct({ id: relations.targetEntityId })
        .from(relations)
        .innerJoin(entities, eq(entities.id, relations.targetEntityId))
        .innerJoin(entityFacets, eq(entityFacets.entityId, entities.id))
        .innerJoin(profiles, eq(profiles.id, entityFacets.profileId))
        .where(
          and(
            eq(relations.sourceEntityId, input.entityId),
            eq(relations.type, input.viaRelation),
            or(
              isNull(relations.workspaceId),
              eq(relations.workspaceId, input.workspaceId)
            ),
            isNull(entities.deletedAt),
            eq(profiles.slug, input.role),
            isNull(entityFacets.deletedAt)
          )
        );
      if (wearers.length !== 1 || !wearers[0].id) {
        return {
          ok: false,
          code: "ROLE_NOT_ATTACHED",
          reason:
            wearers.length === 0
              ? `"${input.role}" is attached neither to this entity nor to what it ${input.viaRelation}`
              : `"${input.role}" is attached to ${wearers.length} things this entity ${input.viaRelation}; name the facet`,
        };
      }
      entityId = wearers[0].id;
    }
  }
  return resolveStatusMoveTarget(db, {
    entityId,
    role: input.role,
    workspaceId: input.workspaceId,
  });
}

export async function moveStatusFromAutomation(input: {
  ownerId: string;
  workspaceId: string;
  entityId: string;
  /** A ROLE's status: the facet it names (absent = the kind's status). */
  facetId?: string | null;
  to: string;
  /**
   * The status the rule says the thing must be at (its condition). Another
   * value answers `conflict` before anything is governed or written; absent =
   * the value read now (still compare-and-set).
   */
  expectedFrom?: string;
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
    facetId: input.facetId ?? null,
    workspaceId: input.workspaceId,
  });
  if (!resolved.ok) {
    return { status: "refused", code: resolved.code, reason: resolved.reason };
  }
  const { target } = resolved;
  // The rule's condition, read like the api door reads an agent's belief: a
  // false one never reaches governance (no proposal that could only fail).
  if (input.expectedFrom !== undefined) {
    const expected = canonicalLifecycleOptionKey(
      target.lifecycle,
      input.expectedFrom
    );
    if (expected !== target.current) {
      return {
        status: "conflict",
        expectedFrom: expected,
        actual: target.current,
      };
    }
  }
  // The same input normaliser as `moveStatus`: a case/separator variant of a
  // declared option moves to that option.
  const to = canonicalLifecycleOptionKey(target.lifecycle, input.to);
  const lifecycleMove = classifyStatusMove(target.lifecycle, to);
  if (!lifecycleMove) {
    return {
      status: "refused",
      code: "UNKNOWN_OPTION",
      reason: `"${input.to}" is not a status of ${target.role ?? target.entityType ?? "this kind"}`,
    };
  }
  if (target.current === to) {
    return { status: "unchanged", current: to };
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
      role: target.role,
      facetId: target.facetId,
      property: target.lifecycle.propertySlug,
      expectedFrom: target.current,
      to,
      reason: input.reason ?? null,
    },
    // The rule's own reason is its WHY; the default sentence is the pod's
    // words about the move, kept out of `reasoning`.
    ...(input.reason
      ? { reasoning: input.reason }
      : {
          policyReason: automationMovesSentence(
            target.lifecycle.propertySlug,
            to
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
    to,
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
