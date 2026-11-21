-- 0444 — a cron rule whose stored zone Postgres does not know fires in UTC again.
--
-- 0441 handed every non-UTC cron row to the scheduler's self-heal, which reads
-- the zone. A zone that is not an IANA name ("Paris", "local", a typo) cannot be
-- scheduled, so the heal parked the rule as `status = 'error'`; before, it fired
-- at the UTC hour. Dropping the unknown zone restores that, and a rule the heal
-- already parked for its zone goes back to active with no stamp: the heal stamps
-- its next UTC slot on its next tick (no catch-up runs). Idempotent.

UPDATE "automations"
SET "status" = 'active',
    "error_message" = NULL,
    "next_run_at" = NULL,
    "updated_at" = now()
WHERE "trigger_type" = 'cron'
  AND "status" = 'error'
  AND COALESCE("trigger_config"->>'timezone', '') <> ''
  AND lower("trigger_config"->>'timezone') NOT IN (SELECT lower("name") FROM pg_timezone_names)
  AND "error_message" LIKE 'Unparseable cron schedule: % in time zone "' || ("trigger_config"->>'timezone') || '".%';

UPDATE "automations"
SET "trigger_config" = "trigger_config" - 'timezone',
    "updated_at" = now()
WHERE "trigger_type" = 'cron'
  AND COALESCE("trigger_config"->>'timezone', '') <> ''
  AND lower("trigger_config"->>'timezone') NOT IN (SELECT lower("name") FROM pg_timezone_names);
