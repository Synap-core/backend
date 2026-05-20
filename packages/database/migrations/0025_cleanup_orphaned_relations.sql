-- Remove relations whose source or target entity no longer exists.
-- These can accumulate on pods where the FK constraint was never enforced
-- (ADD COLUMN IF NOT EXISTS is a no-op when the column already existed).
DELETE FROM "relations"
WHERE "source_entity_id" NOT IN (SELECT "id" FROM "entities")
   OR "target_entity_id" NOT IN (SELECT "id" FROM "entities");

-- Ensure the FK constraints exist (idempotent via DO block).
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'relations'
      AND constraint_name = 'relations_source_entity_id_fkey'
  ) THEN
    ALTER TABLE "relations"
      ADD CONSTRAINT "relations_source_entity_id_fkey"
      FOREIGN KEY ("source_entity_id") REFERENCES "entities"("id") ON DELETE CASCADE;
  END IF;
END; $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'relations'
      AND constraint_name = 'relations_target_entity_id_fkey'
  ) THEN
    ALTER TABLE "relations"
      ADD CONSTRAINT "relations_target_entity_id_fkey"
      FOREIGN KEY ("target_entity_id") REFERENCES "entities"("id") ON DELETE CASCADE;
  END IF;
END; $$;
