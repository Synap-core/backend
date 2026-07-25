/**
 * resolvePropertyTargetProfiles
 *
 * ONE door, shared by BOTH provisioning doors (`createWorkspaceFromDefinition`
 * and `reconcileWorkspaceFromDefinition`), that turns a template's authored
 * `properties[].targetProfileSlug` into the `property_defs.target_profile_id`
 * FK the UI actually reads.
 *
 * Why this exists: both doors merged `targetProfileSlug` into the def's
 * `constraints` JSONB and stopped there. But the entity picker constrains its
 * search on `uiHints.linkedProfileSlug`, and that key is derived ONLY from
 * `target_profile_id` (`ProfileResolutionService.resolveLinkTargets()`), which
 * was written by exactly one hardcoded 4-entry seeder
 * (`seed-property-relation-mappings.ts`). Net effect: every `entity_id` property
 * provisioned from a template rendered an UNCONSTRAINED picker listing every
 * entity in the workspace. The slug in `constraints` is NOT removed — the Hub
 * discover route reads both keys — this is purely additive.
 *
 * Runs as a SECOND PASS, after the whole profile loop, on purpose:
 *
 *   • Ordering. A property may target a profile declared LATER in the same
 *     `definition.profiles` array; resolving inline would silently leave those
 *     NULL depending on authoring order.
 *   • Backfill. The reconcile door `continue`s past a property that already
 *     exists, so an inline resolve could never reach a def created before this
 *     code landed. A second pass looks defs up by slug, so it fills pre-existing
 *     rows too — which is what makes a live pod converge at boot.
 *
 * NON-FATAL by design, matching the discipline of the surrounding provisioning
 * code (an unresolvable `require` dependency never throws; an unresolvable
 * entityLink is a soft `report.entityLinks.unresolved` entry). A target that
 * cannot be resolved — because the profile is owned by a template that is not
 * installed, or is `shared` without a `profile_workspace_access` grant for this
 * workspace — leaves `target_profile_id` NULL (exactly today's behaviour) and is
 * recorded in `unresolved` with a reason. Nothing throws.
 *
 * IDEMPOTENT. Reconcile runs at EVERY POD BOOT. This pass only ever writes a def
 * whose `target_profile_id` is currently NULL, so a re-run is a pure read; and it
 * never overwrites a value an operator (or the legacy seeder) already set.
 */

import type { PropertyDef } from "../schema/property-defs.js";
import type { ProfileRepository } from "../repositories/profile-repository.js";
import type { PropertyDefRepository } from "../repositories/property-def-repository.js";
import type { WorkspaceDefinitionInput } from "./create-workspace-from-definition.js";

/** Why a declared `targetProfileSlug` did not become a `target_profile_id`. */
export type PropertyTargetUnresolvedReason =
  /** The owning profile never entered `profileMap` (kind conflict → skipped). */
  | "owner-profile-unresolved"
  /** The target slug resolves to no profile visible in this workspace's lens. */
  | "target-profile-unresolved"
  /** No property-def with this slug exists on the owning profile. */
  | "property-def-not-found"
  /** The live def is not an `entity_id` — a target would be meaningless. */
  | "property-not-entity-id"
  /** Reading the live def failed (transient) — retried on the next reconcile. */
  | "read-failed"
  /** The def resolved but the UPDATE failed — retried on the next reconcile. */
  | "write-failed";

export interface PropertyTargetEntry {
  profile: string;
  slug: string;
  targetProfileSlug: string;
}

export interface PropertyTargetResolutionReport {
  /** Defs whose NULL `target_profile_id` was filled in by this pass. */
  set: PropertyTargetEntry[];
  /** Declared targets left NULL — non-fatal, surfaced rather than swallowed. */
  unresolved: Array<
    PropertyTargetEntry & { reason: PropertyTargetUnresolvedReason }
  >;
}

export interface ResolvePropertyTargetsOptions {
  definition: Pick<WorkspaceDefinitionInput, "profiles">;
  workspaceId: string;
  /** slug → profileId for everything the profile loop resolved or created. */
  profileMap: Record<string, string>;
  profileRepo: ProfileRepository;
  propDefRepo: PropertyDefRepository;
  /** Compute the diff without writing (reconcile's `dryRun`). */
  dryRun?: boolean;
}

