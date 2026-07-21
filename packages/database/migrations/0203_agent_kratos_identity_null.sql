-- Migration: 0203_agent_kratos_identity_null.sql
--
-- Agent-identity spine (Track B) Wave 1 — normalize the human↔agent discriminator.
--
-- INVARIANT: an agent (users.user_type='agent') NEVER carries a Kratos identity.
-- `kratos_identity_id IS NULL` is the canonical "this is not a Kratos human" signal;
-- agents authenticate on the Hub-key rail, never through Kratos self-service.
--
-- One agent-user create-door (`createNamedAgent` in agent-identity-service.ts) used
-- to stamp a fake sentinel `agent:${uuid}` into kratos_identity_id, while the other
-- door (`/api/hub/setup/agent`) correctly wrote NULL. Nothing reads the `agent:`
-- prefix (verified by grep), so those sentinel rows are pure drift — but the
-- upcoming federated user-sign-in rework classifies "kratos_identity_id IS NOT NULL"
-- as "is a Kratos human", which would mis-classify any agent still carrying the
-- sentinel. This backfills them to NULL so the discriminator is unambiguous.
--
-- Data-only migration: no new column, so no 0000_baseline / schema-coherence entry.
-- Idempotent — only touches agent rows that still carry the sentinel.
-- No unique index exists on kratos_identity_id, so multiple NULLs are fine.

UPDATE users
SET kratos_identity_id = NULL
WHERE user_type = 'agent'
  AND kratos_identity_id LIKE 'agent:%';
