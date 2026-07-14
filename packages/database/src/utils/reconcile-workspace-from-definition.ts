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

import { getDb, sql } from "../client-pg.js";
import { eq, and } from "drizzle-orm";
import { EventRepository } from "../repositories/event-repository.js";
import { WorkspaceRepository } from "../repositories/workspace-repository.js";
import { ProfileRepository } from "../repositories/profile-repository.js";
import { ProfileScope } from "../schema/profiles.js";
import type { PropertyValueType } from "../schema/property-defs.js";
import { PropertyDefRepository } from "../repositories/property-def-repository.js";
import { ProfilePropertyRepository } from "../repositories/profile-property-repository.js";
import { RelationDefRepository } from "../repositories/relation-def-repository.js";
import { ProfileRelationRepository } from "../repositories/profile-relation-repository.js";
import { ViewRepository } from "../repositories/view-repository.js";
import { views } from "../schema/views.js";
import { profileRelations } from "../schema/profile-relations.js";
import { workspaces } from "../schema/workspaces.js";
import type { WorkspaceSettings } from "../schema/workspaces.js";
import type { WorkspaceDefinitionInput } from "./create-workspace-from-definition.js";
import { createLogger } from "@synap-core/core";

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
}

export interface ReconcileReport {
  workspaceId: string;
  dryRun: boolean;
  settings: { merged: string[] };
  profiles: { added: string[]; reused: string[] };
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
}

const SCOPE_MAP: Record<string, string> = {
  SYSTEM: "system",
  SHARED: "shared",
  WORKSPACE: "workspace",
  USER: "user",
};

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
    profiles: { added: [], reused: [] },
    properties: { added: [], skipped: [], enumsUpdated: [], conflicts: [] },
    views: { added: [], skipped: [], deferred: [] },
    entityLinks: { added: [], skipped: [], unresolved: [] },
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
  if (Object.keys(settingsPatch).length > 0) {
    report.settings.merged = Object.keys(settingsPatch);
    if (!dryRun)
      await workspaceRepo.mergeSettings(workspaceId, settingsPatch, userId);
  }

  // ── 2. Profiles + property-defs (mirrors the create-path additive pass) ─────
  const profileMap: Record<string, string> = {};
  for (const profile of definition.profiles ?? []) {
    const scope = profile.scope
      ? (SCOPE_MAP[profile.scope] ?? "workspace")
      : "workspace";
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

    // Resolve-or-create the profile (same precedence as create-from-definition).
    let resolved = await profileRepo.getBySlugForWorkspace(
      profile.slug,
      workspaceId
    );
    let profileIsReused = false;
    if (resolved) {
      profileIsReused = true;
      if (resolved.scope === ProfileScope.SHARED && !dryRun) {
        await profileRepo.grantAccess(resolved.id, workspaceId).catch(() => {});
      }
      report.profiles.reused.push(profile.slug);
    } else if (scope === "shared" || scope === "system") {
      const podWide = await profileRepo.getBySlug(profile.slug);
      if (podWide) {
        profileIsReused = true;
        resolved = podWide;
        if (!dryRun)
          await profileRepo
            .grantAccess(podWide.id, workspaceId)
            .catch(() => {});
        report.profiles.reused.push(profile.slug);
      }
    }
    if (!resolved) {
      // Create the (workspace-scoped) profile.
      report.profiles.added.push(profile.slug);
      if (!dryRun) {
        resolved = await profileRepo.create({
          slug: profile.slug,
          displayName: profile.displayName,
          uiHints: {
            icon: resolvedIcon,
            color: resolvedColor,
            description: resolvedDescription,
          },
          scope: scope as ProfileScope,
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
        if (scope === "shared")
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

  logger.info(
    {
      workspaceId,
      dryRun,
      profilesAdded: report.profiles.added.length,
      propsAdded: report.properties.added.length,
      propConflicts: report.properties.conflicts.length,
      viewsAdded: report.views.added.length,
      entityLinksAdded: report.entityLinks.added.length,
    },
    "Reconciled workspace from definition"
  );
  return report;
}
