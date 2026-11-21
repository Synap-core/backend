-- 0445 — a person owns what an agent makes, for tools, capabilities, skills,
-- artifacts and workspaces (0442/0443 did automations and playbooks).
--
-- 1. The actor column on tools, capabilities and skills (`agent_user_id`,
--    nullable: a person's own row has no agent). Artifacts already carry the
--    actor (`actor_id` + `origin_kind`); a workspace's agent is its member row
--    and, for an agent's space, `settings.linkedAgentId`.
-- 2. For every row whose owner is an agent user (`users.user_type = 'agent'`):
--    the agent is copied into the actor FIRST, then the owner becomes the first
--    person found, with the rungs of 0443:
--      a. the person the approved create proposal was filed for
--         (`proposals.subject_user_id`, matched on `target_id` = the row id);
--      b. the one person the agent's keys act for (`api_keys.linked_user_id`,
--         exactly one distinct person);
--      c. the person who created the agent (`users.created_by_user_id`).
--    Only a human users row qualifies at each rung. A row whose agent stands
--    for no person keeps the agent as owner.
-- 3. A workspace that moves keeps its agent as an `admin` member (it had
--    access through ownership; an agent never holds `owner`) and gives its
--    person the `owner` membership.
-- 4. What was read through the workspace's owner keeps working: the pod's
--    connector credentials (`secrets` of service `nango-connector` and
--    `stalwart-connector`, read under the OLDEST workspace's owner) move to
--    the person unless the person already holds one; a messaging account of
--    the agent with no pin is pinned to the workspace it was homed in (its
--    owner's first workspace).
--
-- Idempotent: the actor is filled only when empty, and a row moves only while
-- an agent still owns it. Count what is left after the migration with:
--   SELECT 'tools', count(*) FROM tools t JOIN users u ON u.id = t.created_by WHERE u.user_type = 'agent'
--   UNION ALL SELECT 'capabilities', count(*) FROM capabilities c JOIN users u ON u.id = c.created_by WHERE u.user_type = 'agent'
--   UNION ALL SELECT 'skills', count(*) FROM skills s JOIN users u ON u.id = s.user_id WHERE u.user_type = 'agent'
--   UNION ALL SELECT 'artifacts', count(*) FROM artifacts a JOIN users u ON u.id = a.user_id WHERE u.user_type = 'agent'
--   UNION ALL SELECT 'workspaces', count(*) FROM workspaces w JOIN users u ON u.id = w.owner_id WHERE u.user_type = 'agent';

ALTER TABLE "tools" ADD COLUMN IF NOT EXISTS "agent_user_id" text;
ALTER TABLE "capabilities" ADD COLUMN IF NOT EXISTS "agent_user_id" text;
ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "agent_user_id" text;

DO $$ BEGIN
  ALTER TABLE "tools"
    ADD CONSTRAINT "tools_agent_user_id_fkey"
    FOREIGN KEY ("agent_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "capabilities"
    ADD CONSTRAINT "capabilities_agent_user_id_fkey"
    FOREIGN KEY ("agent_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "skills"
    ADD CONSTRAINT "skills_agent_user_id_fkey"
    FOREIGN KEY ("agent_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "idx_tools_agent_user_id" ON "tools" ("agent_user_id");
CREATE INDEX IF NOT EXISTS "idx_capabilities_agent_user_id" ON "capabilities" ("agent_user_id");
CREATE INDEX IF NOT EXISTS "skills_agent_user_id_idx" ON "skills" ("agent_user_id");

-- The rungs, once. ($1 agent id, $2 proposal target_type, $3 row id.)
CREATE OR REPLACE FUNCTION "_0445_person_of_agent_row"(text, text, text)
RETURNS text LANGUAGE sql STABLE AS $fn$
  SELECT COALESCE(
    (SELECT s."id"
       FROM "proposals" AS pr
       JOIN "users" AS s ON s."id" = pr."subject_user_id" AND s."user_type" <> 'agent'
      WHERE pr."target_type" = $2
        AND pr."proposal_type" = 'create'
        AND pr."target_id" = $3
        AND pr."status" = 'approved'
      ORDER BY pr."created_at" DESC
      LIMIT 1),
    (SELECT min(k."linked_user_id")
       FROM "api_keys" AS k
       JOIN "users" AS lp ON lp."id" = k."linked_user_id" AND lp."user_type" <> 'agent'
      WHERE k."user_id" = $1
     HAVING count(DISTINCT k."linked_user_id") = 1),
    (SELECT c."id"
       FROM "users" AS ag
       JOIN "users" AS c ON c."id" = ag."created_by_user_id" AND c."user_type" <> 'agent'
      WHERE ag."id" = $1)
  )
$fn$;

-- ── tools ────────────────────────────────────────────────────────────────
UPDATE "tools" AS t
   SET "agent_user_id" = t."created_by"
  FROM "users" AS u
 WHERE u."id" = t."created_by" AND u."user_type" = 'agent'
   AND t."agent_user_id" IS NULL;

UPDATE "tools" AS t
   SET "created_by" = m."person_id"
  FROM (
    SELECT t2."id", "_0445_person_of_agent_row"(t2."created_by", 'tool', t2."id"::text) AS "person_id"
      FROM "tools" AS t2
      JOIN "users" AS u ON u."id" = t2."created_by" AND u."user_type" = 'agent'
  ) AS m
 WHERE t."id" = m."id" AND m."person_id" IS NOT NULL;

-- ── capabilities ─────────────────────────────────────────────────────────
UPDATE "capabilities" AS c
   SET "agent_user_id" = c."created_by"
  FROM "users" AS u
 WHERE u."id" = c."created_by" AND u."user_type" = 'agent'
   AND c."agent_user_id" IS NULL;

UPDATE "capabilities" AS c
   SET "created_by" = m."person_id"
  FROM (
    SELECT c2."id", "_0445_person_of_agent_row"(c2."created_by", 'capability', c2."id"::text) AS "person_id"
      FROM "capabilities" AS c2
      JOIN "users" AS u ON u."id" = c2."created_by" AND u."user_type" = 'agent'
  ) AS m
 WHERE c."id" = m."id" AND m."person_id" IS NOT NULL;

-- ── skills ───────────────────────────────────────────────────────────────
UPDATE "skills" AS s
   SET "agent_user_id" = s."user_id"
  FROM "users" AS u
 WHERE u."id" = s."user_id" AND u."user_type" = 'agent'
   AND s."agent_user_id" IS NULL;

UPDATE "skills" AS s
   SET "user_id" = m."person_id"
  FROM (
    SELECT s2."id", "_0445_person_of_agent_row"(s2."user_id", 'skill', s2."id"::text) AS "person_id"
      FROM "skills" AS s2
      JOIN "users" AS u ON u."id" = s2."user_id" AND u."user_type" = 'agent'
  ) AS m
 WHERE s."id" = m."id" AND m."person_id" IS NOT NULL;

-- ── artifacts (actor = actor_id + origin_kind) ───────────────────────────
UPDATE "artifacts" AS a
   SET "actor_id" = a."user_id", "origin_kind" = 'agent'
  FROM "users" AS u
 WHERE u."id" = a."user_id" AND u."user_type" = 'agent'
   AND a."actor_id" IS NULL;

UPDATE "artifacts" AS a
   SET "user_id" = m."person_id"
  FROM (
    SELECT a2."id", "_0445_person_of_agent_row"(a2."user_id", 'artifact', a2."id"::text) AS "person_id"
      FROM "artifacts" AS a2
      JOIN "users" AS u ON u."id" = a2."user_id" AND u."user_type" = 'agent'
  ) AS m
 WHERE a."id" = m."id" AND m."person_id" IS NOT NULL;

-- ── workspaces (everything below reads the agent owner, so it runs first) ─
UPDATE "secrets" AS s
   SET "user_id" = m."person_id"
  FROM (
    SELECT w."owner_id" AS "agent_id",
           "_0445_person_of_agent_row"(w."owner_id", 'workspace', w."id"::text) AS "person_id"
      FROM "workspaces" AS w
      JOIN "users" AS u ON u."id" = w."owner_id" AND u."user_type" = 'agent'
     WHERE w."id" = (SELECT w0."id" FROM "workspaces" AS w0 ORDER BY w0."created_at" ASC LIMIT 1)
  ) AS m
 WHERE s."user_id" = m."agent_id"
   AND m."person_id" IS NOT NULL
   AND s."service_id" IN ('nango-connector', 'stalwart-connector')
   AND NOT EXISTS (
     SELECT 1 FROM "secrets" AS p
      WHERE p."user_id" = m."person_id"
        AND p."service_id" = s."service_id"
        AND p."deleted_at" IS NULL
   );

UPDATE "messaging_accounts" AS ma
   SET "workspace_id" = (
     SELECT w."id"::text
       FROM "workspaces" AS w
      WHERE w."owner_id" = ma."user_id"
      ORDER BY w."created_at" ASC
      LIMIT 1
   )
  FROM "users" AS u
 WHERE u."id" = ma."user_id" AND u."user_type" = 'agent'
   AND ma."workspace_id" IS NULL
   AND EXISTS (
     SELECT 1 FROM "workspaces" AS w
      WHERE w."owner_id" = ma."user_id"
        AND "_0445_person_of_agent_row"(w."owner_id", 'workspace', w."id"::text) IS NOT NULL
   );

UPDATE "workspace_members" AS wm
   SET "role" = 'admin'
  FROM "workspaces" AS w
  JOIN "users" AS u ON u."id" = w."owner_id" AND u."user_type" = 'agent'
 WHERE wm."workspace_id" = w."id" AND wm."user_id" = w."owner_id"
   AND wm."role" = 'owner'
   AND "_0445_person_of_agent_row"(w."owner_id", 'workspace', w."id"::text) IS NOT NULL;

INSERT INTO "workspace_members" ("workspace_id", "user_id", "role")
SELECT w."id", w."owner_id", 'admin'
  FROM "workspaces" AS w
  JOIN "users" AS u ON u."id" = w."owner_id" AND u."user_type" = 'agent'
 WHERE "_0445_person_of_agent_row"(w."owner_id", 'workspace', w."id"::text) IS NOT NULL
ON CONFLICT ("workspace_id", "user_id") DO NOTHING;

INSERT INTO "workspace_members" ("workspace_id", "user_id", "role")
SELECT m."id", m."person_id", 'owner'
  FROM (
    SELECT w."id", "_0445_person_of_agent_row"(w."owner_id", 'workspace', w."id"::text) AS "person_id"
      FROM "workspaces" AS w
      JOIN "users" AS u ON u."id" = w."owner_id" AND u."user_type" = 'agent'
  ) AS m
 WHERE m."person_id" IS NOT NULL
ON CONFLICT ("workspace_id", "user_id") DO UPDATE SET "role" = 'owner';

UPDATE "workspaces" AS w
   SET "owner_id" = m."person_id"
  FROM (
    SELECT w2."id", "_0445_person_of_agent_row"(w2."owner_id", 'workspace', w2."id"::text) AS "person_id"
      FROM "workspaces" AS w2
      JOIN "users" AS u ON u."id" = w2."owner_id" AND u."user_type" = 'agent'
  ) AS m
 WHERE w."id" = m."id" AND m."person_id" IS NOT NULL;

DROP FUNCTION "_0445_person_of_agent_row"(text, text, text);
