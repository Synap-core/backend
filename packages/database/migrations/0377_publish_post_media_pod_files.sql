-- 0377 — publish_post.media is a list of POD FILES (plan e7c3c98e phase 3)
--
-- The publish_post input (0368) already has `media`: up to 10 pod file ids, in
-- order. This marks the field with the annotation `"x-synap-pod-file": true`,
-- so the pod knows these are the person's files and not opaque strings:
--   - the install check (`file-input-map.ts`) refuses a verb's inputMap that
--     copies `$.media` into a parameter not declared `file[]:url` /
--     `file[]:bytes`: only a declared file parameter gets each file
--     read-checked, named in the review and read again before it is sent;
--   - the actions door hands the annotation to apps with the action's input,
--     so an app knows which field takes pod file ids.
-- JSON Schema ignores an `x-` keyword: validating an input is unchanged.
--
-- Only a `media` field that exists and is not yet marked is touched, so an
-- edited shape keeps its edits. Idempotent.

UPDATE "capability_intents"
SET "input_schema" = jsonb_set(
  "input_schema",
  '{properties,media,x-synap-pod-file}',
  'true'::jsonb
)
WHERE "slug" = 'publish_post'
  AND "input_schema" #> '{properties,media}' IS NOT NULL
  AND NOT ("input_schema" #> '{properties,media}' ? 'x-synap-pod-file');
