-- 0124_vault_grants.sql
-- Real AI access grant semantics for the vault.
--
-- Until now, approving a vault.request proposal (grantAIAccess) embedded a
-- vault:// ref in the proposal but carried NO scope/TTL semantics — a grant was
-- effectively permanent and the browser "Once / Session / Permanent" pills were
-- inert. This table records the actual grant window so redemption can enforce it.
--
-- Enforcement (agent/IS redemption paths only): the vault resolver looks up an
-- ACTIVE grant (revoked_at IS NULL, (expires_at IS NULL OR expires_at > now()),
-- (max_uses IS NULL OR use_count < max_uses)) and atomically increments
-- use_count. The pod's own service-bootstrap paths (getServiceConfig /
-- getServiceSecret) deliberately bypass this table.

CREATE TYPE vault_grant_scope AS ENUM ('once', 'session', 'permanent');

CREATE TABLE IF NOT EXISTS vault_grants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  secret_id     uuid NOT NULL REFERENCES secrets(id) ON DELETE CASCADE,
  proposal_id   uuid,
  granted_to    text,
  workspace_id  uuid,
  scope         vault_grant_scope NOT NULL DEFAULT 'session',
  expires_at    timestamptz,
  max_uses      integer,
  use_count     integer NOT NULL DEFAULT 0,
  revoked_at    timestamptz,
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vault_grants_secret_id ON vault_grants(secret_id);
CREATE INDEX IF NOT EXISTS idx_vault_grants_granted_to ON vault_grants(granted_to);
CREATE INDEX IF NOT EXISTS idx_vault_grants_proposal_id ON vault_grants(proposal_id);
CREATE INDEX IF NOT EXISTS idx_vault_grants_secret_active ON vault_grants(secret_id, revoked_at);
