-- 0406 — A template's practices, attached to the agents already linked to it
-- (lane D, D4; founder decisions D8-D10).
--
-- From now on, linking an agent to its template (`linkAgentToTemplate`: the
-- connect door, the self-healing pass, the person's answer) writes the
-- template's `practices.skills` to the agent in the same transaction, as its
-- `template` preset: an `agent_configs` row (0390), labelled "From the <name>
-- template". This gives the same row, once, to every agent linked before
-- (0404's link written by an earlier build). It is a migration, not a step of
-- the self-healing pass, because a pass would bring back, at every run, a
-- preset a person deleted.
--
-- Written only where the agent has no `template` preset. Never for a
-- computer (agent_type `machine` takes no preset). No column changes.
--
-- Re-runnable: NOT EXISTS + ON CONFLICT DO NOTHING.

INSERT INTO "agent_configs"
  ("user_id", "workspace_id", "agent_type", "preset_key", "preset_label", "skill_slugs")
SELECT
  u."id",
  NULL,
  u."agent_type",
  'template',
  'From the ' || t."name" || ' template',
  CASE
    WHEN jsonb_typeof(t."practices" -> 'skills') = 'array'
      THEN t."practices" -> 'skills'
    ELSE '[]'::jsonb
  END
FROM "users" u
JOIN "agent_templates" t ON t."slug" = u."agent_template_slug"
WHERE u."user_type" = 'agent'
  AND u."agent_type" IS NOT NULL
  AND u."agent_type" <> 'machine'
  AND NOT EXISTS (
    SELECT 1 FROM "agent_configs" c
    WHERE c."user_id" = u."id" AND c."preset_key" = 'template'
  )
ON CONFLICT DO NOTHING;
