-- 0373 — a runner is a process, not only a conversation (W7 twin signal,
-- founder decision 76da3e16, finding 702bb50f).
--
-- Two live copies of ONE Claude Code conversation (the same session resumed
-- twice) send the same client key, so `session_runners` (PK session_id,
-- client_key) kept ONE row and the second copy overwrote the first: the pod
-- could not see a twin. The calling client now names its OS process
-- (`X-Synap-Process: <host>:<pid>:<startedAtMs>`), stored beside the client
-- key; the primary key gains it, so each live process is its own row.
--
-- NOT inside `client_key`: that value is also `focus_sessions.metadata.clientKey`
-- and the resume derivation's input; a process id there would split one
-- conversation into one session per process.
--
-- Existing rows and legacy clients (no header) keep `process_key = ''`: the same
-- single row per (session, client key) as before, never read as a twin. The
-- 150 s liveness window (RUNNER_LIVE_WINDOW_SECONDS) is unchanged and applies
-- per row, so a closed copy stops counting 150 s after its last stamp.
--
-- Rolling deploy: until the new code runs, the old upsert's
-- `ON CONFLICT (session_id, client_key)` finds no matching constraint and its
-- stamp fails; that failure is logged and never thrown (presence telemetry).
--
-- Fresh installs get all of this from 0000_baseline_schema.sql.

ALTER TABLE "session_runners" ADD COLUMN IF NOT EXISTS "process_key" text NOT NULL DEFAULT '';
ALTER TABLE "session_runners" ADD COLUMN IF NOT EXISTS "process_host" text;
ALTER TABLE "session_runners" ADD COLUMN IF NOT EXISTS "process_started_at" timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
    WHERE i.indrelid = 'session_runners'::regclass
      AND i.indisprimary
      AND a.attname = 'process_key'
  ) THEN
    ALTER TABLE "session_runners" DROP CONSTRAINT IF EXISTS "session_runners_pkey";
    ALTER TABLE "session_runners" ADD PRIMARY KEY ("session_id", "client_key", "process_key");
  END IF;
END $$;
