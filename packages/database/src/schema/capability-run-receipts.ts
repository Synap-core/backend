/**
 * Capability Run Receipts Schema
 *
 * At-most-once claim for a DIRECT-run WRITE/external capability verb (0219).
 *
 * THE GAP THIS CLOSES (self-documented in execute-capability.ts): a WRITE /
 * external-send verb run on the DIRECT path (`decision === "run"` — owner-bypass
 * or governance-auto-granted, no proposal) fires an irreversible side effect
 * (email / message / provider write) with NO persisted receipt. A
 * client-perceived-failure RETRY re-runs the same call → a SECOND real send. The
 * PROPOSAL path already closes this via `dispatchExternalOnce` (a CAS claim on
 * `proposals.external_dispatched_at`); this table is the DIRECT path's analog.
 *
 * MECHANISM: before the external effect, the door CAS-claims a row keyed on
 * `(idempotency_key, dedup_bucket)`. The claim is an INSERT … ON CONFLICT DO
 * NOTHING — the loser of a race (a retry, or a concurrent identical call) finds
 * the prior row and REPLAYS its stored result instead of re-running the effect.
 * On a definite not-delivered outcome the claim is RELEASED (deleted) so a retry
 * re-runs cleanly; on an ambiguous throw the claim is KEPT (never a double-send).
 *
 * WINDOWED (mirrors 0216 knowledge_facts + write-door-idempotency): `dedup_bucket`
 * = floor(epoch(now) / 600) applied as a DB column DEFAULT — a ~10-minute window
 * so a retry collapses onto the claim, while a GENUINELY repeated identical run
 * later (a new bucket) is NOT blocked. READ-only verbs never write a receipt.
 */

import {
  pgTable,
  uuid,
  text,
  bigint,
  jsonb,
  timestamp,
} from "drizzle-orm/pg-core";

export const capabilityRunReceipts = pgTable("capability_run_receipts", {
  id: uuid("id").defaultRandom().primaryKey(),
  /**
   * The effective idempotency key: the caller's explicit `idempotencyKey` when
   * supplied, else a content hash over (door + verb/skill + params + user +
   * workspace + connection selector) — see `resolveWriteIdempotencyKey`. A retry
   * reproduces the SAME key; a genuinely different payload yields a different one.
   */
  idempotencyKey: text("idempotency_key").notNull(),
  /**
   * ~10-minute dedup window bucket — floor(epoch(now) / 600), applied as a DB
   * column DEFAULT at insert time (NOT generated: extract(epoch FROM timestamptz)
   * is STABLE not IMMUTABLE — PG 42P17). The app never writes this; the DEFAULT
   * fills it. Paired with `idempotency_key` in a UNIQUE index for the CAS claim.
   */
  dedupBucket: bigint("dedup_bucket", { mode: "number" }),
  userId: text("user_id").notNull(),
  workspaceId: uuid("workspace_id"),
  skillId: uuid("skill_id").notNull(),
  verbId: text("verb_id"),
  /** 'claimed' (in-flight) → 'completed' (result stored, replayable). */
  status: text("status", { enum: ["claimed", "completed"] })
    .notNull()
    .default("claimed"),
  /** The delivered run's result, stored so a duplicate replays it verbatim. */
  result: jsonb("result").$type<unknown>(),
  /** The run's observability handle — a duplicate replays the same correlationId. */
  correlationId: uuid("correlation_id"),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
  completedAt: timestamp("completed_at", { mode: "date", withTimezone: true }),
});

export type CapabilityRunReceipt = typeof capabilityRunReceipts.$inferSelect;
export type NewCapabilityRunReceipt = typeof capabilityRunReceipts.$inferInsert;
