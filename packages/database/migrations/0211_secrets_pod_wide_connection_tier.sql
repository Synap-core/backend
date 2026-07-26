-- 0211_secrets_pod_wide_connection_tier.sql
--
-- Pod-wide connection tier (Wave 4 — VAULT KEYS ONLY).
--
-- A capability connection (`secrets` row carrying `capability_id`) may be marked
-- `is_pod_wide`: a shared vault key any pod member can USE for that capability
-- WITHOUT holding a per-user vault grant — while every run still passes through
-- the capability-execution gate (pod-wide removes the per-user credential-GRANT
-- requirement, never the run governance). Precedence at read time: a member's OWN
-- connection wins over the pod-wide default. Scope is intentionally VAULT ONLY —
-- a pod-wide OAuth/Nango connection would require run-as-owner proxying and is
-- explicitly out of scope; only `kind:"vault"` (no provider_integration_id / no
-- account_hint) connections are ever resolved pod-wide.
--
-- Write RBAC (enforced in the service layer): creating / mutating a pod-wide
-- connection requires pod-admin; per-user connections stay owner-managed.
--
-- Additive + defaulted → safe, non-breaking.

ALTER TABLE "secrets" ADD COLUMN IF NOT EXISTS "is_pod_wide" boolean NOT NULL DEFAULT false;

-- Separate DEFAULT slots per tier: a per-user default (is_pod_wide=false) AND a
-- pod-wide default (is_pod_wide=true) may coexist for the same capability. The
-- old index keyed on (capability_id) alone, which would COLLIDE the two. Recreate
-- it keyed on (capability_id, is_pod_wide). Strictly more permissive than the old
-- index, so no existing row can violate it.
DROP INDEX IF EXISTS "idx_secrets_capability_default";
CREATE UNIQUE INDEX IF NOT EXISTS "idx_secrets_capability_default"
  ON "secrets" ("capability_id", "is_pod_wide")
  WHERE "is_default" AND "capability_id" IS NOT NULL;
