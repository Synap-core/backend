-- Trusted Issuers: pod-level registry of approved external services
-- Replaces CONTROL_PLANE_URL env var with a proper allowlist + approval workflow

CREATE TABLE IF NOT EXISTS "trusted_issuers" (
  "id"                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "issuer_url"           text NOT NULL,
  "display_name"         text NOT NULL,
  "description"          text,
  "allowed_scopes"       text[] NOT NULL DEFAULT '{}',
  "status"               text NOT NULL DEFAULT 'pending',
  "reviewed_by"          text,
  "reviewed_at"          timestamp with time zone,
  "rejection_reason"     text,
  "is_built_in"          boolean NOT NULL DEFAULT false,
  "initial_request_data" jsonb,
  "created_at"           timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"           timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "trusted_issuers_issuer_url_unique" UNIQUE ("issuer_url"),
  CONSTRAINT "trusted_issuers_status_check" CHECK (
    status IN ('pending', 'approved', 'rejected', 'revoked')
  )
);

CREATE INDEX IF NOT EXISTS "trusted_issuers_status_idx" ON "trusted_issuers" ("status");
CREATE INDEX IF NOT EXISTS "trusted_issuers_is_built_in_idx" ON "trusted_issuers" ("is_built_in");
