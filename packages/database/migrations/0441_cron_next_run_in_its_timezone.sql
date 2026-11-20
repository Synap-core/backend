-- 0441 — a cron automation fires in the zone it names (ticket 592930c8).
--
-- `triggerConfig.timezone` was stored and never read: both hand-written cron
-- parsers matched the worker's clock (UTC), so a rule set to 06:50
-- Europe/Paris fired at 06:50 UTC. The pod now has ONE cron clock,
-- `nextCronRunAt` (`@synap/shared-utils`), which reads the zone.
--
-- A live row that names another zone still holds a `next_run_at` computed in
-- UTC. Clearing it hands the row to the scheduler's self-heal
-- (`healUnscheduledCronAutomations`, `automation-cron-scheduler.ts`), which
-- stamps the next slot in the row's own zone on its next tick, forward from
-- now (no catch-up runs). A UTC row (or one with no zone) keeps its stamp:
-- its hour does not move. Re-running this only re-heals the same rows.

UPDATE "automations"
SET "next_run_at" = NULL,
    "updated_at" = now()
WHERE "trigger_type" = 'cron'
  AND "status" = 'active'
  AND "next_run_at" IS NOT NULL
  AND COALESCE("trigger_config"->>'timezone', '') NOT IN ('', 'UTC');
