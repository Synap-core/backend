/**
 * reconcileWorkspacesToTemplates
 * ==============================
 *
 * Boot-time convergence: for every workspace whose `settings.workspaceSubtype`
 * maps to a canonical template in `@synap-core/workspace-templates` (crm,
 * content-studio, brand-library, …), additively reconcile the live workspace to
 * that template — creating any missing profiles, workspace-overlay properties,
 * and entity-link relation defs.
 *
 * WHY THIS EXISTS: workspace schema updates used to depend on a specific frontend
 * app loading in a browser (the CRM app's client-side `reconcileCrmSchema`). That
 * meant a template change (e.g. adding the `partner` profile) never reached a
 * workspace unless someone opened that one app. This hook makes the update
 * SERVER-SIDE and deterministic: every pod boot (i.e. every deploy) syncs all
 * workspaces to their canonical templates, no frontend required.
 *
 * The canonical definition comes from the CACHE-FIRST resolver
 * (`resolveWorkspaceTemplate`): a template edited/published on the Control Plane
 * lands in `cp_catalog_cache` (synced every 10 min) and converges here on the
 * NEXT boot — no Docker redeploy required. On any cache miss / CP-down the
 * resolver falls back to the frozen `@synap-core/workspace-templates` bundle the
 * pod was built with, so an OFFLINE boot is BYTE-IDENTICAL to reading the bundle
 * directly (what this hook did before). This is the SAME door
 * `reconcileWorkspaceIfStale` already uses for the runtime version-aware sync.
 *
 * Idempotent + additive + non-fatal:
 *  - `reconcileWorkspaceFromDefinition` only CREATES what's missing; it never
 *    mutates or deletes live profiles/properties (type mismatches are reported as
 *    conflicts and left untouched).
 *  - A failure on one workspace is logged and skipped — it never blocks boot.
 *
 * ORDER MATTERS — DEPS FIRST. A `scope: shared` profile is ONE pod-wide row, and
 * whichever template reaches it first seeds its base body (later templates only
 * add workspace overlays). This pass used to iterate an unordered SELECT, so a
 * pod holding `marketing-campaign` + `ecosystem` with no pod-wide `lead` row yet
 * could reconcile marketing first and seed the shared `lead` base from marketing's
 * body instead of foundation's SSOT body — every later workspace then granting
 * onto the wrong base. The install path never had this hole
 * (`resolvePackageDependencies` walks deps-first); this one did. Rows are now
 * sorted by `orderWorkspacesByTemplateDependencies`, which reads each RESOLVED
 * template's OWN declared `dependencies` (from the same cache-first resolver) —
 * no domain slug is hardcoded here.
 */

import { createLogger } from "@synap-core/core";
import {
  getDb,
  workspaces,
  reconcileWorkspaceFromDefinition,
  type WorkspaceDefinitionInput,
} from "@synap/database";
import {
  orderWorkspacesByTemplateDependencies,
  resolveWorkspaceTemplate,
  type ResolvedWorkspaceTemplate,
} from "@synap/api";

const logger = createLogger({ module: "reconcile-workspaces-to-templates" });

