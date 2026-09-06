-- 0247_backfill_property_enum_constraints.sql
--
-- A closed set of values that nothing could read, and nothing enforced.
--
-- `reconcile-workspace-from-definition.ts` wrote a template property's options
-- to `ui_hints.enumValues` — the AUTHORING spelling a workspace-template YAML
-- uses — while the product's readers key on `constraints.enum`. So a
-- template-installed enum property was BORN unreadable. It had not drifted into
-- a bad state; it was never in a good one.
--
--   364 authored enum properties across 30 workspace-template YAMLs
--   0    of them author `constraints.enum`
--
-- This was never only a rendering bug. `property-validation-service.ts` guards
-- with `if (constraints.enum && Array.isArray(constraints.enum))`, so for every
-- one of those properties the admissible-values check did not FAIL — it never
-- RAN, and any string was accepted server-side. `capture.ts` reads the same key,
-- so AI capture could not see the admissible values either. The picker being
-- empty was the visible half of the defect; the unvalidated write was the half
-- no screenshot could show.
--
-- It stayed hidden because `ensure-system-profiles.ts` writes `constraints.enum`
-- correctly at 27 sites: every BUILT-IN picker worked, and only
-- TEMPLATE-INSTALLED ones were text boxes. The two populations never appeared on
-- the same screen.
--
-- The writer is fixed in the same wave (`property-enum.ts` is now the ONE mapper
-- between the two spellings, and a source-scan tripwire keeps it the only one).
-- This migration carries the rows already sitting in pods.
--
-- Idempotent by construction: the WHERE clause selects only rows that have the
-- legacy key and lack the canonical one, so a re-run matches nothing.
--
-- NON-DESTRUCTIVE: `ui_hints.enumValues` is deliberately LEFT IN PLACE. Nothing
-- reads it any more, it costs a few hundred bytes across the whole table, and
-- leaving it means a rollback of the code change loses no data. Dropping the key
-- is a separate migration to run once this has been live long enough to trust.

-- (a) Template-installed properties: the options landed in `ui_hints.enumValues`
--     (both provisioning doors — fresh create AND reconcile — wrote them there).
UPDATE property_defs
SET constraints = COALESCE(constraints, '{}'::jsonb)
                  || jsonb_build_object('enum', ui_hints -> 'enumValues')
WHERE jsonb_typeof(ui_hints -> 'enumValues') = 'array'
  AND ui_hints -> 'enumValues' <> '[]'::jsonb
  AND (constraints -> 'enum') IS NULL;

-- (b) Hand-created properties: `PropertyCreationPanel` wrote a THIRD spelling,
--     `constraints.enumValues` — right object, wrong key. Those rows are just as
--     unreadable and just as unvalidated, and clause (a) does not match them
--     because nothing was ever written to `ui_hints` for them. Found while
--     reviewing this migration; it would otherwise have left every enum property
--     a human created by hand still broken.
UPDATE property_defs
SET constraints = (constraints - 'enumValues')
                  || jsonb_build_object('enum', constraints -> 'enumValues')
WHERE jsonb_typeof(constraints -> 'enumValues') = 'array'
  AND constraints -> 'enumValues' <> '[]'::jsonb
  AND (constraints -> 'enum') IS NULL;
