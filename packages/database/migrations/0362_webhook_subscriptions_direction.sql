-- 0362_webhook_subscriptions_direction
--
-- An INBOUND webhook source (founder decisions 2026-10-27, f6852c36 / 4872b139):
-- an outside service (a GitHub org webhook) posts signed events to the pod's
-- generic door `/api/webhooks/inbound/:id`, which fires the space's
-- webhook-triggered automations. Until now the only way to get such a door was
-- an OUTBOUND subscription, whose create doors require a url and event types —
-- so every "inbound" row also RECEIVED the pod's events (and an empty
-- `event_types` means "all events" to the outbound match rule).
--
-- `direction` says which way a row points: 'outbound' (the pod POSTs its
-- events to `url`, every row so far) or 'inbound' (the pod RECEIVES at its
-- own door; never delivered to, so it has no url). Both outbound producers
-- select `direction = 'outbound'` only.
--
-- One inbound source per (space, name): an automation declares the source it
-- needs BY NAME (`triggerConfig.webhookSource.name`) and every install binds
-- the same row, never a twin.
--
-- Additive: existing rows default to 'outbound' and keep their url. A rollback
-- onto this schema is safe but noisy: the previous release does not read
-- `direction`, so it would try to deliver its events to an inbound row (empty
-- event types = all events) and fail each delivery at the missing url — no
-- byte leaves the pod. Pause the inbound sources before rolling back.

ALTER TABLE "webhook_subscriptions" ADD COLUMN IF NOT EXISTS "direction" text NOT NULL DEFAULT 'outbound';
ALTER TABLE "webhook_subscriptions" ALTER COLUMN "url" DROP NOT NULL;

DO $$ BEGIN
  ALTER TABLE "webhook_subscriptions" ADD CONSTRAINT "webhook_subscriptions_direction_check"
    CHECK ("direction" IN ('outbound', 'inbound') AND ("direction" = 'inbound' OR "url" IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "webhook_subscriptions_inbound_name_uq"
  ON "webhook_subscriptions" ("workspace_id", lower("name"))
  WHERE "direction" = 'inbound';
