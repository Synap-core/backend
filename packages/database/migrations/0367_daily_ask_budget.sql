-- 0367 — the daily ask budget (D7, founder-approved 28 Oct 2026, plan
-- 9acca984 §M5, report 6e8c654e §3.4).
--
-- The budget is on the PERSON's attention, not on the agent's writes: the
-- engine still decides WHETHER a person must decide (every floor holds); the
-- budget decides when and how loudly they are asked. At most
-- `daily_ask_count` asks (default 5, `CEILING_DEFAULTS`) are headlined per
-- person per local day; the rest wait in "Later", which never pushes and never
-- auto-approves.
--
-- 1. A new `governance_ceilings` axis, `daily_ask_count`. Its subject is the
--    person (`subject_type = 'user'`, `subject_id = <user id>`); read through
--    the ONE ceiling resolver (`resolveCeiling`).
--
-- 2. `daily_asks` — the ONE count. The first time an ask is headlined on a
--    person's local day (a needs-you read of their whole pod, or a push), it
--    gets a row here, until `daily_ask_count` rows exist for that day. A row
--    is the stamp "this was one of today's asks", so the rail badge, Home,
--    the phone and pod-admin read the same rows instead of re-ranking.
--    `item_kind` + `item_id` name the ask unit: `proposal` (a proposal id; a
--    cluster is stamped through one member), `slot` (an owed slot's signal
--    id) or `access-request`. Owner-only read (access/registry.ts).
--
-- TRANSACTION NOTE: as 0266 / 0330 — `ALTER TYPE … ADD VALUE` is legal inside
-- the migration transaction on Postgres 12+ when the value is not used in it.

ALTER TYPE governance_ceiling_axis ADD VALUE IF NOT EXISTS 'daily_ask_count';

CREATE TABLE IF NOT EXISTS "daily_asks" (
  "id"           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"      text        NOT NULL,
  "day"          date        NOT NULL,
  "item_kind"    text        NOT NULL,
  "item_id"      text        NOT NULL,
  "rank"         integer     NOT NULL,
  "surfaced_at"  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "daily_asks_user_day_item_uniq"
  ON "daily_asks" ("user_id", "day", "item_kind", "item_id");

CREATE INDEX IF NOT EXISTS "daily_asks_user_day_idx"
  ON "daily_asks" ("user_id", "day");
