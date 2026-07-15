-- One Pod-owned lifecycle covers the browser handoff and owner review.  It is
-- generic: no Control Plane, CRM, or external-account data is stored here.

ALTER TABLE "federated_application_connection_requests"
  DROP CONSTRAINT IF EXISTS "federated_application_connection_requests_status_check";

ALTER TABLE "federated_application_connection_requests"
  ADD CONSTRAINT "federated_application_connection_requests_status_check"
  CHECK ("status" IN ('awaiting_local_auth', 'pending', 'approved', 'completing', 'completed', 'rejected', 'expired'));

ALTER TABLE "federated_application_connection_requests"
  ADD COLUMN IF NOT EXISTS "completed_at" timestamptz;

ALTER TABLE "federated_application_connection_requests"
  ADD COLUMN IF NOT EXISTS "completion_started_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "completion_receipt_id" uuid,
  ADD COLUMN IF NOT EXISTS "completion_receipt_expires_at" timestamptz;

-- The public request UUID is correlation only. A distinct browser-held proof
-- is required before native Pod Admin authentication can bind the requester to
-- a local Pod user. Existing pre-lifecycle rows cannot be redeemed through the
-- new ceremony, so they receive an intentionally unusable sentinel value.
ALTER TABLE "federated_application_connection_requests"
  ADD COLUMN IF NOT EXISTS "redemption_hash" text;

-- Bind the generic issuer subject at handoff creation. It is not a provider
-- account record: together with issuer_url it is the generic federated
-- identity that the later signed assertion must prove.
ALTER TABLE "federated_application_connection_requests"
  ADD COLUMN IF NOT EXISTS "issuer_subject" text;

UPDATE "federated_application_connection_requests"
  SET "issuer_subject" = 'legacy-unbound:' || "id"::text
  WHERE "issuer_subject" IS NULL;

ALTER TABLE "federated_application_connection_requests"
  ALTER COLUMN "issuer_subject" SET NOT NULL;

UPDATE "federated_application_connection_requests"
  SET "redemption_hash" = 'legacy-unredeemable:' || "id"::text
  WHERE "redemption_hash" IS NULL;

ALTER TABLE "federated_application_connection_requests"
  ALTER COLUMN "redemption_hash" SET NOT NULL;

-- Callback codes belonged to the previous same-browser-only ceremony. The
-- requester-held continuation plus fresh issuer assertion is now the one
-- completion proof, so a reviewer never transports a secret back to an app.
ALTER TABLE "federated_application_connection_requests"
  DROP COLUMN IF EXISTS "callback_code_hash",
  DROP COLUMN IF EXISTS "callback_issued_at",
  DROP COLUMN IF EXISTS "callback_consumed_at";

-- A replay context remains generic protocol state. It permits the exact same
-- request ceremony to recover if a process fails after durably consuming an
-- assertion JTI but before it returns its Pod receipt; other routes still
-- reject that JTI as a replay.
ALTER TABLE "federated_assertion_receipts"
  ADD COLUMN IF NOT EXISTS "replay_context" text;
