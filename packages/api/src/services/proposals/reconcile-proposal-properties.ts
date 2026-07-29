/**
 * Approve-side property reconciliation orchestrator.
 *
 * Wraps the PURE classify+apply core (`reconcileProposedProperties`,
 * @synap/database) with the two impure steps it cannot do itself:
 *   1. read the target kind's effective property-def slugs (this workspace's lens);
 *   2. create a property def for each genuinely-NEW kept field, through the
 *      CANONICAL door (`createAndLinkPropertyDef`) so the field becomes
 *      first-class / queryable / rendered.
 *
 * Called by the `entity/create` and `entity/update` approve executors BEFORE the
 * entity write. Best-effort by contract: if a def create fails (or is skipped —
 * pod-wide proposals have no workspace to create the def in), the value is STILL
 * stored verbatim under its original key. Reconciliation never loses data and
 * never aborts an approve — a human already approved the write.
 */

import {
  db,
  ProfileResolutionService,
  reconcileProposedProperties,
  type PropertyDecisionMap,
  type ReconciledKey,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import { createAndLinkPropertyDef } from "../profiles/create-and-link-property-def.js";

const logger = createLogger({ module: "reconcile-proposal-properties" });

/** Entity-column keys that live on the row, not the property bag — never a def. */
const RESERVED_KEYS: ReadonlySet<string> = new Set(["title"]);

export interface ReconcileApprovedPropertiesResult {
  /** The final property bag to write (remapped keys, refused keys dropped, new keys under their slug or verbatim fallback). */
  properties: Record<string, unknown> | undefined;
  /** Per-key classification detail (telemetry / logging). */
  reconciled: ReconciledKey[];
  /** Slugs of defs successfully created on the target kind during this approve. */
  createdDefSlugs: string[];
}

/**
 * Reconcile a proposal's proposed properties against the target kind on approve.
 *
 * @param properties  The proposed property bag (verbatim). Undefined/empty is a no-op.
 * @param profileId   The target kind's profile id (the def owner).
 * @param workspaceId The proposal's workspace (null = pod-wide → def creation skipped).
 * @param userId      The approver (owns the def-create caller context).
 * @param decisions   Optional per-field reviewer decisions (keyed by proposed key).
 */
export async function reconcileApprovedProperties(args: {
  properties: Record<string, unknown> | undefined;
  profileId: string;
  workspaceId: string | null;
  userId: string;
  decisions?: PropertyDecisionMap;
}): Promise<ReconcileApprovedPropertiesResult> {
  const { properties, profileId, workspaceId, userId, decisions } = args;

  if (!properties || Object.keys(properties).length === 0) {
    return { properties, reconciled: [], createdDefSlugs: [] };
  }

  // 1. Effective property-def slugs of the target kind, through this ws lens.
  const profileService = new ProfileResolutionService(db);
  let slugs: string[] = [];
  try {
    const effective = await profileService.getEffectiveProperties(
      profileId,
      workspaceId
    );
    slugs = effective.map((p) => p.slug);
  } catch (err) {
    // If we can't read the schema, fall back to today's behavior: store verbatim.
    logger.warn(
      {
        profileId,
        workspaceId,
        err: err instanceof Error ? err.message : String(err),
      },
      "reconcile: could not load effective properties — storing verbatim"
    );
    return { properties, reconciled: [], createdDefSlugs: [] };
  }

  // 2. Pure classify + apply decisions.
  const result = reconcileProposedProperties({
    properties,
    slugs,
    decisions,
    reservedKeys: RESERVED_KEYS,
  });

  // 3. Create a def for each new-kept field, best-effort. Pod-wide (no workspace)
  //    cannot create a def (createAndLinkPropertyDef runs a workspaceProcedure
  //    caller) — skip and fall back to verbatim for those keys.
  const createdDefSlugs: string[] = [];
  const failedDefSlugs = new Set<string>();
  const finalProps = { ...result.properties };

  if (result.defsToCreate.length > 0) {
    if (!workspaceId) {
      for (const def of result.defsToCreate) failedDefSlugs.add(def.slug);
      logger.info(
        { profileId, count: result.defsToCreate.length },
        "reconcile: pod-wide proposal — skipping def creation, storing new fields verbatim"
      );
    } else {
      for (const def of result.defsToCreate) {
        try {
          await createAndLinkPropertyDef({
            userId,
            workspaceId,
            profileId,
            slug: def.slug,
            valueType: def.valueType,
            // Profile-BASE def (overlay=false): SET slug / NULL workspace, so the
            // new field is first-class on the kind in every workspace, matching
            // "make it queryable/rendered", not scoped to just this workspace.
            overlay: false,
            uiHints: { label: def.label },
          });
          createdDefSlugs.push(def.slug);
        } catch (err) {
          failedDefSlugs.add(def.slug);
          logger.warn(
            {
              profileId,
              workspaceId,
              slug: def.slug,
              err: err instanceof Error ? err.message : String(err),
            },
            "reconcile: property-def create failed — storing field verbatim (no data loss)"
          );
        }
      }
    }
  }

  // 4. Verbatim fallback: any new key whose def creation was skipped/failed goes
  //    back under its ORIGINAL key so the value is never lost or silently renamed
  //    to an un-backed slug.
  if (failedDefSlugs.size > 0) {
    for (const r of result.reconciled) {
      if (r.createDef && r.finalSlug && failedDefSlugs.has(r.finalSlug)) {
        if (r.finalSlug !== r.key) delete finalProps[r.finalSlug];
        finalProps[r.key] = r.value;
      }
    }
  }

  return {
    properties: finalProps,
    reconciled: result.reconciled,
    createdDefSlugs,
  };
}
