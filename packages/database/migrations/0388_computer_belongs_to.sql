-- 0388: whose computer it is (computers plan v2 §4, review K3, plan v1 W3.1).
--
-- A computer is a `machine` agent user (device flow, decision 4b11446e). It
-- gets ONE new fact, stored once, as a column (governance reads it; the 0038
-- precedent of identity in columns, never `agent_metadata`, which several
-- writers rewrite whole):
--   'person' — the person's own computer; agents on it are guests (default);
--   'agent'  — a box an agent owns: a person's auto rule for an agent on it is
--              also written for the computer (decision c83e0661);
--   'shared' — a computer many work on (cloud, the pod's own).
-- NULL on every row that is not a computer.
--
-- Written only by the device approval and `machines.setBelongsTo` (a person,
-- signed in). `device_auth_requests.computer_belongs_to` carries the
-- approver's choice until the terminal collects the key, like `machine_name`.
--
-- Backfill: every existing computer is the person's own (the default). A
-- name-only "computer" (a key label) has no row and gets nothing. Idempotent.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "computer_belongs_to" text;

DO $$ BEGIN
  ALTER TABLE "users" ADD CONSTRAINT "users_computer_belongs_to_check"
    CHECK ("computer_belongs_to" IS NULL
      OR "computer_belongs_to" IN ('person', 'agent', 'shared'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

UPDATE "users" SET "computer_belongs_to" = 'person'
  WHERE "agent_type" = 'machine' AND "computer_belongs_to" IS NULL;

ALTER TABLE "device_auth_requests"
  ADD COLUMN IF NOT EXISTS "computer_belongs_to" text;
