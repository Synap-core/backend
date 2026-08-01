/**
 * reconcileWorkspaceFromDefinition
 *
 * Brings an EXISTING workspace's definition (capabilities/subtype, profiles,
 * property-defs, views) up to a template — NON-DESTRUCTIVELY and idempotently.
 *
 * This is the counterpart to `createWorkspaceFromDefinition`: that one provisions
 * a fresh workspace; this one SYNCS a live one to a (possibly newer) template
 * without touching entity data. There was previously NO such path — all
 * provisioning was fresh-create or resume-a-failed-build — so an older workspace
 * could never be updated to the current template without hand edits.
 *
 * Guarantees (the whole point):
 *   • ADD-ONLY. Never deletes a profile, property-def, view, or entity.
 *   • Never MUTATES a property-def's value_type in place (changing a type does
 *     NOT migrate stored entity.properties, so an in-place change is silently
 *     read-lossy). A slug whose template type differs from the live type is
 *     reported as a CONFLICT and left untouched — the caller decides.
 *   • Profiles reuse the create-path resolution (reuse pod-wide system/shared +
 *     grant access; create workspace-scoped if absent). Fields on a reused
 *     pod-wide profile are added as WORKSPACE OVERLAYS (workspace_id = this ws)
 *     so they never leak to sibling workspaces.
 *   • Views are find-or-create-by-name (the create path blind-inserts → would
 *     duplicate every run); bento/flow views are skipped here (bento dashboards
 *     have their own idempotent `ensureProfileBento` path).
 *   • Settings (capabilities/subtype/purpose/visibility) are merged additively.
 *
 * `dryRun: true` computes the full diff without writing — use it to preview.
 */

import { createHash } from "crypto";
import { getDb, sql } from "../client-pg.js";
import { eq, and } from "drizzle-orm";
import { automations, type FlowDefinition } from "../schema/automations.js";
import {
  intelligenceCommands,
  type DerivedInput,
} from "../schema/intelligence-commands.js";
import { EventRepository } from "../repositories/event-repository.js";
import { WorkspaceRepository } from "../repositories/workspace-repository.js";
import { ProfileRepository } from "../repositories/profile-repository.js";
import { ProfileScope } from "../schema/profiles.js";
import { resolveProfileForApply } from "./resolve-profile-for-apply.js";
import { normalizeProfileScope } from "./normalize-profile-scope.js";
import type { PropertyValueType } from "../schema/property-defs.js";
import { PropertyDefRepository } from "../repositories/property-def-repository.js";
import { ProfilePropertyRepository } from "../repositories/profile-property-repository.js";
import { RelationDefRepository } from "../repositories/relation-def-repository.js";
import { ProfileRelationRepository } from "../repositories/profile-relation-repository.js";
import { ViewRepository } from "../repositories/view-repository.js";
import { views } from "../schema/views.js";
import { profileRelations } from "../schema/profile-relations.js";
import { workspaces } from "../schema/workspaces.js";
import type {
  WorkspaceLayoutDefinition,
  WorkspaceSettings,
  WorkspaceLayoutConfig,
} from "../schema/workspaces.js";
import type { WorkspaceDefinitionInput } from "./create-workspace-from-definition.js";
import {
  resolvePropertyTargetProfiles,
  type PropertyTargetResolutionReport,
} from "./resolve-property-target-profiles.js";
import { createLogger } from "@synap-core/core";
import {
  mergeWorkspacePrimarySurface,
  resolveWorkspacePrimarySurface,
} from "./workspace-primary-surface.js";

const logger = createLogger({ module: "reconcile-workspace-from-definition" });

export interface ReconcileOptions {
  workspaceId: string;
  /** Actor performing the sync (must be authorized to write the workspace). */
  userId: string;
  definition: WorkspaceDefinitionInput;
  /** Compute the diff without applying any write. */
  dryRun?: boolean;
  /**
   * Union new capabilities onto the live set instead of replacing wholesale.
   * TRUE only for additive compose-overlay applies — NEVER for boot/manual
   * "sync to canonical template" reconciles, or a capability removed from a
   * template could never be removed live.
   */
  mergeCapabilities?: boolean;
  /**
   * Package provenance to stamp onto the reconciled workspace's settings —
   * mirrors the create path (`create-workspace-from-definition.ts`) so an
   * install-onto-existing (`market attach --onto <ws>`) leaves the workspace
   * trackable by `market update` instead of stuck at "version unknown". Only
   * threaded for an EXPLICIT install-onto-existing target; a natural declared/
   * transitive compose onto a base carrying its own identity passes neither, so
   * the base's own stamp is never clobbered. Set only when provided (never
   * overwrites an existing stamp with undefined).
   */
  packageSlug?: string;
  packageVersion?: string;
}

