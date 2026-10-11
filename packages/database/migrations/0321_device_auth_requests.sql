-- 0321: the device door (MACHINE-IDENTITY-PLAN W2 §4) — the ONLY way the CLI
-- connects a computer: RFC 8628 device authorization, pod-side.
--
-- One row per request a terminal started (`POST /api/hub/setup/device`).
-- NO PLAINTEXT SECRET IS EVER STORED (the `mcp_connect_codes` rule): the
-- device code (the terminal's poll secret) and the user code are kept as
-- sha256 hashes only, and no key exists until the terminal COLLECTS
-- (`POST /api/hub/setup/device/token` after approval) — the computer's and
-- its agents' keys are minted at that moment and returned once. The request
-- then records only the minted key's id.
--
-- Lifecycle: pending → approved | denied → consumed. 10-minute TTL; five
-- wrong codes against a request deny it; a poll faster than `poll_interval_seconds`
-- answers `slow_down` and widens the interval by 5 s (RFC 8628 §3.5).

CREATE TABLE IF NOT EXISTS "device_auth_requests" (
  "id"                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "device_code_hash"      text NOT NULL,          -- sha256(device_code)
  "user_code_hash"        text NOT NULL,          -- sha256(normalized user_code)
  "status"                text NOT NULL DEFAULT 'pending',
  "client_name"           text NOT NULL,
  "hostname"              text NOT NULL,
  "platform"              text,
  "requested_agents"      text[] NOT NULL DEFAULT '{}',
  "requester_ip"          text,
  "user_agent"            text,
  "approved_by_user_id"   text REFERENCES "users"("id") ON DELETE SET NULL,
  "approved_at"           timestamptz,
  "approved_agents"       text[],
  -- The computer the approver chose to REUSE (same hostname), else NULL until
  -- collection creates one; set to the computer used once collected.
  "machine_user_id"       text REFERENCES "users"("id") ON DELETE SET NULL,
  "machine_name"          text,
  "minted_key_id"         uuid,
  "failed_code_attempts"  integer NOT NULL DEFAULT 0,
  "poll_interval_seconds" integer NOT NULL DEFAULT 5,
  "last_polled_at"        timestamptz,
  "consumed_at"           timestamptz,
  "expires_at"            timestamptz NOT NULL,
  "created_at"            timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "device_auth_requests" ADD COLUMN IF NOT EXISTS "approved_agents" text[];
ALTER TABLE "device_auth_requests" ADD COLUMN IF NOT EXISTS "machine_user_id" text;
ALTER TABLE "device_auth_requests" ADD COLUMN IF NOT EXISTS "machine_name" text;
ALTER TABLE "device_auth_requests" ADD COLUMN IF NOT EXISTS "poll_interval_seconds" integer NOT NULL DEFAULT 5;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'device_auth_requests_status_check') THEN
    ALTER TABLE "device_auth_requests" ADD CONSTRAINT "device_auth_requests_status_check"
      CHECK ("status" IN ('pending', 'approved', 'denied', 'consumed'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "device_auth_requests_device_code_hash_idx"
  ON "device_auth_requests" ("device_code_hash");
-- A user code is unique among the requests still waiting for a person.
CREATE UNIQUE INDEX IF NOT EXISTS "device_auth_requests_pending_user_code_idx"
  ON "device_auth_requests" ("user_code_hash")
  WHERE "status" = 'pending';
CREATE INDEX IF NOT EXISTS "device_auth_requests_expires_at_idx"
  ON "device_auth_requests" ("expires_at");
