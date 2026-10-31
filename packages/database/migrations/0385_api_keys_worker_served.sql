-- 0385: when a process that RUNS an agent last called with this key
-- (computers plan v2 S3 step 1, review M4 and S1).
--
-- `last_used_at` is any use of the key, so an interactive conversation on the
-- same identity reads as "live" although nothing takes handed work. The CLI
-- worker sends `X-Synap-Runner: synap-worker/<version>` on its polls; the MCP
-- door stamps `worker_served_at` (and the version) on the calling key, at most
-- once a minute (`recordWorkerServed`). NULL = no runner ever sent the header
-- on this key: not measured, never "not running". A column on the key, not
-- `users.agent_metadata`: several writers rewrite that object whole.
--
-- Expand only: nothing reads it as `live` yet. No backfill. Idempotent.

ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "worker_served_at" timestamp with time zone;
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "worker_served_version" text;
