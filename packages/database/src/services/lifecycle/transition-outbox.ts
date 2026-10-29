/**
 * The transition OUTBOX's state machine (0324, review D8). Storage only — the
 * dispatcher that appends the log row and runs the fan-out is
 * `dispatchLifecycleTransition` (@synap/events), which this package cannot
 * reach.
 *
 *   insert (inside the CAS tx) → claim (a lease) → settle:
 *     complete ⇒ `emitted_at`, never claimed again;
 *     incomplete ⇒ progress kept (`event_id`, `delivered`), lease turned into
 *     a backoff, the sweeper's `listDueTransitions` picks it up when it lapses.
 *
 * Exactly once per transitionId: the claim is a conditional UPDATE, so two
 * dispatchers never hold one row; the log row's id IS the transitionId; each
 * delivered fan-out key is recorded and skipped on a retry.
 */
import { and, asc, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "../../schema/index.js";
import {
  lifecycleTransitionOutbox,
  type LifecycleTransitionOutboxRow,
} from "../../schema/lifecycle-transition-outbox.js";
import type { AnyTransitionPayload } from "@synap-core/types/lifecycle";

type Db = PostgresJsDatabase<typeof schema>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** How long one dispatcher holds a row before another may take it. */
export const TRANSITION_OUTBOX_LEASE_SECONDS = 120;
/** Retry backoff ceiling (2^attempts seconds, capped). */
export const TRANSITION_OUTBOX_MAX_BACKOFF_SECONDS = 3600;
/** The sweeper leaves fresh rows to the inline dispatch that follows the move. */
export const TRANSITION_OUTBOX_SWEEP_GRACE_SECONDS = 30;

export interface ClaimedTransition {
  transition: AnyTransitionPayload;
  emitContext: Record<string, unknown>;
  eventId: string | null;
  delivered: string[];
  attempts: number;
}

/**
 * Owe the transitions' events — call inside the CAS transaction. Any subject
 * (entity, goal, session); a bulk move owes one row per moved thing.
 */
export async function insertTransitionOutbox(
  tx: Db | Tx,
  transitions: AnyTransitionPayload | readonly AnyTransitionPayload[],
  emitContext: Record<string, unknown> = {}
): Promise<void> {
  const list = ([] as AnyTransitionPayload[]).concat(transitions);
  if (list.length === 0) return;
  await tx.insert(lifecycleTransitionOutbox).values(
    list.map((transition) => ({
      transitionId: transition.transitionId,
      transition,
      emitContext,
    }))
  );
}

/** Take the row for one dispatch, or `null` (done, or held by another). */
export async function claimTransitionOutbox(
  db: Db,
  transitionId: string
): Promise<ClaimedTransition | null> {
  const [row] = await db
    .update(lifecycleTransitionOutbox)
    .set({
      attempts: sql`${lifecycleTransitionOutbox.attempts} + 1`,
      claimedUntil: sql`now() + make_interval(secs => ${TRANSITION_OUTBOX_LEASE_SECONDS})`,
    })
    .where(
      and(
        eq(lifecycleTransitionOutbox.transitionId, transitionId),
        isNull(lifecycleTransitionOutbox.emittedAt),
        or(
          isNull(lifecycleTransitionOutbox.claimedUntil),
          lt(lifecycleTransitionOutbox.claimedUntil, sql`now()`)
        )
      )
    )
    .returning();
  return row ? toClaimed(row) : null;
}

function toClaimed(row: LifecycleTransitionOutboxRow): ClaimedTransition {
  return {
    transition: withSubject(row.transition as AnyTransitionPayload),
    emitContext: (row.emitContext ?? {}) as Record<string, unknown>,
    eventId: row.eventId,
    delivered: row.delivered ?? [],
    attempts: row.attempts,
  };
}

/**
 * A row owed before transitions named their subject (W1) is an entity move:
 * `subjectType` / `subjectId` are filled from `entityId` on the way out.
 */
function withSubject(t: AnyTransitionPayload): AnyTransitionPayload {
  if (t.subjectType) return t;
  const legacy = t as Omit<AnyTransitionPayload, "subjectType"> & {
    entityId: string;
  };
  return {
    ...legacy,
    subjectType: "entity",
    subjectId: legacy.entityId,
  } as AnyTransitionPayload;
}

/** Record a dispatch's outcome; an incomplete one backs off, keeping progress. */
export async function settleTransitionOutbox(
  db: Db,
  transitionId: string,
  outcome: {
    eventId: string | null;
    delivered: string[];
    complete: boolean;
    error?: string | null;
  }
): Promise<void> {
  await db
    .update(lifecycleTransitionOutbox)
    .set({
      eventId: outcome.eventId,
      delivered: outcome.delivered,
      lastError: outcome.complete ? null : (outcome.error ?? "incomplete"),
      emittedAt: outcome.complete ? sql`now()` : null,
      claimedUntil: outcome.complete
        ? null
        : sql`now() + make_interval(secs => least(power(2, ${lifecycleTransitionOutbox.attempts})::int, ${TRANSITION_OUTBOX_MAX_BACKOFF_SECONDS}))`,
    })
    .where(eq(lifecycleTransitionOutbox.transitionId, transitionId));
}

/** Pending rows whose lease or backoff has lapsed, oldest first. */
export async function listDueTransitions(
  db: Db,
  limit = 100
): Promise<string[]> {
  const rows = await db
    .select({ id: lifecycleTransitionOutbox.transitionId })
    .from(lifecycleTransitionOutbox)
    .where(
      and(
        isNull(lifecycleTransitionOutbox.emittedAt),
        or(
          isNull(lifecycleTransitionOutbox.claimedUntil),
          lt(lifecycleTransitionOutbox.claimedUntil, sql`now()`)
        ),
        lt(
          lifecycleTransitionOutbox.createdAt,
          sql`now() - make_interval(secs => ${TRANSITION_OUTBOX_SWEEP_GRACE_SECONDS})`
        )
      )
    )
    .orderBy(asc(lifecycleTransitionOutbox.createdAt))
    .limit(limit);
  return rows.map((r) => r.id);
}
