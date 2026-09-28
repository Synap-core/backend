-- 0283 — capability_intents
--
-- What a capability DOES is a row, not a TypeScript union. ABSTRACT_VERBS
-- (schema/tools.ts) is the seed inserted below. A later kind of work is
-- another row with the same effect axis (read | write | act).
--
-- No foreign keys. Fresh installs also get the table from
-- 0000_baseline_schema.sql. This file is for pods that already booted.

CREATE TABLE IF NOT EXISTS "capability_intents" (
  "slug"       text        PRIMARY KEY,
  "effect"     text        NOT NULL,
  "statement"  text        NOT NULL,
  "synonyms"   text[]      NOT NULL DEFAULT '{}',
  "created_at" timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'capability_intents_effect_check'
  ) THEN
    ALTER TABLE "capability_intents"
      ADD CONSTRAINT "capability_intents_effect_check"
      CHECK ("effect" IN ('read', 'write', 'act'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'capability_intents_slug_check'
  ) THEN
    ALTER TABLE "capability_intents"
      ADD CONSTRAINT "capability_intents_slug_check"
      CHECK ("slug" ~ '^[a-z][a-z0-9_]{0,63}$');
  END IF;
END $$;

INSERT INTO "capability_intents" ("slug", "effect", "statement")
VALUES
  ('search_external', 'read', 'Query an outside corpus'),
  ('find_people', 'read', 'Locate people or companies'),
  ('enrich_entity', 'read', 'Add known facts to a person or company we already have'),
  ('fetch_record', 'read', 'Get one identified external record'),
  ('list_records', 'read', 'Enumerate records of a kind'),
  ('send_message', 'write', 'Deliver a message to a person outside the pod'),
  ('request_connection', 'write', 'Ask a person to connect'),
  ('schedule_event', 'write', 'Create or modify a calendar commitment'),
  ('manage_file', 'write', 'Create, copy, or move a file in external storage'),
  ('generate_media', 'act', 'Produce an image, video, or audio artifact'),
  ('capture_into_pod', 'write', 'Bring external data into the pod as proposed entities'),
  ('run_external_job', 'act', 'Invoke an external compute job'),
  ('connect_account', 'act', 'Establish or authorize a provider connection')
ON CONFLICT ("slug") DO NOTHING;
