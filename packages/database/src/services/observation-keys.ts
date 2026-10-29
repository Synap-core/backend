/**
 * One row per observed FACT (0372, pipeline-health W1) — the dedupe the
 * observation door (`recordObservation`, api services/observations) needs
 * and the `events` hypertable cannot carry as a unique index.
 *
 *   claim (before the event is written) → settle (the event's id) | release
 *   (the write failed, so a retry may record it).
 *
 * A claim with no event that is older than the lease belongs to a writer that
 * died between the claim and the write; the next claimer takes it over, so a
 * crash never loses the fact for good.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "../schema/index.js";
import { observationKeys } from "../schema/inbound-deliveries.js";

type Db = PostgresJsDatabase<typeof schema>;

/** How long a claim with no event yet is honoured before it is taken over. */
export const OBSERVATION_KEY_LEASE_SECONDS = 120;

export type ObservationKeyClaim =
  | { owned: true }
  /** Already recorded (`eventId`), or being recorded right now (`null`). */
  | { owned: false; eventId: string | null };

export async function claimObservationKey(
  db: Db,
  key: string
): Promise<ObservationKeyClaim> {
  const [row] = await db
    .insert(observationKeys)
    .values({ key })
    .onConflictDoUpdate({
      target: observationKeys.key,
      set: { claimedAt: sql`now()` },
      setWhere: and(
        isNull(observationKeys.eventId),
        sql`${observationKeys.claimedAt} < now() - make_interval(secs => ${OBSERVATION_KEY_LEASE_SECONDS})`
      ),
    })
    .returning({ key: observationKeys.key });
  if (row) return { owned: true };
  const [held] = await db
    .select({ eventId: observationKeys.eventId })
    .from(observationKeys)
    .where(eq(observationKeys.key, key))
    .limit(1);
  return { owned: false, eventId: held?.eventId ?? null };
}

/** The fact is recorded: later claims get this event back. */
export async function settleObservationKey(
  db: Db,
  key: string,
  eventId: string
): Promise<void> {
  await db
    .update(observationKeys)
    .set({ eventId })
    .where(eq(observationKeys.key, key));
}

/** The write failed: give the key back so a retry can record the fact. */
export async function releaseObservationKey(
  db: Db,
  key: string
): Promise<void> {
  await db
    .delete(observationKeys)
    .where(and(eq(observationKeys.key, key), isNull(observationKeys.eventId)));
}
