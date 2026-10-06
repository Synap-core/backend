-- 0304: how many AI dispatches (IS commands + agent playbook runs) a run started.
--
-- The executor bumps it once per dispatch, as it happens, so a run that dies
-- midway still counts what it spent. The per-automation daily cap
-- (`triggerConfig.maxAiDispatchesPerDay`, default in
-- `@synap-core/types/automations` ai-dispatch-guardrails.ts) sums it over the
-- rule's runs in a rolling 24h, on every trigger origin — cron included, which
-- the matcher-only `maxRunsPerDay` never covered.
--
-- NOT NULL DEFAULT 0: every pre-existing run counts as zero, which is the
-- honest reading of "no dispatch was recorded". Idempotent.
ALTER TABLE "automation_runs"
  ADD COLUMN IF NOT EXISTS "ai_dispatch_count" integer NOT NULL DEFAULT 0;
