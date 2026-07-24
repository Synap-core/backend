-- 0207_pod_oauth_authorization_server.sql — the pod as its own OAuth 2.1 AS
--
-- Path B of claude.ai MCP connectivity. Path A puts the control plane (CP) in
-- the trust path: claude.ai authenticates against the CP, which proxies tool
-- calls to the pod (see 0206_mcp_connect_codes.sql). Path B removes the CP
-- entirely — claude.ai talks straight to `https://<pod>/mcp` and the pod itself
-- serves RFC 8414 AS metadata, RFC 9728 protected-resource metadata, RFC 7591
-- dynamic client registration, /authorize and /token.
--
-- Two tables:
--   oauth_clients             — dynamically-registered PUBLIC clients (no
--                               secret; PKCE alone protects the code exchange).
--   oauth_authorization_codes — single-use codes bound to a PKCE S256 challenge.
--
-- The ACCESS TOKEN is deliberately NOT stored here: it is an `api_keys` row
-- minted at /token via provisionSurfaceAgentKey, so the pod keeps exactly ONE
-- bearer-token model. The minted key carries linkedUserId = the consenting
-- human, which is what makes MCP writes route through checkPermissionOrPropose.
--
-- SECURITY: only sha256(code) is stored (same lookup-hash pattern as
-- api_keys.key_lookup_hash and mcp_connect_codes.code_hash). Single-use is
-- enforced by an atomic UPDATE … WHERE consumed_at IS NULL … RETURNING.
--
-- Additive, idempotent. Also added to 0000_baseline_schema.sql + schema-coherence.ts.

CREATE TABLE IF NOT EXISTS "oauth_clients" (
  "client_id"     text PRIMARY KEY,                                -- generated `dcr_<random>`, never client-chosen
  "client_name"   text NOT NULL,                                   -- untrusted display text (render as text, never markup)
  "redirect_uris" text[] NOT NULL DEFAULT '{}',                    -- https-only, compared byte-for-byte (no prefix matching)
  "scopes"        text[] NOT NULL DEFAULT '{}',                    -- pod-grammar scopes this client may be granted
  "created_at"    timestamp with time zone NOT NULL DEFAULT now()
);

-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "oauth_clients" ADD COLUMN IF NOT EXISTS "client_name"   text;
ALTER TABLE "oauth_clients" ADD COLUMN IF NOT EXISTS "redirect_uris" text[] DEFAULT '{}';
ALTER TABLE "oauth_clients" ADD COLUMN IF NOT EXISTS "scopes"        text[] DEFAULT '{}';
ALTER TABLE "oauth_clients" ADD COLUMN IF NOT EXISTS "created_at"    timestamp with time zone DEFAULT now();

CREATE TABLE IF NOT EXISTS "oauth_authorization_codes" (
  "code_hash"      text PRIMARY KEY,                               -- sha256(rawCode) — the only stored form of the code
  "client_id"      text NOT NULL,
  "user_id"        text NOT NULL,                                  -- consenting human → minted key linkedUserId (governance!)
  "redirect_uri"   text NOT NULL,                                  -- byte-exact match required at /token
  "scopes"         text[] NOT NULL DEFAULT '{}',
  "code_challenge" text NOT NULL,                                  -- PKCE S256 challenge (base64url); `plain` is never accepted
  "created_at"     timestamp with time zone NOT NULL DEFAULT now(),
  "expires_at"     timestamp with time zone NOT NULL,
  "consumed_at"    timestamp with time zone                        -- NULL = unconsumed; set atomically at /token
);

-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "oauth_authorization_codes" ADD COLUMN IF NOT EXISTS "client_id"      text;
ALTER TABLE "oauth_authorization_codes" ADD COLUMN IF NOT EXISTS "user_id"        text;
ALTER TABLE "oauth_authorization_codes" ADD COLUMN IF NOT EXISTS "redirect_uri"   text;
ALTER TABLE "oauth_authorization_codes" ADD COLUMN IF NOT EXISTS "scopes"         text[] DEFAULT '{}';
ALTER TABLE "oauth_authorization_codes" ADD COLUMN IF NOT EXISTS "code_challenge" text;
ALTER TABLE "oauth_authorization_codes" ADD COLUMN IF NOT EXISTS "created_at"     timestamp with time zone DEFAULT now();
ALTER TABLE "oauth_authorization_codes" ADD COLUMN IF NOT EXISTS "expires_at"     timestamp with time zone;
ALTER TABLE "oauth_authorization_codes" ADD COLUMN IF NOT EXISTS "consumed_at"    timestamp with time zone;

-- Sweep expired/consumed codes efficiently (a housekeeping job may prune later).
CREATE INDEX IF NOT EXISTS "oauth_authorization_codes_expires_at_idx"
  ON "oauth_authorization_codes" ("expires_at");
