-- 0284 — publish_post intent
--
-- What a capability DOES is a row, not a TypeScript union (0283).
-- publish_post is a write. ABSTRACT_VERBS stays the seed only — this slug
-- is not a member of that array. The table already exists (0283, and
-- 0000_baseline_schema.sql on a fresh install); this file only inserts
-- the row.

INSERT INTO "capability_intents" ("slug", "effect", "statement")
VALUES
  ('publish_post', 'write', 'Broadcast a composed post to an audience on a connected network.')
ON CONFLICT ("slug") DO NOTHING;
