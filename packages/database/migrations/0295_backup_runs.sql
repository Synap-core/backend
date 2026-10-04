-- 0295 — backup_runs: one METADATA row per backup or restore-drill run.
--
-- Written by deploy/pgdata-safety.sh (`_bk_record`, through psql) from the
-- backup container and `synap backup …`; read by GET /status/backup and
-- system.getBackupStatus through readBackupStatus() (@synap/database). Never a
-- secret in here: no repository URL, no credentials, no password — only what
-- happened, when, how big, which snapshot, and the users|entities|api_keys
-- fingerprint the drill compares against.
--
--   kind    backup | drill
--   status  ok | failed | suspect   (suspect = the fingerprint dropped; the dump
--                                    was kept aside and NOT pushed)
--   snapshot_id  restic snapshot id; NULL for a local-only or failed run
--
-- No foreign keys, pod-wide (not workspace-scoped). Fresh installs also get the
-- table from 0000_baseline_schema.sql; this file is for pods that already booted.

CREATE TABLE IF NOT EXISTS "backup_runs" (
  "id"                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "kind"              text        NOT NULL,
  "status"            text        NOT NULL,
  "started_at"        timestamptz NOT NULL,
  "finished_at"       timestamptz NOT NULL DEFAULT now(),
  "size_bytes"        bigint,
  "snapshot_id"       text,
  "fingerprint"       text,
  "drill_fingerprint" text,
  "detail"            text,
  "created_at"        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "backup_runs_kind_check" CHECK ("kind" IN ('backup', 'drill')),
  CONSTRAINT "backup_runs_status_check" CHECK ("status" IN ('ok', 'failed', 'suspect'))
);

CREATE INDEX IF NOT EXISTS "idx_backup_runs_kind_finished_at"
  ON "backup_runs" ("kind", "finished_at" DESC);
