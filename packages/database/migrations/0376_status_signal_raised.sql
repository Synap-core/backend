-- 0376: the status watcher's episode claims (status-flow W6).
--
-- One row per raised signal episode. The watcher claims the episode here
-- (INSERT … ON CONFLICT DO NOTHING RETURNING) before it raises the derived
-- `<subject>.signal.completed` event, so an episode is raised once even when
-- two ticks race. The `events` hypertable cannot carry this unique key: its
-- primary key includes the timestamp. Idempotent.

CREATE TABLE IF NOT EXISTS "status_signal_raised" (
  "subject_type" text NOT NULL,
  "subject_id"   text NOT NULL,
  "signal"       text NOT NULL,
  "episode_key"  text NOT NULL,
  "raised_at"    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("subject_type", "subject_id", "signal", "episode_key")
);
