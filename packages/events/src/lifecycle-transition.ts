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
 *
 * DELIVERY (review D8): the move's transaction already OWES this event — an
 * outbox row written with the compare-and-set (`transition-outbox.ts`,
 * @synap/database). `dispatchLifecycleTransition` claims that row, appends the
 * log row (id = transitionId, so a retry can never write a second), runs the
 * fan-out skipping what an earlier attempt delivered, and settles the row. A
 * failure leaves it pending; `dispatchDueLifecycleTransitions` (the jobs
 * sweeper) retries it. Residual, stated: a crash AFTER a reactor's send and
 * BEFORE the settle re-sends that reactor once; the automation matcher's
 * fingerprint is the transitionId (2aec15c3), so a rule still fires once.
 */
import {
  EventRepository,
  claimTransitionOutbox,
  db,
  listDueTransitions,
  settleTransitionOutbox,
  sql,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import { fanOutSideEffects, type SideEffectPayload } from "./side-effects.js";

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

/** The emit options a mover passes; stored on the outbox row and replayed. */
export interface TransitionEmitContext {
  automationContext?: SideEffectPayload["automationContext"];
  correlationId?: string;
}

/** What earlier attempts already did (the outbox row's progress). */
export interface TransitionEmitProgress {
  eventId: string | null;
  /** Fan-out keys delivered: `transition:<reactor>` / `update:<reactor>`. */
  delivered: string[];
}

export interface TransitionEmitResult extends TransitionEmitProgress {
  complete: boolean;
  error?: string;
}

const UNIQUE_VIOLATION = "23505";

/**
 * One delivery attempt: the log row, then the fan-out, skipping what
 * `progress` says is done. Never throws; reports what is still owed.
 */
export async function emitLifecycleTransition(
  t: LifecycleTransitionEvent,
  opts: TransitionEmitContext = {},
  progress: TransitionEmitProgress = { eventId: null, delivered: [] }
): Promise<TransitionEmitResult> {
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
  let eventId = progress.eventId;
  if (!eventId) {
    try {
      const record = await new EventRepository(sql).append({
        // The transition's id IS the log row's id: at most one row, ever.
        id: t.transitionId,
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
      eventId = record?.id ?? t.transitionId;
    } catch (err) {
      if (pgCode(err) === UNIQUE_VIOLATION) {
        // An earlier attempt wrote it and died before saying so.
        eventId = t.transitionId;
      } else {
        // No fan-out before the log row: history, triggers and goals must
        // never disagree about whether the move happened. Retried.
        logger.warn(
          { err, entityId: t.entityId },
          "transition log append failed"
        );
        return {
          eventId: null,
          delivered: progress.delivered,
          complete: false,
          error: `log append: ${errorText(err)}`,
        };
      }
    }
  }

  const delivered = [...progress.delivered];
  const failures: string[] = [];
  const fanOut = async (prefix: string, payload: SideEffectPayload) => {
    const skip = new Set(
      delivered
        .filter((k) => k.startsWith(`${prefix}:`))
        .map((k) => k.slice(prefix.length + 1))
    );
    const r = await fanOutSideEffects(payload, skip);
    delivered.push(...r.delivered.map((id) => `${prefix}:${id}`));
    if (r.queueDown) failures.push(`${prefix}: queue unavailable`);
    failures.push(...r.failed.map((id) => `${prefix}:${id}`));
  };

  await fanOut("transition", {
    subjectType: "entity",
    action: "transition",
    subjectId: t.entityId,
    userId: actorId,
    workspaceId: t.workspaceId,
    sessionId: t.sessionId,
    eventId,
    automationContext: opts.automationContext,
    // `data` is an untyped record, so the catalog-declared filter key is
    // named HERE, at the emit, where the tripwire
    // `entity-emits-carry-declared-filter-keys` can see it — the entity's
    // KIND (a role's move carries the role in `role` / `lifecycleProfile`).
    data: { ...data, profileSlug: t.profileSlug },
  } as SideEffectPayload);

  if (DUAL_EMIT_ENTITY_UPDATE_FOR_TRANSITIONS && t.role === null) {
    await fanOut("update", {
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

  return failures.length
    ? { eventId, delivered, complete: false, error: failures.join(", ") }
    : { eventId, delivered, complete: true };
}

/**
 * Deliver the event a move owes: claim its outbox row, emit, settle. Call
 * right after a `moved` result; never throws (what fails stays owed and the
 * sweeper retries it). `false` = not delivered by this call.
 */
export async function dispatchLifecycleTransition(
  transitionId: string
): Promise<boolean> {
  try {
    const claimed = await claimTransitionOutbox(db, transitionId);
    if (!claimed) return false;
    const result = await emitLifecycleTransition(
      claimed.transition as LifecycleTransitionEvent,
      claimed.emitContext as TransitionEmitContext,
      { eventId: claimed.eventId, delivered: claimed.delivered }
    );
    await settleTransitionOutbox(db, transitionId, result);
    if (!result.complete) {
      logger.warn(
        { transitionId, attempts: claimed.attempts, error: result.error },
        "transition delivery incomplete — left owed for the sweeper"
      );
    }
    return result.complete;
  } catch (err) {
    logger.warn({ err, transitionId }, "transition dispatch failed");
    return false;
  }
}

/** The sweeper: deliver every owed transition whose backoff has lapsed. */
export async function dispatchDueLifecycleTransitions(
  limit = 100
): Promise<{ due: number; delivered: number }> {
  const due = await listDueTransitions(db, limit);
  let delivered = 0;
  for (const id of due) {
    if (await dispatchLifecycleTransition(id)) delivered++;
  }
  return { due: due.length, delivered };
}

function pgCode(err: unknown): string | undefined {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = e?.code ?? e?.cause?.code;
  return typeof code === "string" ? code : undefined;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
