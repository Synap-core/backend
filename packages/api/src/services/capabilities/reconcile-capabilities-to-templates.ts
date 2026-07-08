/**
 * reconcileCapabilitiesToTemplates
 * =================================
 *
 * Boot-time (+ on-demand) convergence: for every installed capability CONTAINER
 * (the `capabilities` table — pod-wide and workspace-scoped), additively
 * re-project its member skills from the current Control-Plane template when
 * the template has drifted since it was installed.
 *
 * WHY THIS EXISTS: a capability template fix (e.g. the `calendar_list`
 * `baseUrlOverride` correction) used to only reach a pod that re-ran the
 * install flow by hand. This is the CAPABILITY-layer counterpart to
 * `reconcileWorkspacesToTemplates` (apps/api/src/startup — converges workspaces
 * to their canonical `@synap-core/workspace-templates` package) — same shape,
 * same guarantees, applied to `@synap/playbooks` `CapabilityDefinition`s
 * instead. Lives in `@synap/api` (not apps/api/src/startup, unlike its
 * workspace counterpart) because it has TWO callers that both need the engine:
 * the apps/api boot hook AND the Hub REST `POST /capabilities/reconcile`
 * trigger below in `rest/capabilities.ts` — and apps/api cannot be imported
 * back by packages/api.
 *
 * Idempotent + additive + non-fatal:
 *  - Convergence is applied ONLY through the GOVERNED
 *    `createCapabilityFromDefinition` door — the same applier a manual
 *    `cap apply`/`cap install` uses. It never deletes a member and never
 *    touches a skill whose name isn't declared by the definition (a user's own
 *    custom-named skill is left alone); a skill it DOES own (matched by name)
 *    is re-projected to the template's canonical fields — exactly the
 *    self-healing behavior `ensureSynapCoreCapability` already relies on.
 *  - A failure re-applying ONE container (a missing required param, a
 *    permission/governance rejection, a network blip) is caught, reported as a
 *    CONFLICT, and never blocks another container or boot.
 *  - `dryRun: true` computes the full report without writing anything.
 */

import { createLogger } from "@synap-core/core";
import { db, eq, and, inArray } from "@synap/database";
import {
  capabilities,
  skills,
  links,
  capabilityTemplateCache,
} from "@synap/database/schema";
import type { CapabilityDefinition } from "@synap/playbooks";

import {
  loadCapabilityTemplate,
  createCapabilityFromDefinition,
} from "./create-from-definition.js";
import {
  capabilityDefinitionDrift,
  type InstalledSkillRow,
} from "./capability-drift.js";
import type { Context } from "../../types/context.js";

const logger = createLogger({ module: "reconcile-capabilities-to-templates" });

export interface CapabilityReconcileEntry {
  containerId: string;
  name: string;
  templateKey?: string;
  reason: string;
}

export interface CapabilityReconcileReport {
  checked: number;
  dryRun: boolean;
  /** Re-applied (or, in dryRun, WOULD re-apply) to converge drift. */
  applied: CapabilityReconcileEntry[];
  /** Nothing to do — up to date, or unresolvable (no template key / no cache hit). */
  skipped: CapabilityReconcileEntry[];
  /** Drift detected but the template's `updatePolicy:"notify"` defers to a human. */
  updatesAvailable: CapabilityReconcileEntry[];
  /** Drift detected but re-apply could not safely resolve it (e.g. a required
   *  param the reconcile has no value for) — reported, never forced. */
  conflicts: CapabilityReconcileEntry[];
}

/** Read-modify-write merge of a container's `metadata` jsonb (never clobbers). */
async function stampContainerMetadata(
  containerId: string,
  currentMetadata: Record<string, unknown>,
  templateKey: string,
  contentHash: string | undefined
): Promise<void> {
  await db
    .update(capabilities)
    .set({
      metadata: {
        ...currentMetadata,
        templateKey,
        ...(contentHash ? { contentHash } : {}),
      },
      updatedAt: new Date(),
    })
    .where(eq(capabilities.id, containerId));
}

/** Build the acting Context for a governed re-apply of ONE container. Mirrors
 * `ensureSynapCoreCapability`'s inline operator ctx: attribute the write to the
 * container's own creator, scoped to its own workspace (null = pod-wide). */