export async function reconcileWorkspacesToTemplates(): Promise<void> {
  const db = await getDb();

  const rows = await db
    .select({
      id: workspaces.id,
      ownerId: workspaces.ownerId,
      settings: workspaces.settings,
    })
    .from(workspaces);

  let reconciled = 0;
  let skipped = 0;
  let failed = 0;

  // Resolve each DISTINCT subtype ONCE through the cache-first resolver (CP
  // catalog cache → frozen bundle). Async, so it can't run inside the pure
  // synchronous `orderWorkspacesByTemplateDependencies` lookup — pre-resolve
  // here, then feed the ordering a sync lookup backed by this map. A `null`
  // resolution (neither cache nor bundle knows the slug) matches the old
  // `!getWorkspaceTemplate(subtype)` skip exactly.
  const subtypeOf = (ws: (typeof rows)[number]): string | undefined =>
    (ws.settings as { workspaceSubtype?: string } | null)?.workspaceSubtype ??
    undefined;

  const resolvedBySubtype = new Map<string, ResolvedWorkspaceTemplate | null>();
  for (const ws of rows) {
    const subtype = subtypeOf(ws);
    if (!subtype || resolvedBySubtype.has(subtype)) continue;
    resolvedBySubtype.set(subtype, await resolveWorkspaceTemplate(subtype));
  }

  // Sync lookup for the deps-first ordering, backed by the pre-resolved map.
  // Node identity lives in template-slug space (== the subtype); dependency
  // edges come from the RESOLVED template's own `dependencies` (freshest CP
  // graph on a cache hit, frozen-bundle graph offline).
  const lookupTemplate = (subtype: string) => {
    const resolved = resolvedBySubtype.get(subtype);
    if (!resolved) return undefined;
    return {
      meta: { slug: subtype },
      dependencies: resolved.dependencies.map((d) => ({ slug: d.slug })),
    };
  };

  // Order deps-first so a workspace whose template another depends on seeds
  // shared pod-wide bases before its consumers reconcile. Rows with no subtype /
  // no template / caught in a dependency cycle are all preserved — the sort
  // never drops a row, so this stays a full pass over every workspace.
  const ordered = orderWorkspacesByTemplateDependencies(
    rows.map((ws) => ({ ws, subtype: subtypeOf(ws) })),
    lookupTemplate
  );

  for (const { ws, subtype } of ordered) {
    // No subtype (e.g. a bare "personal" workspace) or no template resolves for
    // it (cache miss AND not in the frozen bundle) → nothing to converge to.
    const resolved = subtype ? resolvedBySubtype.get(subtype) : undefined;
    if (!subtype || !resolved) {
      skipped++;
      continue;
    }

    try {
      // STAMP-ON-WRITE: pass the slug+version this pass is converging TO, so
      // `settings.packageVersion` advances in lockstep with the content it
      // reconciled. Before this, the boot sweep reconciled content but left the
      // stamp untouched — so `settings.packageVersion` lied (a workspace could
      // read "stale/unknown" while its content was current). This is now the
      // SINGLE stamp-on-reconcile authority for the JSONB `settings.packageSlug`
      // /`packageVersion` the drift surfaces (Hub `/workspaces`, CLI, browser)
      // read; the old column-keyed `package-version-backfill` worker (which
      // stamped a version it never reconciled) has been removed. `subtype` is
      // the resolved template slug this pass operates on (its own contract);
      // `reconcileWorkspaceFromDefinition` only writes these when present.
      const report = await reconcileWorkspaceFromDefinition({
        workspaceId: ws.id,
        userId: ws.ownerId,
        definition:
          resolved.workspaceDefinition as unknown as WorkspaceDefinitionInput,
        packageSlug: subtype,
        packageVersion: resolved.version,
      });

      const changed =
        report.profiles.added.length +
        report.properties.added.length +
        report.entityLinks.added.length +
        report.home.blocksAdded.length +
        report.layout.sidebarItemsAdded.length +
        Number(report.layout.primarySurfaceChanged);

      if (changed > 0) {
        logger.info(
          {
            workspaceId: ws.id,
            subtype,
            source: resolved.source,
            version: resolved.version,
            profilesAdded: report.profiles.added,
            propertiesAdded: report.properties.added.length,
            entityLinksAdded: report.entityLinks.added.length,
            primarySurfaceChanged: report.layout.primarySurfaceChanged,
            propertyConflicts: report.properties.conflicts,
          },
          "Workspace reconciled to canonical template"
        );
      }
      reconciled++;
    } catch (err) {
      failed++;
      logger.warn(
        { err, workspaceId: ws.id, subtype },
        "Workspace template reconcile failed (non-fatal)"
      );
    }
  }

  logger.info(
    { reconciled, skipped, failed, total: rows.length },
    "Workspace→template reconcile pass complete"
  );
}
