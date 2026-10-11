-- 0318: every key holds a grant — the visible backfill before deny by default
-- (P5, founder decision 2026-10-11).
--
-- Until now a key with NO `grants` row was read as "everything its scopes
-- allow" (legacy). From this release a key with no grant row may touch
-- NOTHING (`GrantRepository.resolveForKey`). So that nothing breaks silently,
-- every key that never had a grant row gets ONE explicit full-access grant —
-- `{"*"}` labelled "Full access (before limits)" — which every key list shows
-- (in red) and its owner can narrow or revoke.
--
--   permissions   {"*"}; workspace/project/entity ids NULL (no narrowing)
--   expires_at    the key's own expiry (NULL = never)
--   principal     the key's holder (api_keys.user_id)
--   on_behalf_of  the human whose floor bounds it: linked_user_id, else user_id
--   created_by    the key's holder
--   revoked_at/by the KEY's revocation, so a revoked key's grant is not live
--                 on /my-connections (`listForUser`)
--   client_id / role_id NULL
--
-- Only keys with NO grant rows at all are touched: a key whose grants were
-- all revoked or expired stays deny-all (backfilling it would turn a
-- revocation into a widening). Idempotent: a re-run finds every key holding
-- a row and inserts nothing. Runs before the new code serves (the migrate
-- service completes before the backend starts).

INSERT INTO "grants" (
  "api_key_id",
  "principal_user_id",
  "on_behalf_of",
  "permissions",
  "workspace_ids",
  "project_ids",
  "entity_ids",
  "expires_at",
  "label",
  "client_id",
  "role_id",
  "created_by",
  "revoked_at",
  "revoked_by"
)
SELECT
  k."id",
  k."user_id",
  COALESCE(k."linked_user_id", k."user_id"),
  ARRAY['*']::text[],
  NULL,
  NULL,
  NULL,
  k."expires_at",
  'Full access (before limits)',
  NULL,
  NULL,
  k."user_id",
  k."revoked_at",
  CASE WHEN k."revoked_at" IS NOT NULL THEN k."revoked_by" END
FROM "api_keys" k
WHERE NOT EXISTS (
  SELECT 1 FROM "grants" g WHERE g."api_key_id" = k."id"
);
