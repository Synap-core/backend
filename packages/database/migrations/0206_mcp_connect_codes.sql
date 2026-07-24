-- 0206_mcp_connect_codes.sql — one-time consent codes for the CP-MCP pod-accept gate
--
-- MCP-OAUTH-AND-CONNECT-PLAN §2-3. When a pod user authorizes the control plane
-- (CP) to reach their pod's MCP, pod-admin's `/connect` page mints a short-lived
-- consent code (session-authed) and top-level-navigates to the CP callback with
-- ONLY the code — never a plaintext key. The CP redeems the code server-to-server
-- (POST /api/hub/mcp/redeem, master-key Bearer), and the pod mints the `claude-web`
-- agent key AT REDEEM time. Minting on redeem (not on Allow) means no plaintext key
-- is ever stored or transmitted in a browser-facing channel.
--
-- SECURITY: only a HASH of the code is stored (sha256 of the raw code, the same
-- lookup-hash pattern as api_keys.key_lookup_hash). The raw code is returned to the
-- browser once and never persisted. Single-use (consumed_at, set atomically at
-- redeem) + short TTL (expires_at, ~10 min).
--
-- Additive, idempotent. Also added to 0000_baseline_schema.sql + schema-coherence.ts.

CREATE TABLE IF NOT EXISTS "mcp_connect_codes" (
  "code_hash"   text PRIMARY KEY,                                  -- sha256(rawCode) — the only stored form of the code
  "pod_user_id" text NOT NULL,                                     -- the human who authorized CP (→ minted key linkedUserId)
  "scopes"      text[] NOT NULL DEFAULT '{}',                      -- CP-grammar scopes; mapped to pod grammar at redeem
  "agent_type"  text NOT NULL,                                     -- "claude-web"
  "created_at"  timestamp with time zone NOT NULL DEFAULT now(),
  "expires_at"  timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone                           -- NULL = unconsumed; set atomically at redeem
);

-- Ensure all columns exist on pre-existing tables (idempotent guard)
ALTER TABLE "mcp_connect_codes" ADD COLUMN IF NOT EXISTS "pod_user_id" text;
ALTER TABLE "mcp_connect_codes" ADD COLUMN IF NOT EXISTS "scopes"      text[] DEFAULT '{}';
ALTER TABLE "mcp_connect_codes" ADD COLUMN IF NOT EXISTS "agent_type"  text;
ALTER TABLE "mcp_connect_codes" ADD COLUMN IF NOT EXISTS "created_at"  timestamp with time zone DEFAULT now();
ALTER TABLE "mcp_connect_codes" ADD COLUMN IF NOT EXISTS "expires_at"  timestamp with time zone;
ALTER TABLE "mcp_connect_codes" ADD COLUMN IF NOT EXISTS "consumed_at" timestamp with time zone;

-- Sweep expired/consumed codes efficiently (a housekeeping job may prune later).
CREATE INDEX IF NOT EXISTS "mcp_connect_codes_expires_at_idx"
  ON "mcp_connect_codes" ("expires_at");
