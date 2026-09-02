-- Migration: 0242_capabilities_template_key.sql
--
-- Capability CONTAINER identity (mirrors 0227 playbooks / 0230 automations).
--
-- `capabilities` (the container table) shipped with NO unique index at all —
-- only `idx_capabilities_workspace_id` and `idx_capabilities_created_by`.
-- Identity was `name + workspace scope`, resolved by an unguarded
-- select-then-insert in `createCapabilityFromDefinition` / `ensureProviderContainer`,
-- so a re-apply, a rename upstream, or two concurrent installs each minted a
-- second container. Confirmed live: `Agency — AI Know-How` ×2 and
-- `Stellar Grant — Client Process` ×2; every UI surface collapses by name, so the
-- clones were invisible.
--
-- A container has no remote object to point at — no guild, no account, no
-- external id. Its identity is its TERRAFORM ADDRESS: the template it was
-- instantiated from, within a scope. That value already exists — the applier
-- stamps `metadata.templateKey` (`create-from-definition.ts`) and
-- `workspace-to-package-definition.ts` reads it back — it was simply never a
-- column and never unique. This promotes it. Deliberately NOT an `external_id`
-- column: it would be NULL forever on exactly the rows that duplicate.
--
-- ── Why this is safe to run on a pod that HAS duplicates ─────────────────────
-- The column is NEW, so the backfill decides which rows carry an address. Per
-- (scope, templateKey) exactly ONE row is stamped — the winner — and every
-- other clone keeps `template_key = NULL`. NULL rows are excluded by the partial
-- unique index (`WHERE template_key IS NOT NULL`), so the index always builds,
-- on any pod, with no DELETE and no data loss.
--
-- Winner rule: MOST MEMBER LINKS first (`* --member_of--> capability`), then
-- oldest. The container the graph already points at is the one worth addressing;
-- picking blindly-oldest would have stranded the members of the live
-- `Stellar Grant — Client Process` pair on the 0-verb row. Nothing is archived
-- (capabilities have no `status` column) — the losing clones stay fully intact,
-- still carrying `metadata.templateKey`, and remain visible to the repair script
-- (`packages/database/scripts/repair-duplicate-config-rows.ts`, dry-run by
-- default), which is where merging them belongs. This is HONEST
-- under-convergence: an unstamped clone claims nothing, and the next apply
-- resolves to the stamped winner rather than minting a third row.
--
-- NULL workspace_id is coalesced to a sentinel UUID (same pattern as
-- playbooks_workspace_name_active_uq / automations_workspace_name_active_uq) so
-- pod-wide containers participate in uniqueness — a plain
-- UNIQUE (template_key, workspace_id) treats NULLs as distinct and would let
-- pod-wide clones straight through, which is exactly where the live duplicates
-- live.
--
-- Additive. Also mirrored into 0000_baseline_schema.sql +
-- packages/database/src/schema/capabilities.ts + utils/schema-coherence.ts.

-- ── Column ───────────────────────────────────────────────────────────────────
ALTER TABLE "capabilities" ADD COLUMN IF NOT EXISTS "template_key" text;

-- ── Backfill from the already-stamped metadata, winner-only ──────────────────
WITH candidates AS (
  SELECT
    c.id,
    c.metadata->>'templateKey' AS tkey,
    COALESCE(c.workspace_id, '00000000-0000-0000-0000-000000000000'::uuid) AS scope,
    c.created_at,
    (
      SELECT count(*)
      FROM links l
      WHERE l.to_type = 'capability'
        AND l.link_type = 'member_of'
        AND l.to_id = c.id::text
    ) AS member_count
  FROM capabilities c
  WHERE c.template_key IS NULL
    AND c.metadata->>'templateKey' IS NOT NULL
    AND c.metadata->>'templateKey' <> ''
),
ranked AS (
  SELECT
    id,
    tkey,
    ROW_NUMBER() OVER (
      PARTITION BY scope, tkey
      ORDER BY member_count DESC, created_at ASC NULLS LAST, id ASC
    ) AS rn
  FROM candidates
)
UPDATE capabilities c
SET template_key = ranked.tkey
FROM ranked
WHERE c.id = ranked.id
  AND ranked.rn = 1;

-- ── Lookup index (resolution reads by address) ───────────────────────────────
CREATE INDEX IF NOT EXISTS "idx_capabilities_template_key"
  ON "capabilities" ("template_key");

-- ── Race-safe address uniqueness ─────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS "capabilities_template_key_scope_uq"
  ON "capabilities" (
    COALESCE(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid),
    "template_key"
  )
  WHERE "template_key" IS NOT NULL;

-- ── Surface the clones this migration deliberately left unaddressed ──────────
DO $$
DECLARE
  unaddressed integer;
BEGIN
  SELECT count(*) INTO unaddressed
  FROM capabilities
  WHERE template_key IS NULL
    AND metadata->>'templateKey' IS NOT NULL
    AND metadata->>'templateKey' <> '';
  IF unaddressed > 0 THEN
    RAISE NOTICE
      '0242: % capability container(s) carry metadata.templateKey but lost the address to an older/better-linked clone. They are intact and unstamped; merge them with packages/database/scripts/repair-duplicate-config-rows.ts (dry-run by default).',
      unaddressed;
  END IF;
END $$;
