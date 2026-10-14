-- Migration: 0327_split_source_provenance_lead_source.sql
--
-- Founder decision 2026-09-14 (pod dafee96b): split `source` into `provenance`
-- (HOW a record arrived: manual | mcp | import | connector | automation |
-- agent | webhook) and `leadSource` (CRM lead attribution, on person /
-- company / the lead role only). See `src/utils/provenance.ts`.
--
-- Why now (live pod, 2026-10-12 16:27 UTC): the template reconciler unioned
-- CRM's lead-source enum INTO the pod-wide GLOBAL `source` def (fixed in
-- reconcile-workspace-from-definition.ts — a template never writes a global
-- def again), and every connector writing `source: '<provider>'` was refused
-- at approval.
--
-- The seeder creates the `provenance` + `provider` global defs and links them
-- on boot; the CRM template now declares `leadSource`. This migration fixes the
-- stored state both of those cannot reach. Data only (property defs are rows,
-- entity properties are JSONB), no column, so no baseline / schema-coherence
-- change. Every step is guarded on the state it fixes, so a re-run changes
-- nothing (idempotent). Migrations run before the boot reconcile, so the
-- renamed `leadSource` defs are found as the CRM template's own on its next
-- pass (no twin def).
--
-- Values that name a PROVIDER ('fal.ai', 'cal.com', 'stellar', …) stay in the
-- legacy `source` key on purpose: they cannot be split into provenance +
-- provider without guessing the transport, and existing readers still match
-- on them. New writers record `provider` instead.

-- 1. The GLOBAL `source` def is free text again, on every pod (the live pod
--    was hot-fixed by hand on 2026-10-13; this reaches the others).
UPDATE property_defs
SET constraints = constraints - 'enum' - 'enumOptions',
    ui_hints = (ui_hints - 'enumValues') || '{"inputType": "text"}'::jsonb,
    updated_at = now()
WHERE slug = 'source'
  AND profile_id IS NULL
  AND workspace_id IS NULL
  AND (constraints ? 'enum'
       OR constraints ? 'enumOptions'
       OR ui_hints ? 'enumValues');

-- 2. A profile's own `source` def carrying the CRM lead vocabulary IS a lead
--    source: rename it to `leadSource` (its profile links follow the row).
--    Skipped where that scope already has a `leadSource` def (step 3 covers it).
UPDATE property_defs pd
SET slug = 'leadSource',
    ui_hints = pd.ui_hints || '{"label": "Lead source"}'::jsonb,
    updated_at = now()
WHERE pd.slug = 'source'
  AND pd.profile_id IS NOT NULL
  AND (pd.constraints -> 'enum' ? 'cold-outreach'
       OR pd.ui_hints -> 'enumValues' ? 'cold-outreach')
  AND NOT EXISTS (
    SELECT 1 FROM property_defs o
    WHERE o.slug = 'leadSource'
      AND o.profile_id = pd.profile_id
      AND o.workspace_id IS NOT DISTINCT FROM pd.workspace_id
  );

-- 3. Any such def left over (its scope already had `leadSource`) stops
--    rejecting non-lead values: it keeps its slug and loses the lead enum.
UPDATE property_defs
SET constraints = constraints - 'enum' - 'enumOptions',
    ui_hints = (ui_hints - 'enumValues') || '{"inputType": "text"}'::jsonb,
    updated_at = now()
WHERE slug = 'source'
  AND profile_id IS NOT NULL
  AND (constraints -> 'enum' ? 'cold-outreach'
       OR ui_hints -> 'enumValues' ? 'cold-outreach');

-- 4. Lead attribution on CRM person / company → `leadSource`. The list is the
--    CRM template's vocabulary plus the legacy values the CRM app and older
--    templates wrote (an attribution value, never a transport). An existing
--    `leadSource` wins.
UPDATE entities
SET properties = (properties - 'source')
                 || jsonb_build_object('leadSource', properties -> 'source'),
    updated_at = now()
WHERE type IN ('person', 'company')
  AND deleted_at IS NULL
  AND NOT properties ? 'leadSource'
  AND properties ->> 'source' IN (
    'cold-outreach', 'linkedin', 'twitter', 'landing-page', 'inbound-call',
    'referral', 'event', 'other', 'email', 'inbound', 'partner', 'website',
    'cold_email', 'cold_call', 'partnership', 'content', 'paid_ads', 'social',
    'direct'
  );

-- 5. The same on the lead role's facets (the role declared `source` too).
UPDATE entity_facets ef
SET properties = (ef.properties - 'source')
                 || jsonb_build_object('leadSource', ef.properties -> 'source'),
    updated_at = now()
FROM profiles p
WHERE p.id = ef.profile_id
  AND p.slug = 'lead'
  AND ef.deleted_at IS NULL
  AND NOT ef.properties ? 'leadSource'
  AND ef.properties ->> 'source' IN (
    'cold-outreach', 'linkedin', 'twitter', 'landing-page', 'inbound-call',
    'referral', 'event', 'other', 'email', 'inbound', 'partner', 'website',
    'cold_email', 'cold_call', 'partnership', 'content', 'paid_ads', 'social',
    'direct'
  );

-- 6. Transport values on the kinds that carry provenance → `provenance`.
--    An existing `provenance` wins.
UPDATE entities
SET properties = (properties - 'source')
                 || jsonb_build_object('provenance', properties -> 'source'),
    updated_at = now()
WHERE type IN ('bookmark', 'website', 'article', 'signal_item', 'note',
               'event', 'task', 'research', 'person', 'company')
  AND deleted_at IS NULL
  AND NOT properties ? 'provenance'
  AND properties ->> 'source' IN (
    'manual', 'mcp', 'import', 'connector', 'automation', 'agent', 'webhook'
  );
