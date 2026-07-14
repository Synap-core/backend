-- Durable, issuer-scoped replay protection for short-lived federation JWTs.
-- The primary key makes a signed assertion single-use across all Pod API
-- processes; expires_at is retained for operational cleanup and auditing.

CREATE TABLE IF NOT EXISTS "federated_assertion_receipts" (
  "issuer_id" uuid NOT NULL REFERENCES "trusted_issuers"("id") ON DELETE RESTRICT,
  "jti" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "consumed_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("issuer_id", "jti")
);

CREATE INDEX IF NOT EXISTS "federated_assertion_receipts_expiry_idx"
  ON "federated_assertion_receipts" ("expires_at");

-- Federation ledgers are server-only protocol state. Like trusted_issuers,
-- they are never exposed through a client-direct database role: endpoint
-- authentication, issuer capabilities, and local membership are the access
-- boundary. Do not add an RLS policy that would silently deny Pod jobs.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'federated_access_receipts_role_check'
  ) THEN
    ALTER TABLE "federated_access_receipts"
      ADD CONSTRAINT "federated_access_receipts_role_check"
      CHECK ("role" IN ('admin', 'editor', 'viewer'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'federated_assertion_receipts_expiry_check'
  ) THEN
    ALTER TABLE "federated_assertion_receipts"
      ADD CONSTRAINT "federated_assertion_receipts_expiry_check"
      CHECK ("expires_at" > "consumed_at");
  END IF;
END $$;
