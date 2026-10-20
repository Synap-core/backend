-- 0328: the Library (capture-vs-library decision, wave L2).
--
-- 1. `library_groups` — the person's persistent groups over their Library.
--    A group outlives any one import run: note, outputs, the collection
--    entity Build minted (rebuilds update it, never twin it), built state.
--    Item membership stays on the item (documents.metadata.importCuration
--    .groupIds). Owner-floored (user_id). Not an entity before Build on
--    purpose: entity writes fire automations, embeddings and indexing.
--
-- 2. The Library read index on documents: every staged item
--    (metadata ? 'importItem'), newest first, keyset-paged on (created_at, id).

CREATE TABLE IF NOT EXISTS "library_groups" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"             text NOT NULL,
  "workspace_id"        uuid,
  "key"                 text NOT NULL,
  "name"                text NOT NULL,
  "note"                text,
  "origin"              text NOT NULL DEFAULT 'user',
  "outputs"             jsonb NOT NULL DEFAULT '[]'::jsonb,
  "container_entity_id" uuid,
  "building_at"         timestamptz,
  "built_at"            timestamptz,
  "build_proposal_ids"  jsonb NOT NULL DEFAULT '[]'::jsonb,
  "archived_at"         timestamptz,
  "created_at"          timestamptz NOT NULL DEFAULT now(),
  "updated_at"          timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'library_groups_origin_check') THEN
    ALTER TABLE "library_groups" ADD CONSTRAINT "library_groups_origin_check"
      CHECK ("origin" IN ('ai', 'user', 'rule'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "library_groups_user_key_unique"
  ON "library_groups" ("user_id", "key");
CREATE INDEX IF NOT EXISTS "library_groups_user_live_idx"
  ON "library_groups" ("user_id", "updated_at")
  WHERE "archived_at" IS NULL;

CREATE INDEX IF NOT EXISTS "documents_library_items_idx"
  ON "documents" ("user_id", "created_at" DESC, "id")
  WHERE "deleted_at" IS NULL AND "metadata" ? 'importItem';
