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
  ProfileRepository,
  ProfileResolutionService,
  ProfileScope,
  reconcileProposedProperties,
  type PropertyDecisionMap,
  type ReconciledKey,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import { createAndLinkPropertyDef } from "../profiles/create-and-link-property-def.js";

const logger = createLogger({ module: "reconcile-proposal-properties" });

/** Entity-column keys that live on the row, not the property bag — never a def. */
const RESERVED_KEYS: ReadonlySet<string> = new Set(["title"]);

/** `profiles.id` is a uuid column — anything else is a slug passed as an id. */
const PROFILE_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ReconcileApprovedPropertiesResult {
  /** The final property bag to write (remapped keys, refused keys dropped, new keys under their slug or verbatim fallback). */
  properties: Record<string, unknown> | undefined;
  /** Per-key classification detail (telemetry / logging). */
  reconciled: ReconciledKey[];
  /** Slugs of defs successfully created on the target kind during this approve. */
  createdDefSlugs: string[];
  /** Keys stored under the canonical row's slug because the resolved row was a twin that missed them. */
  lensMisses: Array<{ key: string; canonicalSlug: string }>;
}

/**
 * Reconcile a proposal's proposed properties against the target kind on approve.
 *
 * @param properties  The proposed property bag (verbatim). Undefined/empty is a no-op.
 * @param profileId   The target kind's profile id (the def owner), or `null` when
 *                    the kind did not resolve. A null or non-uuid id skips
 *                    reconciliation and stores the bag verbatim.
 * @param workspaceId The proposal's workspace (null = pod-wide → def creation skipped).
 * @param userId      The approver (owns the def-create caller context).
 * @param decisions   Optional per-field reviewer decisions (keyed by proposed key).
 */
export async function reconcileApprovedProperties(args: {
  properties: Record<string, unknown> | undefined;
  profileId: string | null;
  workspaceId: string | null;
  userId: string;
  decisions?: PropertyDecisionMap;
}): Promise<ReconcileApprovedPropertiesResult> {
  const { properties, profileId, workspaceId, userId, decisions } = args;

  if (!properties || Object.keys(properties).length === 0) {
    return { properties, reconciled: [], createdDefSlugs: [], lensMisses: [] };
  }

  // 0. Never reconcile against a slug passed where an id belongs. Callers used
  //    to hand `profile?.id ?? profileSlug` on a resolution miss; the slug then
  //    reached a uuid column (a Postgres cast error, caught below) and, had it
  //    got further, `propertyDefs.create`'s `z.string().uuid()`. Refuse it here,
  //    by name, for every caller.
  if (!profileId || !PROFILE_ID_RE.test(profileId)) {
    logger.warn(
      { profileId, workspaceId, keys: Object.keys(properties) },
      "reconcile: target profile did not resolve to an id — skipping def creation, storing properties verbatim"
    );
    return { properties, reconciled: [], createdDefSlugs: [], lensMisses: [] };
  }

  // 1. Effective property-def slugs of the target kind, through this ws lens —
  //    plus, when the resolved row is a workspace TWIN of a system/shared kind,
  //    the canonical row's slugs, so a key the twin's (often empty) schema
  //    misses folds onto the canonical field instead of minting a near-copy.
  const profileService = new ProfileResolutionService(db);
  const profileRepo = new ProfileRepository(db);
  let slugs: string[] = [];
  let canonicalSlugs: string[] | undefined;
  let twin: {
    profileSlug: string;
    twinProfileId: string;
    canonicalProfileId: string;
  } | null = null;
  try {
    const effective = await profileService.getEffectiveProperties(
      profileId,
      workspaceId
    );
    slugs = effective.map((p) => p.slug);

    const row = await profileRepo.getById(profileId);
    if (
      row &&
      row.scope !== ProfileScope.SYSTEM &&
      row.scope !== ProfileScope.SHARED
    ) {
      // No workspace and no user ⇒ getBySlug's pod-wide floor: SYSTEM/SHARED
      // rows only. Scoped to THIS kind's slug — never a pod-wide fold.
      const canonical = await profileRepo.getBySlug(row.slug);
      if (canonical && canonical.id !== row.id) {
        const canonicalEffective = await profileService.getEffectiveProperties(
          canonical.id,
          workspaceId
        );
        canonicalSlugs = canonicalEffective.map((p) => p.slug);
        twin = {
          profileSlug: row.slug,
          twinProfileId: row.id,
          canonicalProfileId: canonical.id,
        };
      }
    }
  } catch (err) {
    // A failed schema read is not an empty schema: minting defs against a
    // schema we could not read is exactly how near-duplicate fields appear.
    // Store verbatim.
    logger.warn(
      {
        profileId,
        workspaceId,
        err: err instanceof Error ? err.message : String(err),
      },
      "reconcile: could not load the target or canonical schema — storing verbatim"
    );
    return { properties, reconciled: [], createdDefSlugs: [], lensMisses: [] };
  }

  // 2. Pure classify + apply decisions.
  const result = reconcileProposedProperties({
    properties,
    slugs,
    decisions,
    reservedKeys: RESERVED_KEYS,
    canonicalSlugs,
  });

  // A lens miss is a signal, not a fix: the value lands on the canonical slug,
  // but the twin row that hid it is still there. Logged per key so the twin can
  // be found; diagnose's schema_contract section lists the twins themselves.
  for (const miss of result.lensMisses) {
    logger.warn(
      {
        event: "reconcile.lens_miss",
        profileSlug: twin?.profileSlug,
        twinProfileId: twin?.twinProfileId,
        canonicalProfileId: twin?.canonicalProfileId,
        workspaceId,
        key: miss.key,
        canonicalSlug: miss.canonicalSlug,
      },
      "reconcile: property key missed the workspace twin's schema and matched the canonical profile — stored under the canonical slug, no def created"
    );
  }

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
    lensMisses: result.lensMisses,
  };
}
