/**
 * reconcileWorkspacesToTemplates
 * ==============================
 *
 * Boot-time convergence: for every workspace whose stamped template identity
 * (`settings.packageSlug` → the promoted `package_slug` column →
 * `settings.workspaceSubtype`, in that order — see `templateKeyOf` below for
 * why the SLUG and not the subtype is the key) resolves to a canonical template
 * in `@synap-core/workspace-templates` (crm, content-studio, brand-library, …),
 * additively reconcile the live workspace to that template — creating any
 * missing profiles, workspace-overlay properties, and entity-link relation defs.
 *
 * A workspace with NO stamped identity is invisible to this pass by design —
 * the field that identifies it is the field that is missing. Recovering those
 * orphans is `backfill-workspace-identity.ts`'s job, behind an explicit opt-in;
 * this pass never infers.
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
      packageSlug: workspaces.packageSlug,
    })
    .from(workspaces);

  let reconciled = 0;
  let skipped = 0;
  let failed = 0;

  // ── Universal first-party defaults (the `base` template) ────────────────────
  // BEFORE the domain (subtype) pass below: reconcile EVERY workspace to the
  // first-party `base` template — the report automation + default commands +
  // relation defs. The subtype pass only reaches workspaces WITH a canonical
  // template (bare "personal" workspaces `continue` past it), so universal
  // operational defaults must ride their OWN subtype-independent pass. The
  // automation step is version-aware (a content-hash over base's flow), so this
  // converges a workspace frozen at an old seed version to base's CURRENT prompts
  // on the next boot, and is a cheap no-op once converged. This is what fixes the
  // seed-version freeze at deploy time (every boot syncs every workspace).
  const baseTemplate = await resolveWorkspaceTemplate("base");
  if (baseTemplate) {
    // ONLY base's operational carriers cross into existing workspaces — never its
    // workspace-shell fields. base declares `workspaceVisibility: "pod_visible"`
    // and the door's settings step OVERWRITES visibility/subtype unconditionally,
    // so its full definition would flip every workspace pod-visible and clobber
    // domain workspaces' template stamps. base is an operational OVERLAY (empty
    // profiles/views/home). No packageSlug/packageVersion: base is not any
    // workspace's template identity (the subtype pass below owns that stamp).
    const bd = baseTemplate.workspaceDefinition;
    const baseOperationalDefinition = {
      flowAutomations: bd.flowAutomations ?? [],
      commands: bd.commands ?? [],
      relationDefs: bd.relationDefs ?? [],
    } as unknown as WorkspaceDefinitionInput;
    let baseReconciled = 0;
    for (const ws of rows) {
      try {
        await reconcileWorkspaceFromDefinition({
          workspaceId: ws.id,
          userId: ws.ownerId,
          definition: baseOperationalDefinition,
        });
        baseReconciled++;
      } catch (err) {
        logger.warn(
          { err, workspaceId: ws.id },
          "Base-defaults reconcile failed (non-fatal)"
        );
      }
    }
    logger.info(
      { baseReconciled, total: rows.length, version: baseTemplate.version },
      "Universal base-defaults reconcile pass complete"
    );
  } else {
    logger.warn(
      "Base template unresolved — universal operational defaults NOT reconciled this boot"
    );
  }

  // Resolve each DISTINCT template key ONCE through the cache-first resolver (CP
  // catalog cache → frozen bundle). Async, so it can't run inside the pure
  // synchronous `orderWorkspacesByTemplateDependencies` lookup — pre-resolve
  // here, then feed the ordering a sync lookup backed by this map. A `null`
  // resolution (neither cache nor bundle knows the slug) matches the old
  // `!getWorkspaceTemplate(key)` skip exactly.
  //
  // ⚠️ THE KEY IS THE TEMPLATE SLUG, NOT THE SUBTYPE. This resolved by
  // `settings.workspaceSubtype` alone, which is wrong in BOTH directions
  // because `subtype` is not a template identity:
  //   • it is not injective — `crm` is the declared subtype of THREE bundled
  //     templates (crm, business-developer, networking), `research-base` of
  //     three, `brand-library`/`ecosystem`/`operations` of two each. A
  //     `business-developer` workspace stamped subtype "crm" resolved the
  //     `crm` template and converged to the WRONG schema;
  //   • it often is not a lookup key at all — 10 of 30 bundled templates have
  //     `workspace.subtype !== meta.slug` (`builder-workspace` declares
  //     subtype "builder"), and both `WORKSPACE_TEMPLATES` and
  //     `cp_catalog_cache` are keyed by SLUG, so `resolveWorkspaceTemplate`
  //     returned null and the workspace was skipped FOREVER.
  // `packageSlug` (JSONB, dual-written to the promoted `package_slug` column
  // by `mergeSettings`) IS that key on both resolution paths. Subtype stays as
  // the last fallback so a legacy row whose subtype happens to also be a
  // template slug keeps converging exactly as before — this only ever ADDS
  // resolvable rows, never redirects one that already resolved by slug.
  //
  // This stays STRICTLY a read of a stamp the workspace already earned. No
  // inference happens here by design: fingerprint-based identification lives
  // in `backfill-workspace-identity.ts`, behind an explicit opt-in, because a
  // silent mis-identification inside the boot reconciler would additively pour
  // the wrong template's profiles and views into a live workspace.
  const templateKeyOf = (ws: (typeof rows)[number]): string | undefined => {
    const settings = ws.settings as {
      packageSlug?: string;
      workspaceSubtype?: string;
    } | null;
    return (
      settings?.packageSlug ??
      ws.packageSlug ??
      settings?.workspaceSubtype ??
      undefined
    );
  };

  const resolvedByKey = new Map<string, ResolvedWorkspaceTemplate | null>();
  for (const ws of rows) {
    const key = templateKeyOf(ws);
    if (!key || resolvedByKey.has(key)) continue;
    resolvedByKey.set(key, await resolveWorkspaceTemplate(key));
  }

  // Sync lookup for the deps-first ordering, backed by the pre-resolved map.
  // Node identity lives in template-slug space (== the subtype); dependency
  // edges come from the RESOLVED template's own `dependencies` (freshest CP
  // graph on a cache hit, frozen-bundle graph offline).
  const lookupTemplate = (key: string) => {
    const resolved = resolvedByKey.get(key);
    if (!resolved) return undefined;
    return {
      meta: { slug: key },
      dependencies: resolved.dependencies.map((d) => ({ slug: d.slug })),
    };
  };

  // Order deps-first so a workspace whose template another depends on seeds
  // shared pod-wide bases before its consumers reconcile. Rows with no subtype /
  // no template / caught in a dependency cycle are all preserved — the sort
  // never drops a row, so this stays a full pass over every workspace.
  const ordered = orderWorkspacesByTemplateDependencies(
    rows.map((ws) => ({ ws, subtype: templateKeyOf(ws) })),
    lookupTemplate
  );

  for (const { ws, subtype: templateKey } of ordered) {
    // No subtype (e.g. a bare "personal" workspace) or no template resolves for
    // it (cache miss AND not in the frozen bundle) → nothing to converge to.
    const resolved = templateKey ? resolvedByKey.get(templateKey) : undefined;
    if (!templateKey || !resolved) {
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
        packageSlug: templateKey,
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
            templateKey,
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
        { err, workspaceId: ws.id, templateKey },
        "Workspace template reconcile failed (non-fatal)"
      );
    }
  }

  logger.info(
    { reconciled, skipped, failed, total: rows.length },
    "Workspace→template reconcile pass complete"
  );
}
