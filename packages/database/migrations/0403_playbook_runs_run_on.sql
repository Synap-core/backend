-- 0403 — Who ran a run, and why (plan v2 "Agent templates as a catalog kind",
-- slice 5a: ask once how a playbook runs, then remember it).
--
-- `run_on` records what `resolveRunChoice` decided for this run: Synap AI or
-- an agent, and how (`named` for this run, the person's `stored` choice, a
-- `fallback` to Synap AI because the remembered agent could not take it now,
-- or the playbook's `default`). Shape: `RunOn` in @synap-core/types/agents.
-- NULL = a run started before this column existed (nobody recorded why).
--
-- Re-runnable: IF NOT EXISTS.

ALTER TABLE "playbook_runs" ADD COLUMN IF NOT EXISTS "run_on" jsonb;