export interface ReconcileReport {
  workspaceId: string;
  dryRun: boolean;
  settings: { merged: string[] };
  profiles: {
    added: string[];
    reused: string[];
    /** Existing workspace-scoped profiles promoted to shared to resolve-and-share. */
    promoted: string[];
    /**
     * Slugs where an existing same-slug profile was found but could NOT be
     * safely promoted (another user's private row, or the pod-wide slug seat is
     * held by a soft-deleted shared row), so a DUPLICATE workspace-scoped
     * profile was created instead. This is the one branch where the dedup
     * keystone knowingly fails to dedup — surfaced, never silent.
     */
    deferred: string[];
    /**
     * Declared slug matched an existing profile of a DIFFERENT profileKind
     * (kind vs role). The merge was SKIPPED and the existing row left untouched
     * — the caller decides (never a silent kind flip).
     */
    conflicts: Array<{
      slug: string;
      existingKind: string;
      declaredKind: string;
    }>;
    /**
     * Declared `scope`/`entityScope` on a REUSED slug diverged from the live
     * row. ADVISORY (unlike `conflicts`, which skips): the profile was still
     * reused and the live row left untouched — the declared scope was NOT
     * applied. Surfaced so `market install`/reconcile callers can decide whether
     * to escalate; the first creator owns placement/visibility.
     */
    scopeConflicts: Array<{
      slug: string;
      existingScope: string;
      declaredScope: string;
      existingEntityScope: string;
      declaredEntityScope: "pod" | "workspace" | null;
    }>;
  };
  properties: {
    /** New overlay/base property-defs added. */
    added: Array<{ profile: string; slug: string }>;
    /** Already present (same slug, same type) — left as-is. */
    skipped: Array<{ profile: string; slug: string }>;
    /** Existing property whose enum options were synced to the template (values added). */
    enumsUpdated: Array<{ profile: string; slug: string }>;
    /** Template type differs from the live type — NOT changed; needs a decision. */
    conflicts: Array<{
      profile: string;
      slug: string;
      liveType: string;
      templateType: string;
    }>;
    /**
     * `entity_id` properties whose declared `targetProfileSlug` was resolved to
     * a live profile and written to `property_defs.target_profile_id` — the key
     * the entity picker constrains on. `set` covers defs this run created AND
     * pre-existing defs that were still NULL (the backfill); `unresolved` is
     * non-fatal, mirroring `entityLinks.unresolved`. See
     * `resolve-property-target-profiles.ts`.
     */
    targets: PropertyTargetResolutionReport;
  };
  views: { added: string[]; skipped: string[]; deferred: string[] };
  /**
   * Schema-level links between entity types (relation_defs + profile_relations).
   * `added` = a (source, target, type) edge that did not exist and was created.
   * `skipped` = already present (idempotent no-op).
   * `unresolved` = a source/target profile slug could not be resolved to a live
   * profile in this workspace — left untouched, non-fatal.
   */
  entityLinks: { added: string[]; skipped: string[]; unresolved: string[] };
  /**
   * Home bento dashboard merge (an overlay's `bentoLayout` widgets +
   * `bentoViewBlocks` views). ADDITIVE: an overlay never overwrites the base's
   * dashboard.
   *   `created`   = the workspace had no home view yet, so one was created from
   *                 the overlay's bento (mirrors the create path).
   *   `blocksAdded` = block ids appended below the base blocks (see the merge
   *                 semantics in the step-5 comment).
   *   `skipped`   = overlay declared no bento, or an existing home view already
   *                 rendered every declared view block (nothing to append).
   */
  home: { created: boolean; blocksAdded: string[]; skipped: boolean };
  /**
   * Sidebar layout merge (an overlay's `layoutConfig.sidebarItems`). Base items
   * kept, overlay items appended, deduped by a stable per-kind key. `added` =
   * the dedup keys of overlay items appended to the workspace's sidebar.
   *
   * `primarySurfaceChanged` follows the replacement contract: absent preserves
   * the live value, null clears to workspace home, and a descriptor replaces it.
   */
  layout: { sidebarItemsAdded: string[]; primarySurfaceChanged: boolean };
  /**
   * Flow automations reconciled version-aware (keyed on `(workspaceId, name)`).
   *   `created` = no row for that name → inserted.
   *   `updated` = a row existed but its stored `metadata.seedVersion` (content
   *               hash, or a legacy int) differed from the definition's hash →
   *               `flowDefinition`+`description` overwritten, hash re-stamped,
   *               `automations.version` bumped.
   *   `skipped` = stored hash equals the definition hash → no-op.
   * Values are automation names.
   */
  automations: { created: string[]; updated: string[]; skipped: string[] };
  /**
   * Default intelligence commands seeded create-if-missing (keyed on `title`).
   * `created` = title absent → inserted; `skipped` = title already present
   * (left untouched — a seeded command is owned by the user after first seed).
   */
  commands: { created: string[]; skipped: string[] };
  /**
   * Relation defs seeded create-if-missing (keyed on `slug`), carrying full
   * metadata (description/isDirectional/uiHints). DISTINCT from `entityLinks`,
   * which mints bare (slug+displayName) defs as a side effect of profile edges.
   * `created` = slug absent → inserted; `skipped` = slug already present
   * (workspace-scoped or pod-wide) → left untouched.
   */
  relationDefs: { created: string[]; skipped: string[] };
}

