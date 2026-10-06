-- 0308_workspace_identity_unique.sql
--
-- Workspace identity, by construction (founder, 2026-10-06): "we can't have
-- workspaces with the same name, and we can't have 2 workspaces that come from
-- the same template. just that (no user link)."
--
-- Two POD-WIDE invariants over ACTIVE (non-archived) spaces — no owner/user
-- column, on purpose:
--   workspaces_active_name_unique          lower(btrim(name))
--   workspaces_active_package_slug_unique  package_slug (when set)
--
-- Incident that motivated it: `synap market update content-os` posted a
-- catalog definition with no `_meta.slug`; the approve executor fell back to
-- the proposal row id as the idempotency key, matched nothing, and minted a
-- second, empty "Content OS" beside the real one.
--
-- A failed migration aborts pod boot, so the dedupe below must NEVER fail and
-- must lose nothing. It runs BEFORE the indexes are created:
--   1. Duplicate active names: the OLDEST row (created_at, then id) keeps its
--      name; every other row is renamed "<name> (2)", "(3)"… — each new name
--      checked free against every active name first.
--   2. Duplicate active package_slug: the OLDEST keeps it; every other row gets
--      package_slug = NULL and `settings.detachedPackageSlug = <slug>` (its
--      settings.packageSlug key moves there too, so a later settings round-trip
--      cannot re-promote the slug into the column). A detached row whose
--      provisioning key was the template's own (`<slug>` or a named-instance
--      `<slug>:<name>`) loses it the same way (`settings.detachedProposalId`),
--      so a reinstall's key lookup can only ever reach the keeper.
--   Every change is RAISE NOTICE'd.
--   3. Backfill: an active template space with no provisioning key gets
--      `provisioning_proposal_id = package_slug` when no other row holds that
--      key, so the idempotent create's step-1 key lookup hits it directly.
--
-- Idempotent: re-running finds no duplicates and creates nothing new.
-- Mirrored by the Drizzle schema (`workspaces.ts` uniqueIndex .where) and
-- required at boot by `findMissingIndexes` (schema-coherence.ts).

DO $$
DECLARE
  r record;
  base text;
  candidate text;
  n integer;
BEGIN
  -- 1. Duplicate active names ------------------------------------------------
  FOR r IN
    SELECT id, name, rn
      FROM (
        SELECT id, name, created_at,
               row_number() OVER (
                 PARTITION BY lower(btrim(name))
                 ORDER BY created_at ASC NULLS LAST, id ASC
               ) AS rn
          FROM workspaces
         WHERE archived_at IS NULL
      ) ranked
     WHERE rn > 1
     ORDER BY lower(btrim(name)), rn
  LOOP
    base := btrim(r.name);
    n := r.rn;
    LOOP
      candidate := btrim(base || ' (' || n || ')');
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM workspaces
         WHERE archived_at IS NULL
           AND lower(btrim(name)) = lower(candidate)
      );
      n := n + 1;
    END LOOP;
    UPDATE workspaces SET name = candidate, updated_at = now() WHERE id = r.id;
    RAISE NOTICE '0308: workspace % renamed "%" -> "%" (duplicate active name)',
      r.id, r.name, candidate;
  END LOOP;

  -- 2. Duplicate active package_slug ----------------------------------------
  FOR r IN
    SELECT id, package_slug, provisioning_proposal_id
      FROM (
        SELECT id, package_slug, provisioning_proposal_id,
               row_number() OVER (
                 PARTITION BY package_slug
                 ORDER BY created_at ASC NULLS LAST, id ASC
               ) AS rn
          FROM workspaces
         WHERE archived_at IS NULL
           AND package_slug IS NOT NULL
      ) ranked
     WHERE rn > 1
     ORDER BY package_slug, rn
  LOOP
    IF r.provisioning_proposal_id IS NOT NULL
       AND (r.provisioning_proposal_id = r.package_slug
            OR left(r.provisioning_proposal_id, length(r.package_slug) + 1)
               = r.package_slug || ':') THEN
      UPDATE workspaces
         SET package_slug = NULL,
             provisioning_proposal_id = NULL,
             settings = (coalesce(settings, '{}'::jsonb) - 'packageSlug' - 'proposalId')
                        || jsonb_build_object(
                             'detachedPackageSlug', r.package_slug,
                             'detachedProposalId', r.provisioning_proposal_id),
             updated_at = now()
       WHERE id = r.id;
      RAISE NOTICE '0308: workspace % detached from template "%" (key "%" detached too; an older space holds the template)',
        r.id, r.package_slug, r.provisioning_proposal_id;
    ELSE
      UPDATE workspaces
         SET package_slug = NULL,
             settings = (coalesce(settings, '{}'::jsonb) - 'packageSlug')
                        || jsonb_build_object('detachedPackageSlug', r.package_slug),
             updated_at = now()
       WHERE id = r.id;
      RAISE NOTICE '0308: workspace % detached from template "%" (an older space holds the template)',
        r.id, r.package_slug;
    END IF;
  END LOOP;

  -- 3. Backfill the provisioning key of active template spaces ---------------
  FOR r IN
    SELECT w.id, w.package_slug
      FROM workspaces w
     WHERE w.archived_at IS NULL
       AND w.package_slug IS NOT NULL
       AND w.provisioning_proposal_id IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM workspaces o
          WHERE o.provisioning_proposal_id = w.package_slug
       )
  LOOP
    UPDATE workspaces
       SET provisioning_proposal_id = r.package_slug,
           settings = coalesce(settings, '{}'::jsonb)
                      || jsonb_build_object('proposalId', r.package_slug)
     WHERE id = r.id;
    RAISE NOTICE '0308: workspace % keyed by its template "%"', r.id, r.package_slug;
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "workspaces_active_name_unique"
  ON "workspaces" (lower(btrim("name")))
  WHERE "archived_at" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "workspaces_active_package_slug_unique"
  ON "workspaces" ("package_slug")
  WHERE "package_slug" IS NOT NULL AND "archived_at" IS NULL;
