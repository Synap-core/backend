/**
 * The lifecycle TRANSITION OUTBOX (0324, review D8).
 *
 * One row per status move, written by `applyStatusMove` in the SAME
 * transaction as the compare-and-set, so a move can never land without its
 * event owed. The dispatcher (`dispatchLifecycleTransition`, @synap/events)
 * appends the `events` log row (id = transitionId, so at most one) and runs
 * the side-effect fan-out, recording each delivered reactor; a failure leaves
 * the row pending and the sweeper retries it. `emittedAt` set = done.
 */
import {
  pgTable,
  uuid,
  text,
  jsonb,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const lifecycleTransitionOutbox = pgTable(
  "lifecycle_transition_outbox",
  {
    transitionId: uuid("transition_id").primaryKey(),
    /** The `StatusTransition`, exactly as the event carries it. */
    transition: jsonb("transition").notNull(),
    /** The emit options the mover passed (automation chain, correlation id). */
    emitContext: jsonb("emit_context").notNull().default({}),
    /** The `events` row once appended (= transitionId). */
    eventId: uuid("event_id"),
    /** Fan-out keys already delivered (`transition:<reactor>`, `update:<reactor>`). */
    delivered: text("delivered").array().notNull().default([]),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    /** A dispatcher's lease, then the retry backoff. NULL = due now. */
    claimedUntil: timestamp("claimed_until", {
      mode: "date",
      withTimezone: true,
    }),
    emittedAt: timestamp("emitted_at", { mode: "date", withTimezone: true }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    pendingIdx: index("lifecycle_transition_outbox_pending_idx")
      .on(table.createdAt)
      .where(sql`${table.emittedAt} IS NULL`),
  })
);

export type LifecycleTransitionOutboxRow =
  typeof lifecycleTransitionOutbox.$inferSelect;
