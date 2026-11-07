-- 0407 — An agent template's starting MCP tool surface (finding d812debd).
--
-- A template may name the tool surface its agents' FIRST key lists, when the
-- connect (`/setup/agent`) asks for none: `tool_profile` (`entry` | `builder`,
-- as `api_keys.tool_profile`) and `tool_groups` (the groups unlocked on that
-- entry key from the start, as `api_keys.tool_groups`). Hermes: entry + read,
-- so a new Hermes agent is not born on the 14 entry tools alone. NULL / [] =
-- the pod's default (entry, nothing unlocked), as before. Two more fields of
-- the catalog's `definition.agent`, one column each like the rest (0404), so
-- a template update diffs them field by field.
--
-- Re-runnable: IF NOT EXISTS.

ALTER TABLE "agent_templates" ADD COLUMN IF NOT EXISTS "tool_profile" text;
ALTER TABLE "agent_templates" ADD COLUMN IF NOT EXISTS "tool_groups" jsonb NOT NULL DEFAULT '[]';

-- A template installed before 0407 has a keep/drop baseline without these
-- two fields. To the three-way merge a field missing from the baseline is
-- "newly managed", and the live NULL / [] would read as the person's own
-- value against the catalog's: the next update of Hermes would wait on a
-- person instead of applying. The baseline gets what install would have
-- written then (null, []), only where it lacks them.
UPDATE "agent_templates"
SET "metadata" = jsonb_set(
  jsonb_set("metadata", '{marketSource,baseline,toolProfile}', 'null'::jsonb),
  '{marketSource,baseline,toolGroups}', '[]'::jsonb
)
WHERE jsonb_typeof("metadata" #> '{marketSource,baseline}') = 'object'
  AND NOT ("metadata" #> '{marketSource,baseline}' ? 'toolGroups');
