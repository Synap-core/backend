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

  for (const ws of rows) {
    const subtype = (ws.settings as { workspaceSubtype?: string } | null)
      ?.workspaceSubtype;

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
