-- 0443 — move the rows an agent owns to the person it works for. Needs 0442.
--
-- For every automation and playbook whose owner (`created_by`) is an agent
-- user (`users.user_type = 'agent'`):
--   1. the agent is copied into `agent_user_id` FIRST (the governance ladder
--      reads it: the row keeps being governed as that agent);
--   2. the owner becomes the first person found:
--        a. the person the approved create proposal was filed for
--           (`proposals.subject_user_id`; the executors land the row under the
--           proposal's `target_id`); an agent subject falls through;
--        b. the one person the agent's keys act for (`api_keys.linked_user_id`,
--           exactly one distinct person), as the write doors resolve it;
--        c. the person who created the agent (`users.created_by_user_id`, the
--           pod admin who installed a pod-wide agent).
--      Only a human users row qualifies at each rung.
-- A row whose agent stands for no person (no proposal subject, no creator)
-- keeps the agent as owner: it is still governed as that agent (step 1). Count
-- them after the migration with:
--   SELECT 'automations' AS t, count(*) FROM automations a JOIN users u ON u.id = a.created_by WHERE u.user_type = 'agent'
--   UNION ALL
--   SELECT 'playbooks', count(*) FROM playbooks p JOIN users u ON u.id = p.created_by WHERE u.user_type = 'agent';
--
-- Idempotent: step 1 fills only an empty actor, step 2 moves only a row still
-- owned by an agent, so a second run changes nothing.
--
-- Left alone on purpose: the run sessions earlier agent-owned automations
-- opened (`focus_sessions.user_id` = the agent). They are history; the
-- session-decision floor keeps reading an agent's session as its person's
-- (`sessionDecidableWhere`), and every new run opens under the person.

UPDATE "automations" AS a
   SET "agent_user_id" = a."created_by"
  FROM "users" AS u
 WHERE u."id" = a."created_by"
   AND u."user_type" = 'agent'
   AND a."agent_user_id" IS NULL;

UPDATE "playbooks" AS p
   SET "agent_user_id" = p."created_by"
  FROM "users" AS u
 WHERE u."id" = p."created_by"
   AND u."user_type" = 'agent'
   AND p."agent_user_id" IS NULL;

WITH "moved" AS (
  SELECT a."id",
         COALESCE(
           (SELECT s."id"
              FROM "proposals" AS pr
              JOIN "users" AS s ON s."id" = pr."subject_user_id" AND s."user_type" <> 'agent'
             WHERE pr."target_type" = 'automation'
               AND pr."proposal_type" = 'create'
               AND pr."target_id" = a."id"::text
               AND pr."status" = 'approved'
             ORDER BY pr."created_at" DESC
             LIMIT 1),
           (SELECT min(k."linked_user_id")
              FROM "api_keys" AS k
              JOIN "users" AS lp ON lp."id" = k."linked_user_id" AND lp."user_type" <> 'agent'
             WHERE k."user_id" = ag."id"
            HAVING count(DISTINCT k."linked_user_id") = 1),
           (SELECT c."id" FROM "users" AS c
             WHERE c."id" = ag."created_by_user_id" AND c."user_type" <> 'agent')
         ) AS "person_id"
    FROM "automations" AS a
    JOIN "users" AS ag ON ag."id" = a."created_by" AND ag."user_type" = 'agent'
)
UPDATE "automations" AS a
   SET "created_by" = m."person_id"
  FROM "moved" AS m
 WHERE a."id" = m."id"
   AND m."person_id" IS NOT NULL;

WITH "moved" AS (
  SELECT p."id",
         COALESCE(
           (SELECT s."id"
              FROM "proposals" AS pr
              JOIN "users" AS s ON s."id" = pr."subject_user_id" AND s."user_type" <> 'agent'
             WHERE pr."target_type" = 'playbook'
               AND pr."proposal_type" = 'create'
               AND pr."target_id" = p."id"::text
               AND pr."status" = 'approved'
             ORDER BY pr."created_at" DESC
             LIMIT 1),
           (SELECT min(k."linked_user_id")
              FROM "api_keys" AS k
              JOIN "users" AS lp ON lp."id" = k."linked_user_id" AND lp."user_type" <> 'agent'
             WHERE k."user_id" = ag."id"
            HAVING count(DISTINCT k."linked_user_id") = 1),
           (SELECT c."id" FROM "users" AS c
             WHERE c."id" = ag."created_by_user_id" AND c."user_type" <> 'agent')
         ) AS "person_id"
    FROM "playbooks" AS p
    JOIN "users" AS ag ON ag."id" = p."created_by" AND ag."user_type" = 'agent'
)
UPDATE "playbooks" AS p
   SET "created_by" = m."person_id"
  FROM "moved" AS m
 WHERE p."id" = m."id"
   AND m."person_id" IS NOT NULL;
