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
 * BACK-COMPAT (founder decision 2026-10-11, remove after the activator
 * recompile conversion lands): for a KIND's lifecycle the fan-out is ALSO
 * emitted as `entity.update.completed` carrying `changed.<slug>`,
 * `previous.<slug>` and `<slug>` — the exact keys rules compiled from the old
 * `enters_status` sentence filter on. The log does not get a second row.
 * Roles never had that shape (enters_status was blind to facets) and get none.
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
  const data: Record<string, unknown> = { ...t };
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
