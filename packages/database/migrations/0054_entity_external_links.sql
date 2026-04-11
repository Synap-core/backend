-- Migration 0054: Create entity_external_links table
--
-- Tracks the mapping between Synap entities and their external source records
-- (e.g., Google Calendar event → Synap event entity).
--
-- Used for:
--   - Deduplication during connector sync (upsert by provider + externalId)
--   - Change detection (sync_hash comparison)
--   - Disconnect handling (status = 'disconnected')
--   - Re-linking on reconnect

CREATE TABLE IF NOT EXISTS entity_external_links (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id             uuid        NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  provider              text        NOT NULL,
  external_id           text        NOT NULL,
  nango_connection_id   text        NOT NULL,
  status                text        NOT NULL DEFAULT 'active',
  sync_hash             text,
  last_synced_at        timestamptz NOT NULL DEFAULT now(),
  disconnected_at       timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- Core dedup: one link per external record per provider
CREATE UNIQUE INDEX IF NOT EXISTS IF NOT EXISTS entity_external_links_provider_external_id_idx
  ON entity_external_links (provider, external_id);

-- Find all external links for an entity
CREATE INDEX IF NOT EXISTS entity_external_links_entity_id_idx
  ON entity_external_links (entity_id);

-- Find all links for a provider (used during disconnect)
CREATE INDEX IF NOT EXISTS entity_external_links_provider_idx
  ON entity_external_links (provider);

-- Find all links for a Nango connection (used during disconnect)
CREATE INDEX IF NOT EXISTS entity_external_links_nango_connection_id_idx
  ON entity_external_links (nango_connection_id);

-- Active links only
CREATE INDEX IF NOT EXISTS entity_external_links_status_idx
  ON entity_external_links (status);
