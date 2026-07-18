-- 0198_workflow_attribution_spine.sql
--
-- WORKFLOW-AS-PLACE Wave 1 (D3): the attribution spine.
--
-- Additive-only. Every statement is IF NOT EXISTS-guarded and safe to re-run.
-- No data migration, no drops. Mirrored into 0000_baseline_schema.sql and
-- schema-coherence.ts per the migration rules.
--
-- What this enables:
--   1. A proposal traces to the exact automation step that produced it
--      (proposals.step_run_id + node_id) — the run→step attribution chain.
--   2. Proposal edits are no longer lost — revision_history captures the
--      before/after of every reviseProposal (the "human corrected the AI"
--      quality signal).
--   3. Workflow-definition versioning — a monotonic version on playbooks /
--      automations, bumped on a governed definition change, plus a per-run
--      snapshot of the definition that actually executed so "what this run ran"
--      can be diffed against "the definition today".
--   4. Per-step token/cost columns + replayOf lineage (cheap now, expensive to
--      retrofit).

-- ── proposals: step attribution + revision history ───────────────────────────
-- step_run_id / node_id are SOFT references (plain uuid/text, no FK) — the same
-- pattern proposals already use for session_id / correlation_id / project_id.
-- automation_step_runs cascade-delete with their run; a soft ref keeps the
-- proposal row durable after the step run is gone (the id remains as a trace).
ALTER TABLE "proposals" ADD COLUMN IF NOT EXISTS "step_run_id" uuid;
ALTER TABLE "proposals" ADD COLUMN IF NOT EXISTS "node_id" text;
ALTER TABLE "proposals" ADD COLUMN IF NOT EXISTS "revision_history" jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS "idx_proposals_step_run_id"
  ON "proposals" ("step_run_id")
  WHERE "step_run_id" IS NOT NULL;

-- ── workflow-definition versioning ───────────────────────────────────────────
ALTER TABLE "playbooks"   ADD COLUMN IF NOT EXISTS "version" integer NOT NULL DEFAULT 1;
ALTER TABLE "automations" ADD COLUMN IF NOT EXISTS "version" integer NOT NULL DEFAULT 1;

-- ── per-run definition snapshot + replay lineage ─────────────────────────────
-- definition_snapshot stores the resolved definition this run executed (plain
-- JSON). replay_of is a soft self-reference to the run this one re-runs (schema
-- support only in Wave 1 — no rerun feature yet).
ALTER TABLE "playbook_runs"   ADD COLUMN IF NOT EXISTS "definition_snapshot" jsonb;
ALTER TABLE "playbook_runs"   ADD COLUMN IF NOT EXISTS "replay_of" uuid;
ALTER TABLE "automation_runs" ADD COLUMN IF NOT EXISTS "definition_snapshot" jsonb;
ALTER TABLE "automation_runs" ADD COLUMN IF NOT EXISTS "replay_of" uuid;

-- ── per-step token / cost attribution ────────────────────────────────────────
-- Populated only where node execution surfaces usage; NULL otherwise (IS-side
-- telemetry is out of scope for Wave 1).
ALTER TABLE "automation_step_runs" ADD COLUMN IF NOT EXISTS "tokens_used" integer;
ALTER TABLE "automation_step_runs" ADD COLUMN IF NOT EXISTS "cost_usd" numeric;
