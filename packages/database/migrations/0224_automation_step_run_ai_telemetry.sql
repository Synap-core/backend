-- 0224_automation_step_run_ai_telemetry.sql
--
-- "Why was this generation empty?" — the pod↔IS seam made observable.
--
-- 2026-08-03: an `ai.generate` step ran 24.5s, returned "", and was recorded
-- `completed`. `synap diagnose` could print `out (empty)` and NOTHING MORE,
-- because the IS `/v1/tools/generate` route returned only `{ output }`. The only
-- way to learn WHY was to SSH to the IS container and correlate unstructured
-- logs by wall-clock timestamp.
--
-- `finish_reason` is the single field that answers it: `length` (truncated at
-- maxTokens), `content-filter` (refused), `error` (provider fault), `stop` (the
-- model genuinely emitted nothing). `tokens_in`/`tokens_out` say whether the
-- prompt was even read and whether anything came back.
--
-- REAL COLUMNS, not JSONB — mirroring 0131's identical decision on `events`, and
-- joining the `tokens_used`/`cost_usd` columns 0198 already added to this table.
-- Justified because they are QUERIED, not just displayed: "which steps truncate"
-- and "what does this flow cost per run" are aggregate questions. The step's
-- `output` JSONB cannot host them — it IS the node's flat output value under a
-- published template contract (`steps.<id>.output.<field>`) — and
-- `resolved_inputs` is semantically the step's inputs.
--
-- All nullable with NO default: a non-AI step simply leaves them NULL, and an
-- absent provider usage report stays NULL rather than a fabricated 0. Every
-- statement is IF NOT EXISTS — safe to re-run, safe on a fresh install, and
-- safe against the LIVE pod (nullable ADD COLUMN with no default takes no
-- table rewrite and no long lock).

ALTER TABLE "automation_step_runs" ADD COLUMN IF NOT EXISTS "tokens_in"     integer;
ALTER TABLE "automation_step_runs" ADD COLUMN IF NOT EXISTS "tokens_out"    integer;
ALTER TABLE "automation_step_runs" ADD COLUMN IF NOT EXISTS "finish_reason" text;

-- "Show me every step that did NOT finish cleanly" — the whole point of the
-- column. Partial so it only indexes the rare diagnostic rows.
CREATE INDEX IF NOT EXISTS "automation_step_runs_finish_reason_idx"
  ON "automation_step_runs" ("finish_reason")
  WHERE "finish_reason" IS NOT NULL AND "finish_reason" <> 'stop';
