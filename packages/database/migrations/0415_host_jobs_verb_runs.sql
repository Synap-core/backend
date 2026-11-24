-- 0415 — Hosted verb runs queue beside an installation's check (plan b647769e
-- §3.2, plan 64072312 U8; session 7b114be6).
--
-- A computer's tool now RUNS work asked through the pod: a recipe of an
-- installed capability ("loudness-normalize this clip on my Mac"), as a host
-- job of kind `verb` on that installation. 0409 allowed ONE open job per
-- installation of any kind, so a second run (or the reconciler's due check)
-- could not queue while a run waited for a sleeping laptop.
--
-- The rule becomes: at most ONE open LIFECYCLE job per installation (install,
-- update, remove, verify, provider op), and any number of `verb` runs beside
-- it. The lease (services/host-jobs) takes a run only while its installation
-- is installed and none of its lifecycle jobs is open, so a repair runs first
-- and the run waits for it.
--
-- The index is RENAMED, not redefined in place, so schema-coherence (which
-- checks declared index names) tells a pod that never ran this migration.
-- Re-runnable: IF EXISTS / IF NOT EXISTS.

DROP INDEX IF EXISTS "uq_host_jobs_one_open_per_installation";

CREATE UNIQUE INDEX IF NOT EXISTS "uq_host_jobs_one_open_lifecycle_per_installation"
  ON "host_jobs" ("installation_id")
  WHERE "status" IN ('queued', 'leased', 'running') AND "kind" <> 'verb';
