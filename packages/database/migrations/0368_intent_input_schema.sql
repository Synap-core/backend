-- 0368 — one input per intent (intent actions, decision 5B, 2026-10-28)
--
-- A pod app asks the person's tools to do ONE intent ("publish a post") with
-- ONE input shape, whatever tool answers it. The intent declares that shape
-- (`capability_intents.input_schema`, JSON Schema); each verb that serves the
-- intent declares how its own parameters are read from it
-- (`skills.input_map`). The pod validates the input against the intent, maps
-- it, then validates the mapped parameters against the verb as before.
--
-- `skills.input_map` is part of what an approval covers: changing it on an
-- approved skill demotes the skill (RE_APPROVAL_FIELDS), and a verb is offered
-- to apps only while approved. NULL = the verb is not offered for its intent.
--
-- Fresh installs get both columns from 0000_baseline_schema.sql; this file is
-- for pods that already booted. The publish_post shape is seeded only where
-- none is set, so an edited shape is never overwritten.

ALTER TABLE "capability_intents" ADD COLUMN IF NOT EXISTS "input_schema" jsonb;
ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "input_map" jsonb;

UPDATE "capability_intents"
SET "input_schema" = '{
  "type": "object",
  "properties": {
    "text": {
      "type": "string",
      "minLength": 1,
      "maxLength": 3000,
      "description": "The text of the post."
    },
    "media": {
      "type": "array",
      "items": { "type": "string", "format": "uuid" },
      "maxItems": 10,
      "description": "Pod file ids to attach, in order."
    },
    "link": {
      "type": "string",
      "format": "uri",
      "pattern": "^https://",
      "maxLength": 2048,
      "description": "An https link the post shares."
    },
    "when": {
      "type": "string",
      "format": "date-time",
      "description": "When to publish (ISO 8601). Omitted: as soon as it is approved."
    }
  },
  "required": ["text"],
  "additionalProperties": false
}'::jsonb
WHERE "slug" = 'publish_post' AND "input_schema" IS NULL;
