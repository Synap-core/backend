/**
 * The lifecycle TRANSITION OUTBOX (0324, review D8).
 *
 * One row per status move, written by `applyStatusMove` in the SAME
 * transaction as the compare-and-set, so a move can never land without its
 * event owed. The dispatcher (`dispatchLifecycleTransition`, @synap/events)
 * appends the `events` log row (id = transitionId, so at most one) and runs
 * the side-effect fan-out, recording each delivered reactor; a failure leaves
 * the row pending and the sweeper retries it. `emittedAt` set = done.
 *
 * ⚠️ A DELIVERED ROW IS NOT GARBAGE: it is where a pause's HOLD is stored
 * (status-flow W4). The hold has no column; the current hold is read off this
 * table (`listHolds`, services/lifecycle/holds.ts) as the subject's LATEST
 * transition. Any retention job must keep each subject's latest row (and so
 * every row a still-paused thing's hold lives in), or holds silently vanish
 * and their date / move resumes never fire.
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
    // 0374 — the hold reads (W4): the awaited thing of `until.moves`, and a
    // subject's transitions in order.
    holdMovesIdx: index("lifecycle_transition_outbox_hold_moves_idx")
      .on(sql`(${table.transition} -> 'hold' -> 'until' ->> 'moves')`)
      .where(
        sql`(${table.transition} -> 'hold' -> 'until' ->> 'moves') IS NOT NULL`
      ),
    subjectIdx: index("lifecycle_transition_outbox_subject_idx").on(
      sql`coalesce(${table.transition} ->> 'subjectId', ${table.transition} ->> 'entityId')`,
      table.createdAt
    ),
  })
);

export type LifecycleTransitionOutboxRow =
  typeof lifecycleTransitionOutbox.$inferSelect;
