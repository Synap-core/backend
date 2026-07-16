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
 * The canonical definition comes from the PUBLISHED npm package (the backend is a
 * separate repo from synap-app), so the template a workspace converges to is
 * whatever version of `@synap-core/workspace-templates` this pod was built with.
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
 * sorted by `orderWorkspacesByTemplateDependencies`, which reads each template's
 * OWN declared `dependencies` — no domain slug is hardcoded here.
 */

import { createLogger } from "@synap-core/core";
import {
  getDb,
  workspaces,
  reconcileWorkspaceFromDefinition,
  type WorkspaceDefinitionInput,
} from "@synap/database";
import {
  getWorkspaceTemplate,
  toWorkspaceDefinition,
} from "@synap-core/workspace-templates";
import { orderWorkspacesByTemplateDependencies } from "@synap/api";

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

  // Resolve each row's declared subtype ONCE, then order deps-first so a
  // workspace whose template another depends on seeds shared pod-wide bases
  // before its consumers reconcile. Rows with no subtype / no template / caught
  // in a dependency cycle are all preserved — the sort never drops a row, so
  // this stays a full pass over every workspace exactly as before.
  const ordered = orderWorkspacesByTemplateDependencies(
    rows.map((ws) => ({
      ws,
      subtype: (ws.settings as { workspaceSubtype?: string } | null)
        ?.workspaceSubtype,
    })),
    getWorkspaceTemplate
  );

  for (const { ws, subtype } of ordered) {
    // No subtype (e.g. a bare "personal" workspace) or no canonical template for
    // it → nothing to converge to.
    if (!subtype || !getWorkspaceTemplate(subtype)) {
      skipped++;
      continue;
    }

    try {
      const { definition } = toWorkspaceDefinition(subtype);
      const report = await reconcileWorkspaceFromDefinition({
        workspaceId: ws.id,
        userId: ws.ownerId,
        definition: definition as unknown as WorkspaceDefinitionInput,
      });

      const changed =
        report.profiles.added.length +
        report.properties.added.length +
        report.entityLinks.added.length;

      if (changed > 0) {
        logger.info(
          {
            workspaceId: ws.id,
            subtype,
            profilesAdded: report.profiles.added,
            propertiesAdded: report.properties.added.length,
            entityLinksAdded: report.entityLinks.added.length,
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