function buildContainerCtx(container: {
  createdBy: string;
  workspaceId: string | null;
}): Context {
  return {
    db,
    authenticated: true,
    userId: container.createdBy,
    workspaceId: container.workspaceId,
    workspaceRole: "owner",
  } as unknown as Context;
}

export async function reconcileCapabilitiesToTemplates(
  opts: {
    dryRun?: boolean;
    containerIds?: string[];
    /**
     * Apply `updatePolicy:"notify"` drift too (default false → defer it to a
     * human). The operator Apply door sets this true: clicking "Apply updates"
     * IS the human consent that the notify policy defers to, so those updates
     * must actually land. (Param-requiring templates still can't be applied
     * with `{}` and stay in `updatesAvailable`.)
     */
    applyNotifyPolicy?: boolean;
  } = {}
): Promise<CapabilityReconcileReport> {
  const dryRun = !!opts.dryRun;
  const report: CapabilityReconcileReport = {
    checked: 0,
    dryRun,
    applied: [],
    skipped: [],
    updatesAvailable: [],
    conflicts: [],
  };

  // An explicit empty `containerIds` means "reconcile NOTHING" — distinct from
  // `undefined` ("reconcile everything"). Return the empty report rather than
  // silently falling through to a full pod-wide reconcile (a landmine for a
  // future "apply selected" caller).
  if (opts.containerIds && opts.containerIds.length === 0) {
    return report;
  }

  // `containerIds` NARROWS which containers are enumerated (the operator Apply
  // door scoping to a named subset) — the per-container convergence logic below
  // is unchanged; this only picks WHICH containers it runs over.
  const containers =
    opts.containerIds && opts.containerIds.length > 0
      ? await db
          .select()
          .from(capabilities)
          .where(inArray(capabilities.id, opts.containerIds))
      : await db.select().from(capabilities);
  const cacheRows = await db
    .select({
      key: capabilityTemplateCache.key,
      name: capabilityTemplateCache.name,
    })
    .from(capabilityTemplateCache);
  // Legacy-install backfill index: match an installed container's NAME against a
  // cached template's name when `metadata.templateKey` is absent (a container
  // seeded before this reconcile existed).
  const cacheKeyByName = new Map(
    cacheRows.map((r) => [r.name.toLowerCase(), r.key])
  );

  for (const container of containers) {
    report.checked++;
    try {
      const metadata = (container.metadata ?? {}) as Record<string, unknown>;
      const storedTemplateKey =
        typeof metadata.templateKey === "string"
          ? metadata.templateKey
          : undefined;
      const storedContentHash =
        typeof metadata.contentHash === "string"
          ? metadata.contentHash
          : undefined;

      let templateKey = storedTemplateKey;
      let backfilled = false;
      if (!templateKey) {
        const matched = cacheKeyByName.get(container.name.toLowerCase());
        if (matched) {
          templateKey = matched;
          backfilled = true;
        }
      }
      if (!templateKey) {
        report.skipped.push({
          containerId: container.id,
          name: container.name,
          reason:
            "no template key resolvable (legacy install, no name match in the template cache)",
        });
        continue;
      }

      let cachedDef: CapabilityDefinition;
      try {
        cachedDef = await loadCapabilityTemplate(templateKey);
      } catch (loadErr) {
        // Could be a genuine "not in the catalog" (e.g. an in-repo capability
        // like synap-core that has no CP template) OR a transient failure (CP
        // unreachable, malformed cache row). Surface the REAL reason — don't
        // relabel every failure as "not found", which misleads on-call.
        const msg =
          loadErr instanceof Error ? loadErr.message : String(loadErr);
        logger.warn(
          { err: loadErr, containerId: container.id, templateKey },
          "Capability reconcile: template load failed — skipping this container"
        );
        report.skipped.push({
          containerId: container.id,
          name: container.name,
          templateKey,
          reason: `template load failed: ${msg}`,
        });
        continue;
      }

      // FAST PATH: both sides carry a contentHash and they match → no drift,
      // skip the structural diff entirely. A backfilled key has no prior stored
      // hash, so it always falls through to the structural diff below (which
      // also lets us stamp provenance the first time, even with zero drift).
      if (
        !backfilled &&
        cachedDef.contentHash &&
        storedContentHash &&
        cachedDef.contentHash === storedContentHash
      ) {
        report.skipped.push({
          containerId: container.id,
          name: container.name,
          templateKey,
          reason: "up to date (contentHash match)",
        });
        continue;
      }

      const memberSkillLinks = await db
        .select({ fromId: links.fromId })
        .from(links)
        .where(
          and(
            eq(links.toType, "capability"),
            eq(links.toId, container.id),
            eq(links.linkType, "member_of"),
            eq(links.fromType, "skill")
          )
        );
      const memberSkillIds = memberSkillLinks.map((l) => l.fromId);
      const installedSkills: InstalledSkillRow[] =
        memberSkillIds.length > 0
          ? await db
              .select({
                name: skills.name,
                providerSpec: skills.providerSpec,
                parameters: skills.parameters,
                code: skills.code,
                description: skills.description,
              })
              .from(skills)
              .where(inArray(skills.id, memberSkillIds))
          : [];

      const drift = capabilityDefinitionDrift(installedSkills, cachedDef);
      const hasDrift = drift.missing.length > 0 || drift.drifted.length > 0;

      if (!hasDrift) {
        // Nothing to converge, but a legacy container may still be missing
        // provenance (backfilled key) or a stale hash — stamp it directly (no
        // skills/tools touched, so no need to go through the applier).
        if (
          !dryRun &&
          (backfilled || cachedDef.contentHash !== storedContentHash)
        ) {
          await stampContainerMetadata(
            container.id,
            metadata,
            templateKey,
            cachedDef.contentHash
          );
        }
        report.skipped.push({
          containerId: container.id,
          name: container.name,
          templateKey,
          reason: "no drift",
        });
        continue;
      }

      const updatePolicy = cachedDef.updatePolicy ?? "auto";
      const driftReason = `missing=[${drift.missing.join(",")}] drifted=[${drift.drifted.join(",")}]`;

      // A template that carries `{{param}}` in a skill NAME needs install-time
      // params the reconcile doesn't have — re-projecting it with `{}` would
      // interpolate the placeholder to a blank and mint a junk skill. Never
      // auto-apply these; surface them for a human to re-apply WITH params.
      // Paramless declarative templates (nango-google etc.) are unaffected —
      // the common reconcile case. (Surfaced by dogfooding: generic-apikey.)
      const needsInstallParams = (cachedDef.skills ?? []).some(
        (s) => typeof s.name === "string" && s.name.includes("{{")
      );
      if (needsInstallParams) {
        report.updatesAvailable.push({
          containerId: container.id,
          name: container.name,
          templateKey,
          reason: `${driftReason} — manual re-apply needed (template uses install-time params in skill names)`,
        });
        continue;
      }

      if (updatePolicy === "notify" && !opts.applyNotifyPolicy) {
        report.updatesAvailable.push({
          containerId: container.id,
          name: container.name,
          templateKey,
          reason: driftReason,
        });
        continue;
      }

      if (dryRun) {
        report.applied.push({
          containerId: container.id,
          name: container.name,
          templateKey,
          reason: `would reconcile: ${driftReason}`,
        });
        continue;
      }

      // Re-apply through the GOVERNED, add-only door. `createCapabilityFromDefinition`
      // reuses the existing container + tools, and for skills matched BY NAME
      // re-projects the template-owned fields (never touches a skill the
      // template doesn't declare). A throw here (e.g. a required param this
      // reconcile has no value for) is a genuine "can't safely resolve" —
      // reported as a conflict, not forced.
      await createCapabilityFromDefinition(
        cachedDef,
        {},
        buildContainerCtx({
          createdBy: container.createdBy,
          workspaceId: container.workspaceId,
        })
      );
      await stampContainerMetadata(
        container.id,
        metadata,
        templateKey,
        cachedDef.contentHash
      );
      report.applied.push({
        containerId: container.id,
        name: container.name,
        templateKey,
        reason: `reconciled: ${driftReason}`,
      });
    } catch (err) {
      report.conflicts.push({
        containerId: container.id,
        name: container.name,
        reason: err instanceof Error ? err.message : "unknown error",
      });
      logger.warn(
        { err, containerId: container.id, name: container.name },
        "Capability reconcile failed for this container (non-fatal)"
      );
    }
  }

  logger.info(
    {
      dryRun,
      checked: report.checked,
      applied: report.applied.length,
      skipped: report.skipped.length,
      updatesAvailable: report.updatesAvailable.length,
      conflicts: report.conflicts.length,
    },
    "Capability→template reconcile pass complete"
  );

  return report;
}
