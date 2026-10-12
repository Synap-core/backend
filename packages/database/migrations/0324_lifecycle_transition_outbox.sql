-- 0324: the lifecycle transition OUTBOX (review 2026-10-12, D8; arch F10,
-- backend F17).
--
-- A status move used to emit its `entity.transition.completed` event AFTER the
-- compare-and-set, best-effort: a failed log append or fan-out left the thing
-- moved with no history row, no trigger, no process follow — and a retry
-- answered `unchanged`. Now `applyStatusMove` inserts this row in the SAME
-- transaction as the CAS; the dispatcher appends the log row (id =
-- transition_id, so at most one), runs the fan-out recording each delivered
-- reactor, and sets `emitted_at`. A failure leaves the row pending with a
-- backoff in `claimed_until`; the sweeper cron retries it. Idempotent.

CREATE TABLE IF NOT EXISTS "lifecycle_transition_outbox" (
  "transition_id" uuid PRIMARY KEY,
  "transition" jsonb NOT NULL,
  "emit_context" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "event_id" uuid,
  "delivered" text[] NOT NULL DEFAULT '{}'::text[],
  "attempts" integer NOT NULL DEFAULT 0,
  "last_error" text,
  "claimed_until" timestamptz,
  "emitted_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "lifecycle_transition_outbox_pending_idx"
  ON "lifecycle_transition_outbox" ("created_at") WHERE "emitted_at" IS NULL;