export async function resolvePropertyTargetProfiles(
  opts: ResolvePropertyTargetsOptions
): Promise<PropertyTargetResolutionReport> {
  const { definition, workspaceId, profileMap, profileRepo, propDefRepo } =
    opts;
  const report: PropertyTargetResolutionReport = { set: [], unresolved: [] };

  const declared: PropertyTargetEntry[] = [];
  for (const profile of definition.profiles ?? []) {
    for (const prop of profile.properties ?? []) {
      if (!prop.targetProfileSlug) continue;
      declared.push({
        profile: profile.slug,
        slug: prop.slug,
        targetProfileSlug: prop.targetProfileSlug,
      });
    }
  }
  if (declared.length === 0) return report;

  // Targets not declared in THIS definition (a sibling template's kind, e.g.
  // `audience` owned by `foundation`) fall back to the live workspace lens via
  // the canonical resolver — which honours profile scoping: a `shared` profile
  // resolves only through a `profile_workspace_access` grant, a `workspace` one
  // only when it belongs to this workspace. Never a raw slug query.
  const targetCache = new Map<string, string | null>();
  const resolveTargetId = async (slug: string): Promise<string | null> => {
    if (profileMap[slug]) return profileMap[slug];
    const cached = targetCache.get(slug);
    if (cached !== undefined) return cached;
    let id: string | null = null;
    try {
      id =
        (await profileRepo.getBySlugForWorkspace(slug, workspaceId))?.id ??
        null;
    } catch {
      id = null; // non-fatal: an unresolvable target is a report entry, never a throw
    }
    targetCache.set(slug, id);
    return id;
  };

  for (const entry of declared) {
    const ownerProfileId = profileMap[entry.profile];
    if (!ownerProfileId) {
      report.unresolved.push({ ...entry, reason: "owner-profile-unresolved" });
      continue;
    }

    const targetProfileId = await resolveTargetId(entry.targetProfileSlug);
    if (!targetProfileId) {
      report.unresolved.push({ ...entry, reason: "target-profile-unresolved" });
      continue;
    }

    // Overlay first, then base — the same lens order both doors use when they
    // decide whether a property already exists.
    //
    // `getBySlug` falls back to a GLOBAL def (`profile_id IS NULL`) when its
    // profile-scoped lookup misses. Writing a target onto a global def would
    // constrain that slug for EVERY profile on the pod, and letting a spurious
    // global hit satisfy the overlay lookup would also mask the profile's real
    // base def. Reject the fallback on BOTH lookups, not just the winner.
    const ownDef = (def: PropertyDef | null): PropertyDef | null =>
      def && def.profileId === ownerProfileId ? def : null;
    // Guarded like the write below, and for the same reason: this pass ENRICHES
    // defs that already exist and already work. An unguarded read let a
    // transient pool timeout reject out of the caller — and in the create door
    // that call sits OUTSIDE any `try`, so it would fail the install without
    // routing through `handleStepError`, i.e. LESS resumably than every other
    // step, at the one step documented as unable to fail a provision.
    let live: PropertyDef | null;
    try {
      live =
        ownDef(
          await propDefRepo.getBySlug(entry.slug, ownerProfileId, workspaceId)
        ) ??
        ownDef(await propDefRepo.getBySlug(entry.slug, ownerProfileId, null));
    } catch {
      report.unresolved.push({ ...entry, reason: "read-failed" });
      continue;
    }
    if (!live) {
      report.unresolved.push({ ...entry, reason: "property-def-not-found" });
      continue;
    }
    if (live.valueType !== "entity_id") {
      report.unresolved.push({ ...entry, reason: "property-not-entity-id" });
      continue;
    }
    // Already pointed somewhere (this pass on an earlier boot, the legacy
    // seeder, or an operator edit) — never overwrite, never thrash.
    if (live.targetProfileId) continue;

    if (opts.dryRun) {
      report.set.push(entry);
      continue;
    }
    try {
      await propDefRepo.update(live.id, { targetProfileId });
      report.set.push(entry);
    } catch {
      // This pass ENRICHES a def that already exists and already works; it must
      // never be the thing that fails a provision. Record and carry on — the
      // next reconcile (every pod boot) retries it.
      report.unresolved.push({ ...entry, reason: "write-failed" });
    }
  }

  return report;
}
