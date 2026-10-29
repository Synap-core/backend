-- 0370 — edit_video intent (founder decision ac1ba2b6, 2026-10-28)
--
-- What a capability DOES is a row, not a TypeScript union (0283).
-- edit_video edits a video the person gives it: cut the person out of a take,
-- remove a background, trim, reframe. The first verb is Robust Video Matting
-- on Replicate. It is a post-seed row (REGISTERED_EXTRAS), like publish_post
-- (0284), delegate_agent_task (0314) and read_webpage (0329).
--
-- EFFECT `act`, like generate_media and run_external_job (0283): the verb sends
-- the person's video to an outside service and spends money there. Anything
-- but `read` reaches outside the pod, so a pod app's run of it is always
-- proposed (`appRunMustPropose`, packages/capability-gate).
--
-- ONE INPUT (0368, decision 5B): `{ video }`, an https URL of the source video.
-- A verb's own options (RVM's output type, a trim range) are not part of the
-- intent: its `skills.input_map` sets them with `{ "const": ... }`.
--
-- The table and its `input_schema` column already exist (0283, 0368, and
-- 0000_baseline_schema.sql on a fresh install); this file only inserts the
-- row, and sets the shape only where none is set, so an edited shape is never
-- overwritten.

INSERT INTO "capability_intents" ("slug", "effect", "statement", "synonyms")
VALUES
  ('edit_video', 'act', 'Edit a video the person gives: cut out a person, remove a background, trim or reframe it.',
   ARRAY['edit video', 'cut out person', 'remove background', 'video matting', 'green screen', 'trim video'])
ON CONFLICT ("slug") DO NOTHING;

UPDATE "capability_intents"
SET "input_schema" = '{
  "type": "object",
  "properties": {
    "video": {
      "type": "string",
      "format": "uri",
      "pattern": "^https://",
      "maxLength": 2048,
      "description": "An https URL of the video to edit."
    }
  },
  "required": ["video"],
  "additionalProperties": false
}'::jsonb
WHERE "slug" = 'edit_video' AND "input_schema" IS NULL;
