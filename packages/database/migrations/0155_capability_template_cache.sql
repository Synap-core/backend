-- 0155 — Capability Template CACHE: pod-local persisted mirror of the CP catalog.
--
-- The capability catalog (GET /api/hub/capabilities/catalog) previously did a
-- BLOCKING fetch to the Control Plane on the request path (8s timeout, in-memory
-- cache only) → the catalog hung ~8s or returned empty when the CP was slow/down.
-- The CP must be a cached fallback, NOT a live request-path dependency.
--
-- This table is a CACHE, not a source of truth: the CP still owns the catalog
-- (the same place workspace packages live). A background sync job refreshes it
-- every 10 minutes and on startup; catalog reads serve from here (fast DB read,
-- no network — stale-while-revalidate). On CP failure the existing cache is left
-- intact (never wiped). Restores pod sovereignty.
--
-- Defensive/idempotent per backend-rules.

CREATE TABLE IF NOT EXISTS "capability_template_cache" (
  "key"         text        PRIMARY KEY,
  "name"        text        NOT NULL,
  "description" text,
  "definition"  jsonb       NOT NULL,
  "synced_at"   timestamptz NOT NULL DEFAULT now()
);
