-- 0170_person_identity_defs.sql
--
-- Person identity model (Alias/Identity data model, Move A).
--
-- `person` entities had no searchable identity beyond `title`, so the CRM
-- extractor created duplicate people ("0scr" / "Oscar" / "Oscar Piveteau"
-- became three entities). This seeds two NEW base property defs on the
-- `person` profile — `discord-handle` and `aliases` — plus their
-- `profile_properties` links, so a lookup by handle/name resolves to the
-- existing person pod-wide. (`email` already exists as a base def linked to
-- `person`; only its link is (re)asserted here for safety.)
--
-- DATA seed, not a schema object — nothing to mirror into 0000_baseline_schema
-- or schema-coherence.ts (those cover DDL). The canonical seed for fresh pods
-- lives in ensure-system-profiles.ts; this migration backfills existing pods.
--
-- STRICT migration rules: idempotent via ON CONFLICT DO NOTHING against the
-- partial unique indexes (property_defs_global_slug_uniq for defs, the
-- profile_properties PK for links). Base defs = profile_id NULL + workspace_id
-- NULL, resolved to the `person` profile purely through profile_properties —
-- exactly how `email`/`phone` are wired (see getEffectiveProperties, which
-- ignores a def's own profile_id and reads links only).

-- 1. NEW base property defs (global: profile_id NULL, workspace_id NULL).
INSERT INTO "property_defs" ("slug", "value_type", "constraints", "ui_hints")
VALUES
  (
    'discord-handle',
    'string',
    '{}'::jsonb,
    '{"label":"Discord","inputType":"text","helpText":"username"}'::jsonb
  ),
  (
    'aliases',
    'array',
    '{}'::jsonb,
    '{"label":"Aliases","inputType":"tags","itemValueType":"string","helpText":"Other handles, nicknames, or former names"}'::jsonb
  )
ON CONFLICT ("slug") WHERE "profile_id" IS NULL AND "workspace_id" IS NULL
DO NOTHING;

-- 2. Link the identity defs to the `person` profile (base defs → workspace_id
--    NULL). `email` link is (re)asserted defensively. The person profile is the
--    system-scoped one (workspace_id NULL, user_id NULL).
INSERT INTO "profile_properties" ("profile_id", "property_def_id", "required", "display_order")
SELECT
  p."id",
  d."id",
  false,
  CASE d."slug" WHEN 'email' THEN 1 WHEN 'discord-handle' THEN 16 ELSE 17 END
FROM "profiles" p
CROSS JOIN "property_defs" d
WHERE p."slug" = 'person'
  AND p."workspace_id" IS NULL
  AND p."user_id" IS NULL
  AND d."slug" IN ('email', 'discord-handle', 'aliases')
  AND d."profile_id" IS NULL
  AND d."workspace_id" IS NULL
ON CONFLICT ("profile_id", "property_def_id") DO NOTHING;
