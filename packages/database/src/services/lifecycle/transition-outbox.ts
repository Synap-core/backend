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
import type { StatusTransition } from "./apply-status-move.js";

type Db = PostgresJsDatabase<typeof schema>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** How long one dispatcher holds a row before another may take it. */
export const TRANSITION_OUTBOX_LEASE_SECONDS = 120;
/** Retry backoff ceiling (2^attempts seconds, capped). */
export const TRANSITION_OUTBOX_MAX_BACKOFF_SECONDS = 3600;
/** The sweeper leaves fresh rows to the inline dispatch that follows the move. */
export const TRANSITION_OUTBOX_SWEEP_GRACE_SECONDS = 30;

export interface ClaimedTransition {
  transition: StatusTransition;
  emitContext: Record<string, unknown>;
  eventId: string | null;
  delivered: string[];
  attempts: number;
}

/** Owe the transition's event — call inside the CAS transaction. */
export async function insertTransitionOutbox(
  tx: Db | Tx,
  transition: StatusTransition,
  emitContext: Record<string, unknown> = {}
): Promise<void> {
  await tx.insert(lifecycleTransitionOutbox).values({
    transitionId: transition.transitionId,
    transition,
    emitContext,
  });
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
    transition: row.transition as StatusTransition,
    emitContext: (row.emitContext ?? {}) as Record<string, unknown>,
    eventId: row.eventId,
    delivered: row.delivered ?? [],
    attempts: row.attempts,
  };
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
