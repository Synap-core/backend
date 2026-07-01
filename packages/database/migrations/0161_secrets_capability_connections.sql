-- 0161_secrets_capability_connections.sql
--
-- The vault (`secrets`) BECOMES the capability-connection registry.
--
-- A "connection" is a `secrets` row that OPTIONALLY belongs to a capability
-- (`capability_id`) and OPTIONALLY links to a context object (`context_type` +
-- `context_id`: an entity / person / project / workspace). A plain personal-vault
-- entry is the SAME row with `capability_id` NULL. This unifies the personal
-- vault and capability connections into one model — multiple connections per
-- capability, one default, selectable at run time.
--
-- All columns are ADDITIVE + nullable/defaulted → safe, non-breaking.

ALTER TABLE "secrets" ADD COLUMN IF NOT EXISTS "capability_id" uuid;
ALTER TABLE "secrets" ADD COLUMN IF NOT EXISTS "account_hint"  text;
ALTER TABLE "secrets" ADD COLUMN IF NOT EXISTS "context_type"  text;
ALTER TABLE "secrets" ADD COLUMN IF NOT EXISTS "context_id"    text;
ALTER TABLE "secrets" ADD COLUMN IF NOT EXISTS "is_default"    boolean NOT NULL DEFAULT false;

-- One DEFAULT connection per capability (partial-unique; personal-vault rows,
-- where capability_id IS NULL, are exempt so many can coexist).
CREATE UNIQUE INDEX IF NOT EXISTS "idx_secrets_capability_default"
  ON "secrets" ("capability_id")
  WHERE "is_default" AND "capability_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "idx_secrets_capability"
  ON "secrets" ("capability_id")
  WHERE "capability_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "idx_secrets_context"
  ON "secrets" ("context_type", "context_id");

-- ── Retire `provides_credential`: fold each edge onto its target secret. ──
--
-- A `provides_credential` link is  (from = participant|entity principal)
-- --> (to = secret),  scoped to a tool via metadata.toolId. We move the
-- principal onto the secret's context_* and derive the owning capability from
-- the tool's `member_of` edge (tool --member_of--> capability). `to_id`/`from_id`
-- are TEXT (polymorphic ids), so cast to uuid where the target column is uuid.
-- Idempotent + safe on zero rows (a fresh feature: most pods have none).
UPDATE "secrets" s SET
  "context_type"  = l."from_type",
  "context_id"    = l."from_id",
  "capability_id" = COALESCE(s."capability_id", (
    SELECT ml."to_id"::uuid
    FROM "links" ml
    WHERE ml."from_type" = 'tool'
      AND ml."from_id"   = (l."metadata"->>'toolId')
      AND ml."link_type" = 'member_of'
      AND ml."to_type"   = 'capability'
    LIMIT 1
  ))
FROM "links" l
WHERE l."link_type" = 'provides_credential'
  AND l."to_type"   = 'secret'
  AND l."to_id"     = s."id"::text;

-- Drop the now-folded edges. The `provides_credential` link type is retired;
-- credential binding lives on the secret itself (context_type / context_id).
DELETE FROM "links" WHERE "link_type" = 'provides_credential';
