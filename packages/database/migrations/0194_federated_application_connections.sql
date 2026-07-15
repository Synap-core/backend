-- Pod-owned browser application federation.
--
-- An issuer is a cryptographic authority. An application connection is a
-- separately approved issuer + client pairing with exact redirect metadata.
-- Neither table stores Control Plane identities or turns an origin into
-- data-plane authority; normal Pod memberships remain authoritative.

ALTER TABLE "trusted_issuers"
  ADD COLUMN IF NOT EXISTS "application_admission_mode" text NOT NULL DEFAULT 'issuer_only';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'trusted_issuers_application_admission_mode_check'
  ) THEN
    ALTER TABLE "trusted_issuers"
      ADD CONSTRAINT "trusted_issuers_application_admission_mode_check"
      CHECK ("application_admission_mode" IN ('issuer_only', 'application_bound'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "federated_application_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "issuer_id" uuid NOT NULL REFERENCES "trusted_issuers"("id") ON DELETE RESTRICT,
  "client_id" text NOT NULL,
  "display_name" text NOT NULL,
  "publisher_url" text,
  "allowed_origins" text[] NOT NULL DEFAULT '{}'::text[],
  "allowed_callback_urls" text[] NOT NULL DEFAULT '{}'::text[],
  "allowed_scopes" text[] NOT NULL DEFAULT '{}'::text[],
  "status" text NOT NULL DEFAULT 'pending',
  "reviewed_by" text REFERENCES "users"("id") ON DELETE SET NULL,
  "reviewed_at" timestamptz,
  "rejection_reason" text,
  "initial_request_data" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "federated_application_connections_status_check"
    CHECK ("status" IN ('pending', 'approved', 'rejected', 'revoked')),
  CONSTRAINT "federated_application_connections_exact_origins_check"
    CHECK (cardinality("allowed_origins") > 0),
  CONSTRAINT "federated_application_connections_exact_callbacks_check"
    CHECK (cardinality("allowed_callback_urls") > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "federated_application_connections_issuer_client_unique"
  ON "federated_application_connections" ("issuer_id", "client_id");
CREATE INDEX IF NOT EXISTS "federated_application_connections_issuer_status_idx"
  ON "federated_application_connections" ("issuer_id", "status");

CREATE TABLE IF NOT EXISTS "federated_application_connection_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "issuer_url" text NOT NULL,
  "client_id" text NOT NULL,
  "display_name" text NOT NULL,
  "publisher_url" text,
  "requested_origin" text NOT NULL,
  "requested_callback_url" text NOT NULL,
  "requested_scopes" text[] NOT NULL DEFAULT '{}'::text[],
  "continuation_hash" text NOT NULL UNIQUE,
  "callback_code_hash" text UNIQUE,
  "requested_by_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "approved_connection_id" uuid REFERENCES "federated_application_connections"("id") ON DELETE SET NULL,
  "reviewed_by" text REFERENCES "users"("id") ON DELETE SET NULL,
  "reviewed_at" timestamptz,
  "decision_reason" text,
  "callback_issued_at" timestamptz,
  "callback_consumed_at" timestamptz,
  "expires_at" timestamptz NOT NULL,
  "request_metadata" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "federated_application_connection_requests_status_check"
    CHECK ("status" IN ('pending', 'approved', 'rejected', 'expired')),
  CONSTRAINT "federated_application_connection_requests_nonempty_scopes_check"
    CHECK (cardinality("requested_scopes") > 0)
);

CREATE INDEX IF NOT EXISTS "federated_application_connection_requests_status_expiry_idx"
  ON "federated_application_connection_requests" ("status", "expires_at");
CREATE INDEX IF NOT EXISTS "federated_application_connection_requests_issuer_client_idx"
  ON "federated_application_connection_requests" ("issuer_url", "client_id");

-- These are server-only federation ledgers. Endpoint authentication and
-- owner review are the access boundary; do not add client-direct RLS policies.
