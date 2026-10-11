/**
 * THE ONE EMITTER of a lifecycle transition (work model L2).
 *
 * Every status move — the `moveStatus` door, the jobs automation path, an
 * approved transition proposal — ends here, so the `entity.transition.completed`
 * event exists in exactly ONE shape:
 *
 *   1. the immutable log row (`events`), payload = the transition;
 *   2. the side-effect fan-out (automation matcher, process-sync, webhooks),
 *      `subjectType: "entity", action: "transition"`, the transition FLAT so a
 *      rule filters on `to` / `from` / `category` / `role` / `profileSlug`.
 *
 * BACK-COMPAT (founder decision 2026-10-11): for a KIND's lifecycle the
 * fan-out is ALSO emitted as `entity.update.completed` carrying
 * `changed.<slug>`, `previous.<slug>` and `<slug>` — the exact keys rules
 * compiled from the old `enters_status` sentence filter on. The log does not
 * get a second row. Roles never had that shape and get none.
 *
 * `enters_status` activators now compile onto the transition (E1, 2026-10-11;
 * untouched rules recompile through the activator convergence at boot). The
 * flag STAYS ON because these still read the update for a status move:
 *   1. process-sync follows a KIND's move on the update path
 *      (`followTransition` defers to it while this flag is on — flip both
 *      together, or a process advances twice / never);
 *   2. realtime: `domain-event-bridge.ts` pushes `entity:updated` from the
 *      update; nothing bridges the transition, so clients would not refresh;
 *   3. rules NOT born from an activator — hand-authored "updated" rules with
 *      `changed.<lifecycle slug>`, and owner-edited activator rules (the
 *      convergence keeps them) — plus webhook subscriptions to the update.
 * Turning it off needs 1 + 2 moved to the transition and a conversion for 3.
 */
import { randomUUID } from "node:crypto";
import { EventRepository, sql } from "@synap/database";
import { createLogger } from "@synap-core/core";
import { emitSideEffects, type SideEffectPayload } from "./side-effects.js";

const logger = createLogger({ module: "lifecycle-transition" });

/** Mirrors `StatusTransition` (`@synap/database` apply-status-move.ts). */
export interface LifecycleTransitionEvent {
  transitionId: string;
  entityId: string;
  profileSlug: string | null;
  role: string | null;
  facetId: string | null;
  property: string;
  from: string | null;
  to: string;
  fromCategory: string | null;
  category: string;
  actorKind: "human" | "agent" | "system";
  userId: string;
  agentUserId: string | null;
  sessionId: string | null;
  reason: string | null;
  staleExpected: boolean;
  proposalId: string | null;
  workspaceId: string | null;
}

export const LIFECYCLE_TRANSITION_EVENT_TYPE = "entity.transition.completed";

/** Feature flag for the dual emit — one place to delete it. */
export const DUAL_EMIT_ENTITY_UPDATE_FOR_TRANSITIONS = true;

export async function emitLifecycleTransition(
  t: LifecycleTransitionEvent,
  opts: {
    automationContext?: SideEffectPayload["automationContext"];
    correlationId?: string;
  } = {}
): Promise<void> {
  // `lifecycleProfile` = the kind or role WHOSE lifecycle moved — the one key
  // an `enters_status` / "transitioned" rule filters its subject on
  // (`entityKindFilterKey`, @synap-core/types/automations). `profileSlug`
  // alone cannot say it: a role's move carries the entity's KIND there.
  const data: Record<string, unknown> = {
    ...t,
    lifecycleProfile: t.role ?? t.profileSlug,
  };
  // The fan-out's `userId` is the event's ACTOR (the trigger hop reads it as
  // the causal-chain producer — `producerAgentUserId`): the agent for an agent
  // move, the person otherwise. The payload keeps both.
  const actorId = t.agentUserId ?? t.userId;
  let eventId: string | null = null;
  try {
    const record = await new EventRepository(sql).append({
      id: randomUUID(),
      version: "v1",
      type: LIFECYCLE_TRANSITION_EVENT_TYPE,
      subjectId: t.entityId,
      subjectType: "entity",
      data,
      metadata: {},
      userId: t.userId,
      workspaceId: t.workspaceId ?? undefined,
      isAgent: t.agentUserId ? true : undefined,
      agentUserId: t.agentUserId ?? undefined,
      proposalId: t.proposalId ?? undefined,
      sessionId: t.sessionId ?? undefined,
      source: t.actorKind === "system" ? "system" : "api",
      timestamp: new Date(),
      correlationId: opts.correlationId,
    } as Parameters<EventRepository["append"]>[0]);
    eventId = record?.id ?? null;
  } catch (err) {
    // Best-effort like every other domain log append: the status already
    // moved; the fan-out below still runs (it names no event row then).
    logger.warn({ err, entityId: t.entityId }, "transition log append failed");
  }

  await emitSideEffects({
    subjectType: "entity",
    action: "transition",
    subjectId: t.entityId,
    userId: actorId,
    workspaceId: t.workspaceId,
    sessionId: t.sessionId,
    eventId,
    automationContext: opts.automationContext,
    data,
  } as SideEffectPayload);

  if (DUAL_EMIT_ENTITY_UPDATE_FOR_TRANSITIONS && t.role === null) {
    await emitSideEffects({
      subjectType: "entity",
      action: "update",
      subjectId: t.entityId,
      userId: actorId,
      workspaceId: t.workspaceId,
      sessionId: t.sessionId,
      automationContext: opts.automationContext,
      data: {
        profileSlug: t.profileSlug ?? undefined,
        changedKeys: [t.property],
        [`changed.${t.property}`]: true,
        [`previous.${t.property}`]: t.from,
        [t.property]: t.to,
      },
    } as SideEffectPayload);
  }
}
