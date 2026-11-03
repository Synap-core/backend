-- Migration: 0396_widget_definitions_content_sha256.sql
--
-- APPROVAL PER FINGERPRINT (decision Q9, plan 9ad4b2fc lane 16). A stored
-- cell renderer is a fixed artifact: what a person approves is exactly its
-- content, and any change to it is a new approval (prior art: Notion custom
-- blocks, MCP Apps). This column holds the sha256 (hex) of that content as
-- stored: the mechanism (renderer_type), the source (renderer_source), the
-- runtime deps and the egress grant (external_hosts), in the canonical form of
-- `cellContentFingerprint` (`@synap/api` services/cells/cell-content-fingerprint.ts).
--
-- Written by `defineCell`, the one writer of a cell row, from the row as it
-- was written. A `cell/define` proposal carries the same fingerprint in its
-- payload (`contentSha256`); its approve executor refuses a payload that no
-- longer matches it.
--
-- NO BACKFILL, on purpose: NULL means "written before fingerprints", and the
-- next write through defineCell stamps it. A backfill would stamp content
-- nobody approved under this rule as if somebody had. NULL is also what a row
-- replicated from another pod holds (`routers/sync.ts`): no approval on this
-- pod covers it.
--
-- Nullable, no default, no index (nothing looks a row up by it): adding it is
-- a catalog-only change on any Postgres >= 11.

ALTER TABLE "widget_definitions"
  ADD COLUMN IF NOT EXISTS "content_sha256" text;
