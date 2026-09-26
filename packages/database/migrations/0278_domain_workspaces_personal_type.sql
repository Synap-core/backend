-- 0278: domain workspaces installed from finance / hr / legal / internal-runbook
-- are DOMAIN homes, not operational surfaces.
--
-- Those four templates declared `workspaceType: operational` (fixed in the
-- templates, W0 of the concept consolidation). "operational" means an admin
-- surface to the placement code (isDomainHomeWorkspace), so a live Finance
-- workspace was hidden from orient AND refused every entity filed into it
-- ("DOMAIN_INTO_NON_DOMAIN_HOME"). No door rewrites `workspace_type` (the
-- reconcile never touches it), hence this data fix.
--
-- Guarded: only non-system rows whose template identity (the `package_slug`
-- column, or the older `settings.packageSlug` stamp) is one of the four AND
-- whose type is still `operational`. `dev-dashboard` / `agent-fleet` and the
-- pod-admin console (system_slug set) are untouched. Idempotent: a second run
-- matches nothing. No column changes (baseline / schema-coherence untouched).

UPDATE "workspaces"
SET "workspace_type" = 'personal',
    "updated_at" = now()
WHERE "workspace_type" = 'operational'
  AND "system_slug" IS NULL
  AND (
    "package_slug" IN ('finance', 'hr', 'legal', 'internal-runbook')
    OR "settings"->>'packageSlug' IN ('finance', 'hr', 'legal', 'internal-runbook')
  );
