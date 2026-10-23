-- 0346 — WHO IS ON A GOAL (work model W3, decision 3, 2026-10-23)
--
-- A goal (a track) has ONE owner — a person — a JUDGE (a person; no judge
-- row means the owner judges), any number of DELEGATES (people or agents),
-- each with a COMMITMENT they accept, counter or decline and may later report
-- impossible, and an optional INTEGRATOR. One row per (goal, principal, role):
-- a judge who is also a delegate is two rows, which `links` (one edge per
-- pair) cannot hold.
--
--   principal_kind    person · agent
--   principal_id      a users.id: the person's, or the agent's own user row
--   role              owner · judge · delegate · integrator
--   commitment        what the delegate commits to
--   commitment_state  proposed · accepted · countered · declined ·
--                     reported_impossible · done   (a delegate's only)
--   counter_text      the delegate's counter-offer
--   reported_reason/at  why and when it was reported impossible (R1: a
--                     declined commitment, never the goal's verdict)
--   acknowledged_at   when the owner or judge acknowledged the report
--   escalated_at      when the R10 job told the owner the report was not
--                     acknowledged after 48 h — once per report
--   decided_by/at     who made the last decision on the row, and when
--
-- Owner and judge must be PERSONS (CHECK): the goal's declaration stays
-- human. A participant row grants NO read (D5-A).
--
-- Backfill: every existing track gets its OWNER row — the person who started
-- it (`project_tracks.user_id`). When that id is an AGENT (a pod-wide agent
-- key that started a track), the owner is the person the agent belongs to
-- (`users.created_by_user_id`, when that is a human), else the project's
-- owner. No judge row is written: the owner judges.
--
-- `project_tracks` is NOT in 0000_baseline_schema.sql (it references
-- `projects`, created by 0151), so neither is this table: schema-coherence.ts
-- guards its columns and indexes. Idempotent: IF NOT EXISTS, drop-then-add,
-- and the backfill skips a track that already has an owner.

CREATE TABLE IF NOT EXISTS "track_participants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "track_id" uuid NOT NULL REFERENCES "project_tracks"("id") ON DELETE CASCADE,
  "principal_kind" text NOT NULL,
  "principal_id" text NOT NULL,
  "role" text NOT NULL,
  "commitment" text,
  "commitment_state" text,
  "counter_text" text,
  "reported_reason" text,
  "reported_at" timestamptz,
  "acknowledged_at" timestamptz,
  "escalated_at" timestamptz,
  "decided_by" text NOT NULL,
  "decided_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "track_participants" DROP CONSTRAINT IF EXISTS "track_participants_shape_check";
ALTER TABLE "track_participants"
  ADD CONSTRAINT "track_participants_shape_check"
  CHECK (
    "principal_kind" IN ('person', 'agent')
    AND "role" IN ('owner', 'judge', 'delegate', 'integrator')
    -- Owner and judge are people.
    AND ("role" NOT IN ('owner', 'judge') OR "principal_kind" = 'person')
    -- A delegate's commitment has a state; no other role carries one.
    AND (
      ("role" = 'delegate'
        AND "commitment_state" IS NOT NULL
        AND "commitment_state" IN (
          'proposed', 'accepted', 'countered', 'declined',
          'reported_impossible', 'done'))
      OR ("role" <> 'delegate' AND "commitment_state" IS NULL)
    )
    -- A report carries its reason and time. `coalesce` because a CHECK passes
    -- on NULL and `NULL <> 'x'` is NULL.
    AND (
      coalesce("commitment_state", '') <> 'reported_impossible'
      OR (btrim(coalesce("reported_reason", '')) <> '' AND "reported_at" IS NOT NULL)
    )
    AND (
      coalesce("commitment_state", '') <> 'countered'
      OR btrim(coalesce("counter_text", '')) <> ''
    )
  );

CREATE INDEX IF NOT EXISTS "idx_track_participants_track_id"
  ON "track_participants" ("track_id");
CREATE INDEX IF NOT EXISTS "idx_track_participants_principal_id"
  ON "track_participants" ("principal_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_track_participants_role"
  ON "track_participants" ("track_id", "principal_id", "role");
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_track_participants_owner"
  ON "track_participants" ("track_id") WHERE "role" = 'owner';
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_track_participants_judge"
  ON "track_participants" ("track_id") WHERE "role" = 'judge';

INSERT INTO "track_participants"
  ("track_id", "principal_kind", "principal_id", "role", "decided_by", "decided_at", "created_at")
SELECT o."track_id", 'person', o."owner_id", 'owner', o."owner_id", o."created_at", o."created_at"
  FROM (
    SELECT t."id" AS "track_id",
           t."created_at",
           CASE
             WHEN u."user_type" = 'agent' THEN coalesce(op."id", p."user_id")
             ELSE t."user_id"
           END AS "owner_id"
      FROM "project_tracks" t
      JOIN "projects" p ON p."id" = t."project_id"
      LEFT JOIN "users" u ON u."id" = t."user_id"
      LEFT JOIN "users" op
        ON op."id" = u."created_by_user_id" AND op."user_type" = 'human'
  ) o
 WHERE NOT EXISTS (
   SELECT 1 FROM "track_participants" x
    WHERE x."track_id" = o."track_id" AND x."role" = 'owner'
 );