export async function reconcileWorkspaceFromDefinition(
  opts: ReconcileOptions
): Promise<ReconcileReport> {
  const { workspaceId, userId, definition } = opts;
  const dryRun = !!opts.dryRun;

  const dbConn = await getDb();
  const eventRepo = new EventRepository(sql);
  const workspaceRepo = new WorkspaceRepository(dbConn, eventRepo);
  const profileRepo = new ProfileRepository(dbConn);
  const propDefRepo = new PropertyDefRepository(dbConn);
  const profilePropRepo = new ProfilePropertyRepository(dbConn);
  const viewRepo = new ViewRepository(dbConn, eventRepo);

  // The workspace MUST already exist — this path never creates one.
  const ws = await dbConn.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
  });
  if (!ws) {
    throw new Error(
      `reconcileWorkspaceFromDefinition: workspace ${workspaceId} not found`
    );
  }

  const report: ReconcileReport = {
    workspaceId,
    dryRun,
    settings: { merged: [] },
    profiles: {
      added: [],
      reused: [],
      promoted: [],
      deferred: [],
      conflicts: [],
      scopeConflicts: [],
    },
    properties: {
      added: [],
      skipped: [],
      enumsUpdated: [],
      conflicts: [],
      targets: { set: [], unresolved: [] },
    },
    views: { added: [], skipped: [], deferred: [] },
    entityLinks: { added: [], skipped: [], unresolved: [] },
    home: { created: false, blocksAdded: [], skipped: true },
    layout: { sidebarItemsAdded: [], primarySurfaceChanged: false },
    automations: { created: [], updated: [], skipped: [] },
    commands: { created: [], skipped: [] },
    relationDefs: { created: [], skipped: [] },
  };

  // ── 1. Settings merge (capabilities / subtype / visibility) ────────────────
  const settingsPatch: Partial<WorkspaceSettings> = {};
  if (definition.workspaceSubtype)
    settingsPatch.workspaceSubtype = definition.workspaceSubtype;
  if (definition.workspaceVisibility)
    settingsPatch.workspaceVisibility = definition.workspaceVisibility;
  if (definition.workspaceCapabilities) {
    if (opts.mergeCapabilities) {
      const liveCapabilities =
        (ws.settings as WorkspaceSettings | null)?.workspaceCapabilities ?? [];
      settingsPatch.workspaceCapabilities = Array.from(
        new Set([...liveCapabilities, ...definition.workspaceCapabilities])
      );
    } else {
      settingsPatch.workspaceCapabilities = definition.workspaceCapabilities;
    }
  }
  // Package provenance stamp — additive, mirrors the create path. Only written
  // when provided (install-onto-existing), so a re-attach with the same version
  // is a no-op and a natural compose never clobbers the base's own stamp.
  if (opts.packageSlug) settingsPatch.packageSlug = opts.packageSlug;
  if (opts.packageVersion) settingsPatch.packageVersion = opts.packageVersion;
  if (Object.keys(settingsPatch).length > 0) {
    report.settings.merged = Object.keys(settingsPatch);
    if (!dryRun)
      await workspaceRepo.mergeSettings(workspaceId, settingsPatch, userId);
  }

  // ── 2. Profiles + property-defs (mirrors the create-path additive pass) ─────
  const profileMap: Record<string, string> = {};
  for (const profile of definition.profiles ?? []) {
    // Same normalization as the create door — through the ONE shared, typed,
    // case-insensitive door. A local uppercase-keyed map here is what silently
    // demoted all pod-wide `shared` roles to workspace duplicates.
    const scope = normalizeProfileScope(profile.scope);
    const resolvedIcon = profile.icon ?? profile.uiHints?.icon;
    const resolvedColor = profile.color ?? profile.uiHints?.color;
    const resolvedDescription =
      profile.description ?? profile.uiHints?.description;
    const resolvedProperties: typeof profile.properties =
      profile.properties ??
      profile.propertyDefs?.map((pd) => ({
        slug: pd.slug,
        label: pd.uiHints?.label ?? pd.slug,
        valueType: pd.valueType,
        inputType: pd.uiHints?.inputType,
        placeholder: pd.uiHints?.placeholder,
        enumValues: pd.constraints?.enum,
        constraints: pd.constraints,
      }));

    // Resolve-or-create the profile via the ONE shared dedup door (same rule as
    // create-from-definition): resolve-and-share an existing profile (grant, or
    // promote a same-user workspace profile to shared) rather than mint a
    // duplicate; a profileKind mismatch is a CONFLICT that skips the merge.
    const resolution = await resolveProfileForApply(profileRepo, {
      slug: profile.slug,
      declaredScope: scope,
      declaredScopeExplicit: profile.scope !== undefined,
      declaredEntityScope: profile.entityScope,
      declaredKind: profile.profileKind,
      workspaceId,
      actorUserId: userId,
      dryRun,
    });
    if (resolution.conflict) {
      report.profiles.conflicts.push(resolution.conflict);
      // Never overlay onto (or mutate) a different-kind profile — skip entirely.
      continue;
    }
    // ADVISORY (unlike the kind conflict above, which skips): the reuse still
    // proceeds, we just record that the declared scope/entityScope was NOT
    // applied to the live row.
    if (resolution.scopeConflict)
      report.profiles.scopeConflicts.push(resolution.scopeConflict);
    let resolved = resolution.profile;
    let profileIsReused = resolution.reused;
    if (resolution.reused) {
      report.profiles.reused.push(profile.slug);
      if (resolution.promoted) report.profiles.promoted.push(profile.slug);
    }
    if (!resolved) {
      // Create the profile. A DEFERRED promotion lands here too — a same-slug
      // row exists but could not be safely promoted, so this create is a known
      // duplicate. Report it as such (`added` alone would hide it).
      report.profiles.added.push(profile.slug);
      if (resolution.promotionDeferred)
        report.profiles.deferred.push(profile.slug);
      if (!dryRun) {
        resolved = await profileRepo.create({
          slug: profile.slug,
          displayName: profile.displayName,
          uiHints: {
            icon: resolvedIcon,
            color: resolvedColor,
            description: resolvedDescription,
          },
          // NOT the raw declared `scope` — the resolver downgrades it to
          // `workspace` on a deferred promotion, where a `shared` create would
          // collide with the same-slug pod-wide row that blocked the promotion.
          scope: resolution.createScope as ProfileScope,
          // Template-declared entity visibility. `undefined` ⇒ the repository
          // resolves the DOCTRINE default from `profileKind`: a **kind** lands
          // pod-wide, a **role** lands workspace-scoped. (This used to fall back
          // to "workspace" for everything, which is why "kinds are pod-wide" was
          // never true for template-installed profiles.) A template that wants an
          // app-specific, workspace-scoped kind must now say so explicitly.
          entityScope: profile.entityScope,
          workspaceId,
          userId,
          semanticSlug: profile.semanticSlug,
          // Applied on CREATE only: reconcile never flips an existing
          // profile's kind↔role — that's a data conversion (repoint + facet
          // the entities), owned by the conversions manifest / convertToFacet,
          // not a template sync.
          profileKind: profile.profileKind,
          applicableKinds: profile.applicableKinds,
        });
        if (resolution.createScope === "shared")
          await profileRepo
            .grantAccess(resolved.id, workspaceId)
            .catch(() => {});
      } else {
        // dry-run: we can't resolve an id; still report property diffs below as
        // "added" since the profile (and therefore all its props) would be new.
        for (let i = 0; i < (resolvedProperties ?? []).length; i++) {
          report.properties.added.push({
            profile: profile.slug,
            slug: resolvedProperties![i].slug,
          });
        }
        continue;
      }
    }
    profileMap[profile.slug] = resolved.id;

    // Property-defs. Reused pod-wide profile → add as WORKSPACE OVERLAY; freshly
    // created profile → base def (workspace_id null; profile row carries scope).
    const overlayWorkspaceId = profileIsReused ? workspaceId : null;
    for (let i = 0; i < (resolvedProperties ?? []).length; i++) {
      const prop = resolvedProperties![i];
      // Is this slug already present in THIS workspace's lens (base or overlay)?
      const liveBase = await propDefRepo.getBySlug(
        prop.slug,
        resolved.id,
        null
      );
      const liveOverlay = profileIsReused
        ? await propDefRepo.getBySlug(prop.slug, resolved.id, workspaceId)
        : null;
      const live = liveOverlay ?? liveBase;
      if (live) {
        if (live.valueType !== prop.valueType) {
          // NEVER mutate a type in place (read-lossy). Report + leave it.
          report.properties.conflicts.push({
            profile: profile.slug,
            slug: prop.slug,
            liveType: String(live.valueType),
            templateType: String(prop.valueType),
          });
        } else {
          // Same slug + same type → the property EXISTS. Sync its enum options to
          // the template when they drift — a non-destructive UNION (template order
          // first, then any operator-added values not in the template). This lets a
          // newly-added template value (e.g. a `prospect` entry status) appear in
          // EXISTING workspaces' pickers without dropping anything. valueType /
          // constraints are never mutated here (that stays a reported conflict).
          const liveHints =
            (live.uiHints as Record<string, unknown> | undefined) ?? undefined;
          const liveEnum = Array.isArray(liveHints?.enumValues)
            ? (liveHints!.enumValues as string[])
            : undefined;
          const tplEnum = Array.isArray(prop.enumValues)
            ? (prop.enumValues as string[])
            : undefined;
          if (tplEnum && tplEnum.length) {
            const merged = [
              ...tplEnum,
              ...(liveEnum ?? []).filter((v) => !tplEnum.includes(v)),
            ];
            const changed =
              !liveEnum ||
              merged.length !== liveEnum.length ||
              merged.some((v, idx) => v !== liveEnum[idx]);
            if (changed) {
              if (!dryRun) {
                await propDefRepo.update(live.id, {
                  uiHints: { ...(liveHints ?? {}), enumValues: merged },
                });
              }
              report.properties.enumsUpdated.push({
                profile: profile.slug,
                slug: prop.slug,
              });
            } else {
              report.properties.skipped.push({
                profile: profile.slug,
                slug: prop.slug,
              });
            }
          } else {
            report.properties.skipped.push({
              profile: profile.slug,
              slug: prop.slug,
            });
          }
        }
        continue;
      }
      report.properties.added.push({ profile: profile.slug, slug: prop.slug });
      if (!dryRun) {
        const propConstraints: Record<string, unknown> = {
          ...(prop.constraints ?? {}),
          ...(prop.targetProfileSlug
            ? { targetProfileSlug: prop.targetProfileSlug }
            : {}),
        };
        const propDef = await propDefRepo.create({
          slug: prop.slug,
          valueType: prop.valueType as PropertyValueType,
          uiHints: {
            label: prop.label,
            inputType: prop.inputType,
            placeholder: prop.placeholder,
            enumValues: prop.enumValues,
          },
          ...(Object.keys(propConstraints).length > 0
            ? { constraints: propConstraints }
            : {}),
          profileId: resolved.id,
          workspaceId: overlayWorkspaceId,
        });
        await profilePropRepo.link({
          profileId: resolved.id,
          propertyDefId: propDef.id,
          required: false,
          displayOrder: i,
        });
      }
    }
  }

  // ── 2b. entity_id property targets — SECOND pass, after every profile above ─
  // A property may target a profile declared later in `definition.profiles`, and
  // an already-present property `continue`s out of the loop above before it can
  // be touched. Both are why this runs once, at the end, looking defs up by slug:
  // it fills newly-created AND pre-existing defs whose `target_profile_id` is
  // still NULL, so a live pod converges at boot instead of needing a migration.
  // Non-fatal + idempotent — see `resolve-property-target-profiles.ts`.
  // Under `dryRun` a profile this run WOULD create is absent from `profileMap`,
  // so its targets preview as `owner-profile-unresolved` rather than `set`.
  report.properties.targets = await resolvePropertyTargetProfiles({
    definition,
    workspaceId,
    profileMap,
    profileRepo,
    propDefRepo,
    dryRun,
  });

  // ── 3. Views — find-or-create by name (bento/flow deferred) ─────────────────
  const normalizedViews = (definition.views ?? [])
    .map((v) => ({ ...v, name: v.name ?? v.displayName ?? "" }))
    .filter((v) => v.name.length > 0);
  for (const view of normalizedViews) {
    if (view.type === "bento" || view.type === "flow") {
      // Bento dashboards have their own idempotent path; flow views are special.
      report.views.deferred.push(view.name);
      continue;
    }
    const existing = await dbConn.query.views.findFirst({
      where: and(eq(views.workspaceId, workspaceId), eq(views.name, view.name)),
    });
    if (existing) {
      report.views.skipped.push(view.name);
      continue;
    }
    report.views.added.push(view.name);
    if (!dryRun) {
      const scopeProfileIds = view.scopeProfileSlugs
        ? view.scopeProfileSlugs.map((s) => profileMap[s]).filter(Boolean)
        : view.scopeProfileSlug
          ? [profileMap[view.scopeProfileSlug]].filter(Boolean)
          : undefined;
      const viewConfigExtra: Record<string, unknown> = {};
      const viewRecord = view as Record<string, unknown>;
      for (const k of [
        "groupBy",
        "sortBy",
        "sortOrder",
        "filterBy",
        "description",
        "defaultView",
        "colorBy",
        "slug",
      ]) {
        if (viewRecord[k] !== undefined) viewConfigExtra[k] = viewRecord[k];
      }
      const mergedConfig =
        Object.keys(viewConfigExtra).length > 0
          ? { ...viewConfigExtra, ...(view.config ?? {}) }
          : view.config;
      await viewRepo.create(
        {
          name: view.name,
          type: view.type,
          scopeProfileIds: scopeProfileIds?.length
            ? scopeProfileIds
            : undefined,
          config: mergedConfig,
          workspaceId,
          userId,
        },
        userId
      );
    }
  }

  // ── 4. Entity links (schema relations) — idempotent add-only ────────────────
  // Each entityLink = a relation_def (find-or-create by slug=type) + a
  // profile_relation edge (source → target). Adding a link that already exists
  // is a no-op; a re-run adds only the NEW edges (e.g. CRM's client/partner
  // links appearing on an older workspace). Profile slugs are resolved from the
  // profileMap built above, falling back to the live workspace lens for slugs
  // not restated in definition.profiles (e.g. pod-wide system profiles).
  const relDefRepo = new RelationDefRepository(dbConn);
  const profileRelRepo = new ProfileRelationRepository(dbConn);
  const resolveProfileId = async (slug: string): Promise<string | null> => {
    if (profileMap[slug]) return profileMap[slug];
    const p = await profileRepo.getBySlugForWorkspace(slug, workspaceId);
    if (p) profileMap[slug] = p.id;
    return p?.id ?? null;
  };
  for (const link of definition.entityLinks ?? []) {
    const key = `${link.sourceProfileSlug}->${link.targetProfileSlug}:${link.type}`;
    const sourceId = await resolveProfileId(link.sourceProfileSlug);
    const targetId = await resolveProfileId(link.targetProfileSlug);
    if (!sourceId || !targetId) {
      report.entityLinks.unresolved.push(key);
      continue;
    }

    // Does an edge for this (source, target, type) already exist? The relation
    // def is looked up by slug within this workspace lens; if it exists, check
    // for the profile_relation row before treating this as new.
    const existingDef = await relDefRepo.getBySlug(link.type, workspaceId);
    let alreadyLinked = false;
    if (existingDef) {
      const existingEdge = await dbConn.query.profileRelations.findFirst({
        where: and(
          eq(profileRelations.sourceProfileId, sourceId),
          eq(profileRelations.targetProfileId, targetId),
          eq(profileRelations.relationDefId, existingDef.id)
        ),
      });
      alreadyLinked = !!existingEdge;
    }
    if (alreadyLinked) {
      report.entityLinks.skipped.push(key);
      continue;
    }

    report.entityLinks.added.push(key);
    if (!dryRun) {
      // find-or-create the workspace-scoped relation def, then link the profiles.
      // Both repo calls are idempotent (relDef by slug+workspace; profile_relation
      // by unique (source,target,relationDef) with onConflictDoUpdate).
      const relDef = await relDefRepo.create({
        slug: link.type,
        displayName: link.label ?? link.type.replace(/_/g, " "),
        workspaceId,
        userId,
      });
      await profileRelRepo.link({
        sourceProfileId: sourceId,
        targetProfileId: targetId,
        relationDefId: relDef.id,
      });
    }
  }

  // ── 5. Home bento dashboard — ADDITIVE merge (never overwrite) ──────────────
  //
  // The create path materializes a workspace's home dashboard from
  // `bentoLayout` (widget blocks) + `bentoViewBlocks` (view blocks) into ONE
  // bento view stamped `metadata.homeScope === "workspace"`. This pass never
  // did — so a compose-OVERLAY declaring its own dashboard silently lost it.
  //
  // MERGE SEMANTICS (deterministic, additive-only):
  //   • Base blocks are kept first, in place.
  //   • Overlay blocks are DEDUPED against the base — view blocks by `viewId`
  //     (a block is identified by the view it renders), widget blocks by a
  //     content signature `widgetType + config` (widgets carry no stable id,
  //     and this is what makes a repeated compose-overlay IDEMPOTENT instead of
  //     appending duplicates every apply).
  //   • Surviving overlay blocks are STACKED BELOW the base: each is shifted
  //     down by the base's bottom row (`max(y + h)`) so the two dashboards never
  //     visually overlap, and re-id'd to stay unique within the merged array.
  //   • If no home view exists yet, one is CREATED from the overlay's bento
  //     (mirrors the create path's `homeScope:"workspace"` view + settings
  //     `homeDashboardViewId`).
  //
  // FLAGGED FOR REVIEW: "stack the overlay dashboard below the base" is the
  // least-surprising rule for combining two full-grid layouts additively —
  // chosen over interleaving/positional-overwrite (which would drop data). If a
  // future overlay wants to weave blocks INTO the base grid, that needs an
  // explicit block-anchor contract, not this default.
  {
    const declaredBento =
      (definition.bentoLayout ?? []).length > 0 ||
      (definition.bentoViewBlocks ?? []).length > 0;
    if (declaredBento) {
      const wsViews = await dbConn.query.views.findMany({
        where: eq(views.workspaceId, workspaceId),
      });
      const viewIdByName: Record<string, string> = {};
      for (const v of wsViews) if (v.name) viewIdByName[v.name] = v.id;
      // Resolve a bentoViewBlock's `viewSlug`/`viewName` → live viewId. Slugs are
      // matched through the definition's own view list (slug is not a DB column).
      const viewIdBySlug: Record<string, string> = {};
      for (const dv of definition.views ?? []) {
        const nm = dv.name ?? dv.displayName;
        const slug = (dv as { slug?: string }).slug;
        if (slug && nm && viewIdByName[nm])
          viewIdBySlug[slug] = viewIdByName[nm];
      }

      const overlayWidgetBlocks: Array<Record<string, unknown>> = (
        definition.bentoLayout ?? []
      ).map((widget, idx) => ({
        id: `overlay-widget-${idx}`,
        kind: "widget" as const,
        widgetType: widget.widgetType,
        pos: widget.pos,
        config: widget.config ?? {},
      }));
      const overlayViewBlocks: Array<Record<string, unknown>> = (
        definition.bentoViewBlocks ?? []
      )
        .map((vb, idx) => {
          const resolvedId =
            viewIdBySlug[vb.viewSlug ?? ""] ?? viewIdByName[vb.viewName];
          if (!resolvedId) {
            logger.warn(
              { viewName: vb.viewName, viewSlug: vb.viewSlug, workspaceId },
              "reconcile: overlay bentoViewBlock references unknown view — skipping"
            );
            return null;
          }
          return {
            id: `overlay-view-${idx}`,
            kind: "view" as const,
            viewId: resolvedId,
            pos: vb.pos,
            overrides: vb.overrides,
          };
        })
        .filter(Boolean) as Array<Record<string, unknown>>;

      const home = wsViews.find(
        (v) =>
          (v.metadata as Record<string, unknown> | null)?.homeScope ===
          "workspace"
      );

      const blockSig = (b: Record<string, unknown>): string =>
        `${b.widgetType}:${JSON.stringify(b.config ?? {})}`;
      const posBottom = (b: Record<string, unknown>): number => {
        const pos = b.pos as { y?: number; h?: number } | undefined;
        return (pos?.y ?? 0) + (pos?.h ?? 0);
      };
      const shiftDown = (
        b: Record<string, unknown>,
        dy: number,
        newId: string
      ): Record<string, unknown> => {
        const pos = (b.pos as Record<string, unknown>) ?? {};
        return {
          ...b,
          id: newId,
          pos: { ...pos, y: ((pos.y as number | undefined) ?? 0) + dy },
        };
      };

      if (!home) {
        // No dashboard yet → create one from the overlay bento (mirror create).
        const blocks = [...overlayWidgetBlocks, ...overlayViewBlocks];
        if (blocks.length > 0) {
          report.home.created = true;
          report.home.skipped = false;
          report.home.blocksAdded = blocks.map((b) => b.id as string);
          if (!dryRun) {
            const created = await viewRepo.create(
              {
                name: definition.bentoViewName ?? "Home",
                type: "bento",
                config: { layout: "bento", blocks },
                metadata: { homeScope: "workspace" },
                workspaceId,
                userId,
              },
              userId
            );
            await workspaceRepo.mergeSettings(
              workspaceId,
              { homeDashboardViewId: created.id },
              userId
            );
          }
        }
      } else {
        const homeConfig =
          (home.config as Record<string, unknown> | null) ?? {};
        const baseBlocks = Array.isArray(homeConfig.blocks)
          ? (homeConfig.blocks as Array<Record<string, unknown>>)
          : [];
        const baseViewIds = new Set(
          baseBlocks
            .filter((b) => b.kind === "view")
            .map((b) => b.viewId as string)
        );
        const baseWidgetSigs = new Set(
          baseBlocks.filter((b) => b.kind === "widget").map(blockSig)
        );
        const dedupedWidgets = overlayWidgetBlocks.filter(
          (b) => !baseWidgetSigs.has(blockSig(b))
        );
        const dedupedViews = overlayViewBlocks.filter(
          (b) => !baseViewIds.has(b.viewId as string)
        );
        const toAppendRaw = [...dedupedWidgets, ...dedupedViews];
        if (toAppendRaw.length > 0) {
          const baseBottom = baseBlocks.reduce(
            (m, b) => Math.max(m, posBottom(b)),
            0
          );
          const appended = toAppendRaw.map((b, i) =>
            shiftDown(
              b,
              baseBottom,
              `${b.id as string}-a${baseBlocks.length + i}`
            )
          );
          report.home.skipped = false;
          report.home.blocksAdded = appended.map((b) => b.id as string);
          if (!dryRun) {
            await viewRepo.update(
              home.id,
              {
                config: { ...homeConfig, blocks: [...baseBlocks, ...appended] },
              },
              home.userId
            );
          }
        }
      }
    }
  }

  // ── 6. Layout — primary replacement + additive sidebar union ───────────────
  // `primarySurface` has intentional three-state semantics:
  //   absent     → preserve the live value
  //   null       → explicitly return to workspace home
  //   descriptor → replace the live value
  //
  // Sidebar items remain additive: base first, overlay appended and deduped by
  // a stable per-kind key. Both changes are persisted in ONE merge so a sidebar
  // reconcile cannot accidentally restore the pre-reconcile primary surface.
  {
    const authoredLayout = definition.layoutConfig as
      WorkspaceLayoutDefinition | undefined;
    const overlaySidebar = authoredLayout?.sidebarItems ?? [];
    const liveSettings = (ws.settings as WorkspaceSettings | null) ?? {};
    const liveLayout = liveSettings.layout ?? {};
    const authoredPrimary = authoredLayout?.primarySurface;
    const primaryNeedsViewResolution =
      authoredPrimary?.kind === "view" && !("viewId" in authoredPrimary);
    let primaryCandidates: Array<{
      id: string;
      name: string;
      slug?: string;
    }> = [];
    if (authoredPrimary && primaryNeedsViewResolution) {
      const wsViews = await dbConn.query.views.findMany({
        where: eq(views.workspaceId, workspaceId),
      });
      primaryCandidates = wsViews.map((view) => {
        const config = (view.config as Record<string, unknown> | null) ?? {};
        return {
          id: view.id,
          name: view.name,
          ...(typeof config.slug === "string" ? { slug: config.slug } : {}),
        };
      });

      // A dry run does not insert the newly reported views/home. Represent
      // those would-be rows with deterministic preview IDs so resolution still
      // validates the authored reference without writing.
      if (dryRun) {
        for (const view of normalizedViews) {
          if (
            report.views.added.includes(view.name) &&
            !primaryCandidates.some(
              (candidate) =>
                candidate.name === view.name && candidate.slug === view.slug
            )
          ) {
            primaryCandidates.push({
              id: `dry-run:view:${view.slug ?? view.name}`,
              name: view.name,
              ...(view.slug ? { slug: view.slug } : {}),
            });
          }
        }
        if (
          report.home.created &&
          !primaryCandidates.some(
            (candidate) =>
              candidate.name === (definition.bentoViewName ?? "Home")
          )
        ) {
          primaryCandidates.push({
            id: `dry-run:view:${definition.bentoViewName ?? "Home"}`,
            name: definition.bentoViewName ?? "Home",
          });
        }
      }
    }
    const incomingLayout: WorkspaceLayoutConfig | undefined = (() => {
      if (!authoredLayout) return undefined;
      const { primarySurface: _primarySurface, ...layoutWithoutPrimary } =
        authoredLayout;
      return {
        ...layoutWithoutPrimary,
        ...(Object.prototype.hasOwnProperty.call(
          authoredLayout,
          "primarySurface"
        )
          ? {
              primarySurface: resolveWorkspacePrimarySurface(
                authoredPrimary ?? null,
                primaryCandidates
              ),
            }
          : {}),
      };
    })();
    const primarySurfaceMerge = mergeWorkspacePrimarySurface(
      liveLayout,
      incomingLayout
    );
    let nextLayout = primarySurfaceMerge.layout;
    let shouldPersistLayout = primarySurfaceMerge.changed;
    report.layout.primarySurfaceChanged = primarySurfaceMerge.changed;

    if (overlaySidebar.length > 0) {
      const baseItems = liveLayout.sidebarItems ?? [];
      const wsViews2 = await dbConn.query.views.findMany({
        where: eq(views.workspaceId, workspaceId),
      });
      const viewIdByName2: Record<string, string> = {};
      for (const v of wsViews2) if (v.name) viewIdByName2[v.name] = v.id;

      type SidebarItem = NonNullable<
        WorkspaceLayoutConfig["sidebarItems"]
      >[number];
      const keyOf = (item: SidebarItem): string => {
        if (item.profileSlug) return `profile:${item.profileSlug}`;
        if (item.viewId) return `view:${item.viewId}`;
        if (item.viewName) return `viewName:${item.viewName}`;
        if (item.appId) return `app:${item.appId}`;
        if (item.url) return `url:${item.url}`;
        if (item.cellKey) return `cell:${item.cellKey}`;
        return `raw:${JSON.stringify(item)}`;
      };
      const baseKeys = new Set(baseItems.map(keyOf));
      const appended: SidebarItem[] = [];
      for (const raw of overlaySidebar) {
        // Resolve viewName → viewId (create-path parity) before keying/appending.
        const item: SidebarItem =
          raw.kind === "view" &&
          !raw.viewId &&
          raw.viewName &&
          viewIdByName2[raw.viewName]
            ? { ...raw, viewId: viewIdByName2[raw.viewName] }
            : raw;
        const k = keyOf(item);
        if (baseKeys.has(k)) continue;
        baseKeys.add(k);
        appended.push(item);
        report.layout.sidebarItemsAdded.push(k);
      }
      if (appended.length > 0) {
        nextLayout = {
          ...nextLayout,
          sidebarItems: [...baseItems, ...appended],
        };
        shouldPersistLayout = true;
      }
    }

    if (shouldPersistLayout && !dryRun) {
      await workspaceRepo.mergeSettings(
        workspaceId,
        { layout: nextLayout },
        userId
      );
    }
  }

  // ── 7. Automations — version-aware reconcile (create / overwrite-on-drift) ──
  //
  // Generalizes `ensureReportAutomation` (ensure-report-automation.ts:1704-1757)
  // off the hardcoded seed-int and onto a CONTENT HASH of the definition entry,
  // keyed on `(workspaceId, name)`. The int→hash comparison self-heals the v5
  // freeze structurally: a stored `metadata.seedVersion: 5` (number) is `!==`
  // any hex hash string, so the first reconcile detects drift and overwrites.
  for (const auto of definition.flowAutomations ?? []) {
    const flowDefinition = (auto.flowDefinition ?? {
      nodes: [],
      edges: [],
    }) as unknown as FlowDefinition;

    // Stable content key of the definition's flow + description. The definition
    // entry is constructed deterministically (same object shape every apply), so
    // `JSON.stringify` is a stable hash input — the same drift model the skill /
    // package substrate uses (`contentHash(body)`, ensure-system-skills.ts:43).
    const defHash = createHash("sha256")
      .update(
        JSON.stringify({
          flowDefinition,
          description: auto.description ?? null,
        })
      )
      .digest("hex");

    const existing = await dbConn.query.automations.findFirst({
      where: and(
        eq(automations.workspaceId, workspaceId),
        eq(automations.name, auto.name)
      ),
      columns: { id: true, metadata: true, version: true },
    });

    if (!existing) {
      report.automations.created.push(auto.name);
      if (!dryRun) {
        await dbConn.insert(automations).values({
          workspaceId,
          createdBy: userId,
          name: auto.name,
          description: auto.description,
          triggerType: auto.triggerType,
          triggerConfig: auto.triggerConfig ?? {},
          flowDefinition,
          // `active` so the trigger door will actually run it (matches
          // ensureReportAutomation); a manual automation with no schedule costs
          // nothing until a human runs it. Honor a declared status if present.
          status: auto.status ?? "active",
          metadata: { seedVersion: defHash },
        });
      }
      continue;
    }

    const storedSeed = (existing.metadata as { seedVersion?: unknown } | null)
      ?.seedVersion;
    if (storedSeed === defHash) {
      report.automations.skipped.push(auto.name);
      continue;
    }

    // Drift (or a legacy int `seedVersion`) → overwrite flow + description,
    // MERGE-stamp the new hash (NEVER clobber the rest of the metadata bag —
    // `tags`/`createdVia`/`averageExecutionTime` live there; see
    // ensure-report-automation.ts:1738), and bump the monotonic `version` so a
    // run's `definitionSnapshot` reports the right number.
    report.automations.updated.push(auto.name);
    if (!dryRun) {
      await dbConn
        .update(automations)
        .set({
          description: auto.description,
          flowDefinition,
          metadata: {
            ...((existing.metadata as Record<string, unknown> | null) ?? {}),
            seedVersion: defHash,
          },
          version: (existing.version ?? 1) + 1,
          updatedAt: new Date(),
        })
        .where(eq(automations.id, existing.id));
    }
  }

  // ── 8. Commands — create-if-missing (keyed on title, no version) ────────────
  //
  // Mirrors `ensureDefaultCommands` (ensure-default-commands.ts:157-193): a
  // command is seeded once and thereafter owned by the user — its edits are
  // never overwritten (no drift/version concept here, unlike automations).
  if ((definition.commands ?? []).length > 0) {
    const existingCmds = await dbConn.query.intelligenceCommands.findMany({
      where: eq(intelligenceCommands.workspaceId, workspaceId),
      columns: { title: true },
    });
    const existingTitles = new Set(existingCmds.map((c) => c.title));
    for (const cmd of definition.commands ?? []) {
      if (existingTitles.has(cmd.title)) {
        report.commands.skipped.push(cmd.title);
        continue;
      }
      report.commands.created.push(cmd.title);
      existingTitles.add(cmd.title); // guard against duplicate titles in one def
      if (!dryRun) {
        await dbConn.insert(intelligenceCommands).values({
          workspaceId,
          createdBy: userId,
          title: cmd.title,
          promptTemplate: cmd.promptTemplate,
          compiledTemplateAst: null,
          derivedInputs: (cmd.derivedInputs ?? []) as DerivedInput[],
          canCreateViews: cmd.canCreateViews ?? false,
          outputMode: (cmd.outputMode ?? "text") as
            "text" | "proposal" | "view",
          permissionsProfile: (cmd.permissionsProfile ?? "propose_writes") as
            "read_only" | "propose_writes",
          sharedScope: "workspace",
        });
      }
    }
  }

  // ── 9. Relation defs — create-if-missing (keyed on slug, no version) ────────
  //
  // DISTINCT from the entityLinks step (step 4): entityLinks mint a BARE
  // relation_def (slug + displayName only) as a side effect of wiring a
  // profile→profile edge, DROPPING description/isDirectional/uiHints. A template
  // shipping the full `DefaultRelationDef` metadata (see default-relation-defs.ts)
  // must carry it HERE so those fields survive. Mirrors `ensureDefaultRelationDefs`
  // (create-if-missing, no version — user-owned after first seed). `relDefRepo`
  // is the same instance step 4 uses; `.list()` returns workspace-scoped defs
  // AND pod-wide globals, so a slug already seeded pod-wide is a skip, not a dup.
  if ((definition.relationDefs ?? []).length > 0) {
    const existingDefs = await relDefRepo.list(workspaceId);
    const existingRelSlugs = new Set(existingDefs.map((d) => d.slug));
    for (const rd of definition.relationDefs ?? []) {
      if (existingRelSlugs.has(rd.slug)) {
        report.relationDefs.skipped.push(rd.slug);
        continue;
      }
      report.relationDefs.created.push(rd.slug);
      existingRelSlugs.add(rd.slug); // guard against duplicate slugs in one def
      if (!dryRun) {
        await relDefRepo.create({
          slug: rd.slug,
          displayName: rd.displayName,
          description: rd.description,
          workspaceId,
          userId,
          uiHints: rd.uiHints,
          isDirectional: rd.isDirectional,
        });
      }
    }
  }

  logger.info(
    {
      workspaceId,
      dryRun,
      automationsCreated: report.automations.created.length,
      automationsUpdated: report.automations.updated.length,
      commandsCreated: report.commands.created.length,
      relationDefsCreated: report.relationDefs.created.length,
      profilesAdded: report.profiles.added.length,
      profilesReused: report.profiles.reused.length,
      profilesPromoted: report.profiles.promoted.length,
      profileKindConflicts: report.profiles.conflicts.length,
      profileScopeConflicts: report.profiles.scopeConflicts.length,
      propsAdded: report.properties.added.length,
      propConflicts: report.properties.conflicts.length,
      viewsAdded: report.views.added.length,
      entityLinksAdded: report.entityLinks.added.length,
      homeCreated: report.home.created,
      homeBlocksAdded: report.home.blocksAdded.length,
      sidebarItemsAdded: report.layout.sidebarItemsAdded.length,
    },
    "Reconciled workspace from definition"
  );
  return report;
}
