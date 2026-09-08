-- 0251 — split a playbook run session's TITLE from its agent PROMPT (backfill).
--
-- `focus_sessions.goal` held the rendered `goalTemplate`, and the executor
-- handed that same string to the agent as its prompt. Every consumer that reads
-- `goal` as a title — the runs feed, the unblock notification, diagnose's
-- displayName, the run channel's name — therefore rendered a paragraph
-- ("You are the CRM hygiene maintenance agent, running unattended…").
-- `instantiateSession` now writes the title to `goal` and the rendered template
-- to `metadata.prompt`; this catches up the rows written before that.
--
-- WHY BACKFILL AT ALL. Measured on the founder's live pod (2026-09-08, the 50
-- most recent `kind: run` sessions): 2 are playbook-origin and BOTH carry the
-- paragraph; the other 48 are automation-origin and were always named correctly
-- (`automation-executor.ts` passes `automation.name`). Two rows is small, but
-- one of them is still `active` and a closed run stays in the run history
-- forever — so without this the paragraph is permanent in the record, not
-- transient. The population is bounded and the rewrite is derivable in SQL, so
-- it is done once here rather than lived with.
--
-- LOSSLESS. The paragraph is MOVED, never dropped: it lands on
-- `metadata.prompt`, which is exactly where `runPromptFor()` reads it. A row
-- this migration touches therefore dispatches the identical prompt it would
-- have dispatched before. (`runPromptFor` also falls back to `goal`, so a row
-- this migration MISSES is equally safe — the backfill is an improvement to the
-- title, never a correctness dependency.)
--
-- IDEMPOTENT. Guarded on `metadata ? 'prompt'` being absent, so a re-run is a
-- no-op; a session whose prompt was already stamped is left alone even if a
-- human has since renamed its goal.
--
-- SCOPE. Only `origin = 'playbook'` rows with a resolvable `playbook_id`. An
-- automation-origin session already has a name. A playbook row whose playbook
-- was deleted keeps its paragraph: there is no name to build a title from, and
-- inventing one would be worse than the paragraph.

UPDATE "focus_sessions" AS fs
SET
  "metadata" = COALESCE(fs."metadata", '{}'::jsonb)
    || jsonb_build_object('prompt', fs."goal"),
  "goal" = LEFT(
    pb."name" || COALESCE(
      ' for ' || (
        SELECT e."title" FROM "entities" AS e WHERE e."id" = fs."subject_entity_id"
      ),
      ''
    ),
    300
  )
FROM "playbooks" AS pb
WHERE fs."playbook_id" = pb."id"
  AND fs."origin" = 'playbook'
  AND NOT (COALESCE(fs."metadata", '{}'::jsonb) ? 'prompt')
  AND COALESCE(NULLIF(TRIM(pb."name"), ''), '') <> ''
  -- ONLY rows whose goal IS, byte for byte, the playbook's own goal_template.
  --
  -- This clause used to be a comment claiming a protection the SQL did not
  -- implement: it excluded only rows already equal to the NEW title, so a
  -- playbook-origin session a human had renamed was rewritten and their name
  -- was moved into `metadata.prompt`, where `runPromptFor()` would then dispatch
  -- it to the agent as its instruction. The comment read as a guard; there was
  -- none.
  --
  -- WHAT THIS CAN AND CANNOT MATCH, stated honestly. The string the lifecycle
  -- wrote is `resolveGoal(goalTemplate, params)` — six reference syntaxes
  -- (`@{arg:…}`, `@{context:…}`, `@{entity:…}`, `{argument name="…"}`,
  -- `{selection}`, bare `{NAME}`) plus a miss policy, none of it faithfully
  -- reproducible in SQL. So this matches the case that IS reproducible: a
  -- template that rendered to itself, i.e. a playbook with no substituted
  -- params. A parameterised run therefore keeps its paragraph — deliberate
  -- UNDER-convergence, and safe: `runPromptFor` falls back to `goal`, so such a
  -- row dispatches exactly as it does today and nothing claims it was fixed.
  -- Clobbering a human's title to catch it would be the worse trade.
  --
  -- MEASURED on the founder's live pod (2026-09-08): both playbook-origin run
  -- sessions belong to the "CRM Hygiene" playbook, which declares `params: []`,
  -- and their `goal` is its `goal_template` verbatim. Both rows are still
  -- caught by this narrower clause.
  AND fs."goal" = pb."goal_template"
  AND fs."goal" IS DISTINCT FROM LEFT(
    pb."name" || COALESCE(
      ' for ' || (
        SELECT e."title" FROM "entities" AS e WHERE e."id" = fs."subject_entity_id"
      ),
      ''
    ),
    300
  );
