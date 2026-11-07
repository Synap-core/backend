-- 0409 — one input for enrich_entity (CRM "Find their LinkedIn", founder
-- 2026-11-07: "for actions that are just an API with a parameter ... it
-- should just launch the underlying tool, no need for ai")
--
-- A pod app asks the person's tools to look up facts about ONE person or
-- company it already has (their LinkedIn profile), by what it knows of them:
-- their full name and, when known, where they work. Each verb serving the
-- intent maps those onto its own parameters (`skills.input_map`, e.g.
-- linkedin_find_profile: `fullName` <- `$.name`, `company` <- `$.company`).
-- A verb that needs the company makes it required on its own action
-- (`actionInputSchema`), so the shape keeps it optional.
--
-- Default chosen (CRM wave lead, 2026-11-07; the founder may override it):
-- the app sends the name and company it shows, not the entity id. The
-- mapping language has no path into a subject's fields (only `$.`,
-- `$account.` and `$to.<address>`), and enrich_entity is a READ: a wrong name
-- finds nothing or the wrong candidates, which the person sees and picks
-- from; nothing is written by the lookup itself.
--
-- enrich_entity stays `read` (0283): its actions keep their tool's own
-- governance and the run returns the lookup to the app inline.
--
-- Seeded only where none is set, so an edited shape is never overwritten
-- (same rule as 0368 and 0369). The column itself comes from 0368 and the
-- baseline.

UPDATE "capability_intents"
SET "input_schema" = '{
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200,
      "description": "The full name of the person (or company) to look up, as the pod holds it."
    },
    "company": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200,
      "description": "Where they work, when known: narrows the lookup to them."
    }
  },
  "required": ["name"],
  "additionalProperties": false
}'::jsonb
WHERE false;
