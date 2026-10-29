-- 0372: nothing missed, nothing twice at the door (pipeline-health plan
-- 12d8dab9 option B, W1; findings 66e1e526, d0fbdc0e, a32021b9).
--
-- inbound_deliveries — the generic inbound webhook door
-- (`POST /api/webhooks/inbound/:subscriptionId`) used to answer 200 and THEN
-- fire its automation event, best-effort: a queue that was down, or a process
-- that died, lost the delivery, and the sender (GitHub never redelivers a 2xx)
-- had nothing to retry. Now the door writes this row BEFORE it answers, the
-- event is fanned out FROM the row, and a delivery that did not reach the
-- queue stays owed with a backoff in `claimed_until` until the sweeper cron
-- delivers it. A sender's delivery id is unique per source, so a redelivery is
-- answered 200 and recorded once. The runs it starts carry the row id
-- (`trigger_payload.inboundDeliveryId`).
--
-- observation_keys — `events` is a TimescaleDB hypertable (0237), so a unique
-- index on it must include the time column and cannot say "one row per fact".
-- The observation door claims the fact's key here first; a second producer
-- (or a re-post) of the same fact gets the first event's id back and records,
-- triggers and wakes nothing. `event_id` NULL = a claim whose write is in
-- flight; one older than its lease is taken over (a writer that died).

CREATE TABLE IF NOT EXISTS "inbound_deliveries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "subscription_id" uuid NOT NULL REFERENCES "webhook_subscriptions"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL,
  "workspace_id" uuid,
  "delivery_id" text,
  "event" text,
  "payload" jsonb NOT NULL,
  "delivered" text[] NOT NULL DEFAULT '{}'::text[],
  "attempts" integer NOT NULL DEFAULT 0,
  "last_error" text,
  "claimed_until" timestamptz,
  "dispatched_at" timestamptz,
  "received_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "inbound_deliveries_delivery_uq"
  ON "inbound_deliveries" ("subscription_id", "delivery_id")
  WHERE "delivery_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "inbound_deliveries_pending_idx"
  ON "inbound_deliveries" ("received_at") WHERE "dispatched_at" IS NULL;

CREATE INDEX IF NOT EXISTS "inbound_deliveries_user_idx"
  ON "inbound_deliveries" ("user_id", "received_at" DESC);

CREATE TABLE IF NOT EXISTS "observation_keys" (
  "key" text PRIMARY KEY,
  "event_id" uuid,
  "claimed_at" timestamptz NOT NULL DEFAULT now()
);
