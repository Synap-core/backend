-- 0426 — needs: what a space needs filled, once, by one provider
-- (founder decisions D2 and D3, 16 Nov 2026; plan 0adf8352 W3).
--
-- A NEED is a seat a provider fills ("code host", "deploy target",
-- "payments"): a curated, extendable list of named groups of capability
-- intents. An intent alone cannot tell payments from analytics from a code
-- host (Stripe, PostHog and github-read all provide list_records and
-- fetch_record), so a need is coarser, and a capability pack DECLARES which
-- needs it fills (`fills`). A need is never renamed, only aliased.
--
-- WHY A TABLE AND NOT A GROUPING ON `capability_intents`: a need has its own
-- identity (the seat a provider binds to), its own words and its own aliases,
-- and groups SEVERAL intents; one intent belongs to several needs. Folding
-- both into one table would give every intent row a nullable group and every
-- need row a meaningless `effect`. The intents a need groups are slugs of
-- `capability_intents` (plain text, as everywhere: the vocabulary is open).
-- Mirrored in `@synap-core/types/needs` and the control plane's
-- `src/seeds/need-vocabulary.ts`, each with a parity guard on this file.
--
-- THE SPACE BINDING lives on `installation_bindings` (D3: filled once per
-- space, shared by its members). A row with NO installation is a space's
-- binding: `workspace_id` = the space, `need_key` = the need slug,
-- `provider_capability_id` = the provider (ON DELETE SET NULL: a deleted
-- provider leaves the need empty, never a dangling id), `state` live or
-- revoked. One live binding per (space, need): rebinding revokes the old row
-- and writes a new one in one transaction. An installation's binding keeps
-- its 0409 shape (installation and intent required).
--
-- `intent_defaults` (0409) is DROPPED: the per-person remembered provider was
-- never wired (no writer, no reader outside the access floor), and the space
-- binding replaces it (D3). No pod holds a row: nothing ever wrote one.

CREATE TABLE IF NOT EXISTS "needs" (
  "slug"        text        PRIMARY KEY,
  "label"       text        NOT NULL,
  "description" text        NOT NULL,
  "intents"     text[]      NOT NULL DEFAULT '{}',
  "aliases"     text[]      NOT NULL DEFAULT '{}',
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "needs_slug_check" CHECK ("slug" ~ '^[a-z][a-z0-9-]{0,63}$')
);

INSERT INTO "needs" ("slug", "label", "description", "intents", "aliases")
VALUES
  ('code-host', 'Code host', 'Where the code lives: repositories, branches, pull requests.',
   ARRAY['fetch_record', 'list_records', 'run_external_job'], ARRAY['git-host', 'repository']),
  ('deploy-target', 'Deploy target', 'Where a change is deployed and served.',
   ARRAY['run_external_job', 'fetch_record'], ARRAY['hosting']),
  ('gate', 'Gate', 'What checks a change before it lands: tests, typecheck, CI.',
   ARRAY['run_external_job', 'fetch_record'], ARRAY['ci']),
  ('payments', 'Payments', 'Where money is charged and recorded.',
   ARRAY['list_records', 'fetch_record'], ARRAY[]::text[]),
  ('messaging', 'Messaging', 'Where messages are sent to people outside the pod.',
   ARRAY['send_message', 'request_connection'], ARRAY['chat']),
  ('email', 'Email', 'The mailbox that sends and reads email.',
   ARRAY['send_message', 'list_records', 'fetch_record'], ARRAY['mail']),
  ('calendar', 'Calendar', 'Where meetings and events are scheduled.',
   ARRAY['schedule_event', 'list_records'], ARRAY[]::text[]),
  ('file-store', 'File store', 'Where files are kept outside the pod.',
   ARRAY['manage_file', 'fetch_record', 'list_records'], ARRAY['storage', 'drive']),
  ('media-generation', 'Media generation', 'What makes and edits images, video and audio.',
   ARRAY['generate_media', 'edit_video', 'transcribe_media'], ARRAY['media']),
  ('social-publishing', 'Social publishing', 'Where posts are published to social networks.',
   ARRAY['publish_post'], ARRAY['social']),
  ('linkedin-reach', 'LinkedIn reach', 'What finds people and reaches them on LinkedIn.',
   ARRAY['find_people', 'request_connection', 'send_message', 'enrich_entity'], ARRAY['linkedin']),
  ('analytics', 'Analytics', 'Where usage and traffic are measured.',
   ARRAY['list_records', 'fetch_record'], ARRAY[]::text[])
ON CONFLICT ("slug") DO NOTHING;

-- A space's binding has no installation and no single intent (a need groups
-- several).
ALTER TABLE "installation_bindings" ALTER COLUMN "installation_id" DROP NOT NULL;
ALTER TABLE "installation_bindings" ALTER COLUMN "intent" DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'installation_bindings_scope_check'
  ) THEN
    ALTER TABLE "installation_bindings" ADD CONSTRAINT "installation_bindings_scope_check"
      CHECK (
        ("installation_id" IS NOT NULL AND "intent" IS NOT NULL)
        OR ("installation_id" IS NULL AND "workspace_id" IS NOT NULL)
      );
  END IF;
END $$;

-- One live binding per (space, need).
CREATE UNIQUE INDEX IF NOT EXISTS "uq_installation_bindings_space_need"
  ON "installation_bindings" ("workspace_id", "need_key")
  WHERE "installation_id" IS NULL AND "state" <> 'revoked';

DROP TABLE IF EXISTS "intent_defaults";
