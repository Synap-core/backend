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
import { db, eq, and, inArray, drizzleSql } from "@synap/database";
import { capabilities, skills, tools, links } from "@synap/database/schema";
import type { ToolVerbCatalogEntry } from "@synap/database/schema";
import type { CapabilityDefinition } from "@synap/playbooks";

import { queryCatalogCache } from "./catalog-cache-query.js";
import {
  loadCapabilityTemplate,
  createCapabilityFromDefinition,
  deriveToolVerbs,
  GRANT_DEFAULT_EXEC_MODE,
} from "./create-from-definition.js";
import {
  capabilityDefinitionDrift,
  capabilityVerbCatalogDrift,
  DRIFT_COMPARATOR_VERSION,
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

/**
 * Diff a definition's declared tool NAMES against the tool names that are
 * actually `member_of` the container (matched by name, same convention as
 * `capabilityDefinitionDrift`'s skill diff — a tool has no separate
 * content-drift concept here, only presence-as-a-member).
 *
 * WHY THIS EXISTS: `capability-containers.addPart` carries a pod-scope
 * authorization floor (container's own `createdBy` or a pod admin, for a
 * `workspaceId: null` container). `create-from-definition.ts`'s `attachPart`
 * calls it but SWALLOWS a rejection (non-fatal, counted as
 * `partsNotAttached`) — so when a non-owning teammate applies a template
 * update that introduces a NEW tool to an ALREADY-EXISTING pod-scoped
 * container, the tool row gets created but never attached: it exists with no
 * `member_of` edge. `capabilityDefinitionDrift` only diffs skills, so that
 * orphan was previously invisible to reconcile entirely. A member-less tool
 * is not cosmetic — `uninstall-capability.ts` and this same reconcile both
 * resolve a container's parts VIA `member_of`, so an orphan is left behind on
 * uninstall and can shadow a re-installed capability's pod-wide tool.
 *
 * A tool name carrying an unresolved `{{param}}` placeholder is skipped for
 * the same reason `capabilityDefinitionDrift` skips templated skill names:
 * the live row's name was interpolated at install with params this reconcile
 * doesn't have, so it can never be matched by exact name here.
 */
export function missingToolMemberships(
  declaredTools: Array<{ name: string }>,
  memberToolNames: Set<string>
): string[] {
  const missing: string[] = [];
  for (const t of declaredTools) {
    if (typeof t.name !== "string" || t.name.includes("{{")) continue;
    if (!memberToolNames.has(t.name)) missing.push(t.name);
  }
  return missing;
}

/**
 * Read-modify-write merge of a container's `metadata` jsonb. The TEMPLATE WINS
 * on any key it declares — deliberately, and opposite to the tool-metadata
 * merge in `create-from-definition.ts` (`mergePreservingExisting`, existing
 * wins). The two hold different things: a tool's metadata carries RUNTIME
 * state a re-apply must not stomp, while a container's carries the template's
 * DECLARED config, which the template owns. Keys the template does not
 * declare are preserved.
 * `defMetadata` carries the template's declared container-level config (e.g.
 * `mode`) — merging it here (not just on a full re-apply) is what lets an
 * already-installed capability pick up a template's newly-declared `mode` on
 * the very next reconcile, even when nothing else drifted (a metadata-only
 * template edit changes `contentHash`, which alone triggers this stamp — see
 * the "no drift" call site). The stamp also carries the comparator version that
 * cleared it, which is what keeps the fast path from trusting a verdict a newer
 * comparator would not have reached.
 */
async function stampContainerMetadata(
  containerId: string,
  currentMetadata: Record<string, unknown>,
  templateKey: string,
  contentHash: string | undefined,
  defMetadata?: Record<string, unknown>
): Promise<void> {
  await db
    .update(capabilities)
    .set({
      metadata: {
        ...currentMetadata,
        ...(defMetadata ?? {}),
        templateKey,
        // The hash is never stamped alone: it only means "this container is
        // clean at this template version AS JUDGED BY comparator vN", and the
        // fast path below honours it only for the CURRENT N. See
        // DRIFT_COMPARATOR_VERSION for the miss this prevents.
        ...(contentHash
          ? { contentHash, comparatorVersion: DRIFT_COMPARATOR_VERSION }
          : {}),
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
  // Legacy-install backfill index: match an installed container's NAME against a
  // cached template's name when `metadata.templateKey` is absent (a container
  // seeded before this reconcile existed). Reads the capability catalog from
  // `cp_catalog_cache` (kind="capability"), where a row's `slug` IS the template
  // key — the same cache the cache-first resolver serves from.
  const cacheRows = await queryCatalogCache({ kind: "capability" });
  const cacheKeyByName = new Map(
    cacheRows.map((r) => [r.name.toLowerCase(), r.slug])
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
      // Absent on any container stamped before the comparator was versioned —
      // which is exactly a container whose stamp we must not trust.
      const storedComparatorVersion =
        typeof metadata.comparatorVersion === "number"
          ? metadata.comparatorVersion
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

      // FAST PATH: both sides carry a contentHash, they match, AND the stamp was
      // written by the comparator running now → no drift, skip the structural
      // diff entirely. A backfilled key has no prior stored hash, so it always
      // falls through to the structural diff below (which also lets us stamp
      // provenance the first time, even with zero drift).
      //
      // The comparator-version clause is what makes the skip earned rather than
      // self-certifying: a stamp written by a comparator that could not see a
      // field (`intent`) is not evidence about that field, so teaching the
      // comparator retires every stamp it wrote and each container is re-diffed
      // once. Without it, a template field added after install could never reach
      // an already-installed pod.
      if (
        !backfilled &&
        cachedDef.contentHash &&
        storedContentHash &&
        cachedDef.contentHash === storedContentHash &&
        storedComparatorVersion === DRIFT_COMPARATOR_VERSION
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
              // Every column `PROJECTED_SKILL_FIELDS` compares — a column the
              // comparator reads but the select omits is `undefined` on every
              // row, i.e. a diff that silently can never fire.
              .select({
                name: skills.name,
                providerSpec: skills.providerSpec,
                parameters: skills.parameters,
                code: skills.code,
                description: skills.description,
                kind: skills.kind,
                scope: skills.scope,
                category: skills.category,
                agentTypes: skills.agentTypes,
                executionMode: skills.executionMode,
                timeoutSeconds: skills.timeoutSeconds,
                // PROJECTED_SKILL_FIELDS.metadata reads `allowedHosts` out of this
                // bag. Omit the column and it is `undefined` on every row — a
                // declared egress allowlist would then never be seen as drift.
                metadata: skills.metadata,
              })
              .from(skills)
              .where(inArray(skills.id, memberSkillIds))
          : [];

      const drift = capabilityDefinitionDrift(installedSkills, cachedDef);

      // Batched membership repair check — ONE query per container (never per
      // part): which of this container's TOOL members (by name) does the
      // template declare that the `member_of` graph doesn't actually have?
      // See `missingToolMemberships` above for why this is a distinct check
      // from `capabilityDefinitionDrift` (skills only, content not presence).
      const memberToolRows = await db
        // `capabilities` = the stored verb catalog, compared below against what
        // `deriveToolVerbs` projects (the surface `intent` actually lands on).
        .select({ name: tools.name, capabilityCatalog: tools.capabilities })
        .from(links)
        // `tools.id` is uuid, `links.fromId` is text — same cast trap
        // `loadContainerRefs` (capability-registry.ts) documents for
        // `capabilityContainers.id` vs `links.toId`; an uncast column-to-column
        // `eq` between the two types is a Postgres runtime error, not a TS one.
        .innerJoin(tools, eq(drizzleSql`${tools.id}::text`, links.fromId))
        .where(
          and(
            eq(links.toType, "capability"),
            eq(links.toId, container.id),
            eq(links.linkType, "member_of"),
            eq(links.fromType, "tool")
          )
        );
      const missingTools = missingToolMemberships(
        cachedDef.tools ?? [],
        new Set(memberToolRows.map((r) => r.name))
      );

      // Verb-catalog drift — the definition's skills also project onto the
      // requiring TOOL's `capabilities` jsonb, and some fields (`intent`, the
      // routing axis) land ONLY there. Projected with the applier's own
      // `deriveToolVerbs` at the same `govDefault` a re-apply would write, so
      // the diff and the convergence can never disagree. A template declaring
      // an unknown intent makes this throw — caught by the per-container catch
      // below and reported as a conflict, which is the honest outcome.
      const projectedVerbs = new Map<string, ToolVerbCatalogEntry[]>();
      for (const t of cachedDef.tools ?? []) {
        if (typeof t.name !== "string") continue;
        const verbs = deriveToolVerbs(
          t.name,
          cachedDef.skills ?? [],
          GRANT_DEFAULT_EXEC_MODE
        );
        if (verbs.length > 0) projectedVerbs.set(t.name, verbs);
      }
      const catalogDrift = capabilityVerbCatalogDrift(
        memberToolRows,
        projectedVerbs
      );

      const hasDrift =
        drift.missing.length > 0 ||
        drift.drifted.length > 0 ||
        missingTools.length > 0 ||
        catalogDrift.drifted.length > 0;

      if (!hasDrift) {
        // Nothing to converge, but a legacy container may still be missing
        // provenance (backfilled key) or a template-declared `metadata` key —
        // stamp those directly (no skills/tools touched, so no need to go
        // through the applier).
        //
        // The hash stamped here is a CLEAN-DIFF claim, not a convergence one —
        // `stampContainerMetadata` records the comparator version alongside it
        // so the fast path can tell the two apart from a later comparator's
        // point of view. Re-stamp also when only the version is stale, so a
        // container re-diffed after a comparator bump does not re-diff forever.
        if (
          !dryRun &&
          (backfilled ||
            cachedDef.contentHash !== storedContentHash ||
            // Only meaningful where a hash is actually stamped — a hash-less
            // template stamps no version either, and must not re-write on
            // every boot chasing one.
            (!!cachedDef.contentHash &&
              storedComparatorVersion !== DRIFT_COMPARATOR_VERSION))
        ) {
          await stampContainerMetadata(
            container.id,
            metadata,
            templateKey,
            cachedDef.contentHash,
            cachedDef.metadata
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
      const driftReason = `missing=[${drift.missing.join(",")}] drifted=[${drift.drifted.join(",")}]${missingTools.length > 0 ? ` missingToolMembership=[${missingTools.join(",")}]` : ""}${catalogDrift.drifted.length > 0 ? ` verbCatalogDrift=[${catalogDrift.drifted.join(",")}]` : ""}`;

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
        cachedDef.contentHash,
        cachedDef.metadata
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
