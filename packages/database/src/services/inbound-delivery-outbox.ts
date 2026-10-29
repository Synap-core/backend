/**
 * The inbound delivery OUTBOX's state machine (0372, pipeline-health W1).
 * Storage only — the dispatcher that fans the automation event out is
 * `dispatchInboundDelivery` (@synap/events), which this package cannot reach.
 * Same shape as the lifecycle transition outbox (transition-outbox.ts):
 *
 *   record (in the door, before its 200) → claim (a lease) → settle:
 *     complete ⇒ `dispatched_at` (the door owes nothing more: the event
 *     reached the queue, or there was nothing to fire and `last_error` says
 *     why), never claimed again;
 *     incomplete ⇒ `delivered` kept, the lease turned into a backoff, and the
 *     sweeper's `listDueInboundDeliveries` picks the row up when it lapses.
 *
 * Exactly once per sender delivery: `(subscription_id, delivery_id)` is a
 * unique index, so a redelivery is recorded once (`duplicate: true`), and the
 * claim is a conditional UPDATE, so two dispatchers never hold one row.
 */
import { and, asc, eq, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "../schema/index.js";
import {
  inboundDeliveries,
  type InboundDeliveryRow,
} from "../schema/inbound-deliveries.js";

type Db = PostgresJsDatabase<typeof schema>;

/** How long one dispatcher holds a row before another may take it. */
export const INBOUND_DELIVERY_LEASE_SECONDS = 120;
/** Retry backoff ceiling (2^attempts seconds, capped). */
export const INBOUND_DELIVERY_MAX_BACKOFF_SECONDS = 3600;
/** The sweeper leaves fresh rows to the inline dispatch the door runs. */
export const INBOUND_DELIVERY_SWEEP_GRACE_SECONDS = 30;
/**
 * A row still undelivered after this many attempts is left for a person
 * (with ~1 h backoffs, about half a day of retries); its `last_error` says why.
 */
export const INBOUND_DELIVERY_MAX_ATTEMPTS = 20;
/** Delivered rows are kept this long (GitHub keeps its own log 3 days). */
export const INBOUND_DELIVERY_RETENTION_DAYS = 14;

export interface RecordInboundDeliveryInput {
  subscriptionId: string;
  userId: string;
  workspaceId: string | null;
  deliveryId?: string | null;
  event?: string | null;
  payload: unknown;
}

/**
 * Store one delivery. `duplicate: true` = the sender already delivered this id
 * to this subscription: `id` is the first row, and nothing new was stored.
 */
export async function recordInboundDelivery(
  db: Db,
  input: RecordInboundDeliveryInput
): Promise<{ id: string; duplicate: boolean }> {
  const deliveryId = input.deliveryId ?? null;
  const [row] = await db
    .insert(inboundDeliveries)
    .values({
      subscriptionId: input.subscriptionId,
      userId: input.userId,
      workspaceId: input.workspaceId,
      deliveryId,
      event: input.event ?? null,
      payload: input.payload ?? null,
    })
    .onConflictDoNothing({
      target: [inboundDeliveries.subscriptionId, inboundDeliveries.deliveryId],
      where: isNotNull(inboundDeliveries.deliveryId),
    })
    .returning({ id: inboundDeliveries.id });
  if (row) return { id: row.id, duplicate: false };
  // Only a delivery id can conflict, so it is set here.
  const [first] = await db
    .select({ id: inboundDeliveries.id })
    .from(inboundDeliveries)
    .where(
      and(
        eq(inboundDeliveries.subscriptionId, input.subscriptionId),
        eq(inboundDeliveries.deliveryId, deliveryId as string)
      )
    )
    .limit(1);
  if (!first) {
    throw new Error(
      `inbound delivery ${deliveryId} conflicted but no row holds it`
    );
  }
  return { id: first.id, duplicate: true };
}

/** Take the row for one dispatch, or `null` (done, or held by another). */
export async function claimInboundDelivery(
  db: Db,
  id: string
): Promise<InboundDeliveryRow | null> {
  const [row] = await db
    .update(inboundDeliveries)
    .set({
      attempts: sql`${inboundDeliveries.attempts} + 1`,
      claimedUntil: sql`now() + make_interval(secs => ${INBOUND_DELIVERY_LEASE_SECONDS})`,
    })
    .where(
      and(
        eq(inboundDeliveries.id, id),
        isNull(inboundDeliveries.dispatchedAt),
        or(
          isNull(inboundDeliveries.claimedUntil),
          lt(inboundDeliveries.claimedUntil, sql`now()`)
        )
      )
    )
    .returning();
  return row ?? null;
}

/** Record a dispatch's outcome; an incomplete one backs off, keeping progress. */
export async function settleInboundDelivery(
  db: Db,
  id: string,
  outcome: { delivered: string[]; complete: boolean; error?: string | null }
): Promise<void> {
  await db
    .update(inboundDeliveries)
    .set({
      delivered: outcome.delivered,
      // A complete settle may still say why nothing fired (no space).
      lastError: outcome.error ?? (outcome.complete ? null : "incomplete"),
      dispatchedAt: outcome.complete ? sql`now()` : null,
      claimedUntil: outcome.complete
        ? null
        : sql`now() + make_interval(secs => least(power(2, ${inboundDeliveries.attempts})::int, ${INBOUND_DELIVERY_MAX_BACKOFF_SECONDS}))`,
    })
    .where(eq(inboundDeliveries.id, id));
}

/** Undelivered rows whose lease or backoff has lapsed, oldest first. */
export async function listDueInboundDeliveries(
  db: Db,
  limit = 100
): Promise<string[]> {
  const rows = await db
    .select({ id: inboundDeliveries.id })
    .from(inboundDeliveries)
    .where(
      and(
        isNull(inboundDeliveries.dispatchedAt),
        lt(inboundDeliveries.attempts, INBOUND_DELIVERY_MAX_ATTEMPTS),
        or(
          isNull(inboundDeliveries.claimedUntil),
          lt(inboundDeliveries.claimedUntil, sql`now()`)
        ),
        lt(
          inboundDeliveries.receivedAt,
          sql`now() - make_interval(secs => ${INBOUND_DELIVERY_SWEEP_GRACE_SECONDS})`
        )
      )
    )
    .orderBy(asc(inboundDeliveries.receivedAt))
    .limit(limit);
  return rows.map((r) => r.id);
}

/** Drop delivered rows past retention; an undelivered row is never dropped. */
export async function pruneInboundDeliveries(db: Db): Promise<number> {
  const rows = await db
    .delete(inboundDeliveries)
    .where(
      and(
        isNotNull(inboundDeliveries.dispatchedAt),
        lt(
          inboundDeliveries.dispatchedAt,
          sql`now() - make_interval(days => ${INBOUND_DELIVERY_RETENTION_DAYS})`
        )
      )
    )
    .returning({ id: inboundDeliveries.id });
  return rows.length;
}
