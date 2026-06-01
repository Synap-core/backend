-- 0032_dedupe_orphan_agents.sql
--
-- One-time cleanup of the agent catalog (`agents` table).
--
-- Before boot-time agent sync existed, self-hosted pods accumulated orphan
-- catalog rows (e.g. two "orchestrator" rows) inserted outside the sync path,
-- with a NULL or dangling `intelligence_service_id`. These show up as duplicate
-- built-in agents in the Catalog.
--
-- This deletes catalog rows that are NOT user-owned AND have no valid owning
-- intelligence service. The boot-time sync (`syncAgentsToPod`) then repopulates
-- the canonical, de-duplicated roster under the real synap-hub service.
--
-- Deleting orphans (rather than deduping by slug) is required: a kept orphan has
-- a different intelligence_service_id than the synced row, so the sync upsert
-- (conflict target: intelligence_service_id + slug) would NOT match it and would
-- insert a fresh duplicate. Removing ownerless rows lets the sync own the slug.
--
-- User-created custom agents (owner_type = 'user') are always preserved.
-- Idempotent: safe to re-run (orphans are gone after the first pass).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_name = 'agents'
  ) THEN
    -- Explicit allowlist of built-in owner types (rather than "not user") so we
    -- never inadvertently delete future owner types (e.g. 'workspace', 'org').
    DELETE FROM agents a
    WHERE a.owner_type IN ('system', 'synap', 'provider')
      AND (
        a.intelligence_service_id IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM intelligence_services s
          WHERE s.id = a.intelligence_service_id
        )
      );
  END IF;
END;
$$;
