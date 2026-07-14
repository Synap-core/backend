-- Replace the historic Control-Plane-specific identity bridge with generic
-- trusted-issuer federation state. A Pod starts with no issuer relationship;
-- legacy data is preserved only as a non-authorizing migration record when
-- its original issuer cannot be determined safely.

CREATE TABLE IF NOT EXISTS "federated_identity_links" (
  "issuer_id" uuid NOT NULL REFERENCES "trusted_issuers"("id") ON DELETE RESTRICT,
  "issuer_subject" text NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "linked_by_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "linked_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("issuer_id", "issuer_subject")
);
CREATE UNIQUE INDEX IF NOT EXISTS "federated_identity_links_issuer_user_unique"
  ON "federated_identity_links" ("issuer_id", "user_id");
CREATE INDEX IF NOT EXISTS "federated_identity_links_user_idx"
  ON "federated_identity_links" ("user_id");

CREATE TABLE IF NOT EXISTS "federated_access_receipts" (
  "issuer_id" uuid NOT NULL REFERENCES "trusted_issuers"("id") ON DELETE RESTRICT,
  "command_id" text NOT NULL,
  "issuer_subject" text NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "scope_kind" text NOT NULL,
  "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE RESTRICT,
  "project_id" uuid REFERENCES "projects"("id") ON DELETE RESTRICT,
  "role" text NOT NULL,
  "applied_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("issuer_id", "command_id"),
  CONSTRAINT "federated_access_receipts_exact_scope_check" CHECK (
    ("scope_kind" = 'workspace' AND "workspace_id" IS NOT NULL AND "project_id" IS NULL)
    OR
    ("scope_kind" = 'project' AND "workspace_id" IS NULL AND "project_id" IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS "federated_access_receipts_user_scope_idx"
  ON "federated_access_receipts" ("user_id", "scope_kind");

CREATE TABLE IF NOT EXISTS "issuer_identity_link_receipts" (
  "receipt_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "issuer_id" uuid NOT NULL REFERENCES "trusted_issuers"("id") ON DELETE RESTRICT,
  "issuer_subject" text NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "intent_id" text NOT NULL,
  "nonce_hash" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "consumed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "issuer_identity_link_receipts_issuer_intent_nonce_unique"
  ON "issuer_identity_link_receipts" ("issuer_id", "intent_id", "nonce_hash");
CREATE INDEX IF NOT EXISTS "issuer_identity_link_receipts_expiry_idx"
  ON "issuer_identity_link_receipts" ("expires_at");

-- Keep a deliberately narrow compatibility bridge for issuers that had already
-- been approved to activate memberships. The generic capability supersedes
-- the old name; no unrelated issuer gains membership authority.
UPDATE "trusted_issuers"
SET
  "allowed_scopes" = array_append("allowed_scopes", 'membership:grant'),
  "updated_at" = now()
WHERE
  "status" = 'approved'
  AND 'membership:activate' = ANY("allowed_scopes")
  AND NOT ('membership:grant' = ANY("allowed_scopes"));

-- Backfill only if a legacy Pod has exactly one approved built-in issuer. That
-- is deterministic; every other legacy subject remains unlinked and must be
-- proved again with a local Pod session. Never infer an issuer from a bare sub.
DO $$
BEGIN
  IF to_regclass('public.users') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'users'
         AND column_name = 'control_plane_user_id'
     ) THEN
    WITH candidates AS (
      SELECT id
      FROM trusted_issuers
      WHERE is_built_in = true AND status = 'approved'
      LIMIT 2
    ), one_candidate AS (
      SELECT id FROM candidates
      WHERE (SELECT count(*) FROM candidates) = 1
    )
    INSERT INTO federated_identity_links (
      issuer_id, issuer_subject, user_id, linked_at, updated_at
    )
    SELECT one_candidate.id, users.control_plane_user_id, users.id, now(), now()
    FROM users
    CROSS JOIN one_candidate
    WHERE users.control_plane_user_id IS NOT NULL
    ON CONFLICT DO NOTHING;
  END IF;
END $$;

-- Preserve historic activation receipts. If this Pod has exactly one approved
-- built-in issuer, that issuer is the only deterministic historical source and
-- retains idempotency for its old commands. Otherwise use a reserved rejected
-- issuer: the rows remain auditable but cannot authorize anything.
DO $$
DECLARE
  legacy_issuer_id uuid;
BEGIN
  IF to_regclass('public.control_plane_member_activations') IS NOT NULL THEN
    -- An empty historical table is common on self-hosted Pods that never used
    -- the managed membership bridge. Drop it without leaving a synthetic
    -- issuer row behind; retain the rejected migration issuer only when there
    -- are receipts that genuinely need an auditable non-authorizing source.
    IF EXISTS (SELECT 1 FROM control_plane_member_activations) THEN
      INSERT INTO trusted_issuers (
        issuer_url, display_name, description, status, allowed_scopes, is_built_in
      )
      VALUES (
        'https://legacy-federation.invalid',
        'Legacy federation migration',
        'Non-authorizing historical issuer created during federation migration',
        'rejected',
        ARRAY[]::text[],
        false
      )
      ON CONFLICT (issuer_url) DO NOTHING;

      SELECT id INTO legacy_issuer_id
      FROM trusted_issuers
      WHERE issuer_url = 'https://legacy-federation.invalid';

      WITH candidates AS (
        SELECT id
        FROM trusted_issuers
        WHERE is_built_in = true AND status = 'approved'
        LIMIT 2
      ), one_candidate AS (
        SELECT id FROM candidates
        WHERE (SELECT count(*) FROM candidates) = 1
      ), receipt_issuer AS (
        SELECT COALESCE((SELECT id FROM one_candidate), legacy_issuer_id) AS id
      )
      INSERT INTO federated_access_receipts (
        issuer_id, command_id, issuer_subject, user_id,
        scope_kind, workspace_id, project_id, role, applied_at
      )
      SELECT
        receipt_issuer.id,
        activation_id,
        control_plane_user_id,
        user_id,
        COALESCE(scope_kind, 'workspace'),
        workspace_id,
        project_id,
        role,
        activated_at
      FROM control_plane_member_activations
      CROSS JOIN receipt_issuer
      ON CONFLICT DO NOTHING;
    END IF;

    DROP TABLE control_plane_member_activations;
  END IF;
END $$;

DROP INDEX IF EXISTS "users_control_plane_user_id_unique";
ALTER TABLE "users" DROP COLUMN IF EXISTS "control_plane_user_id";
