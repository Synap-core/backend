/**
 * Profile Resolution Service
 *
 * Resolves profiles and their effective property sets (with inheritance).
 */

import { eq, inArray } from "drizzle-orm";

import { ProfileRepository } from "../repositories/profile-repository.js";
import { ProfilePropertyRepository } from "../repositories/profile-property-repository.js";
import { PropertyDefRepository } from "../repositories/property-def-repository.js";
import { workspaces } from "../schema/workspaces.js";
import { profiles } from "../schema/profiles.js";
import type { Profile, PropertyDef } from "../schema/index.js";
import type { AiPosture } from "../schema/profiles.js";
import { DEFAULT_AI_POSTURES } from "../utils/ai-posture-defaults.js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "../schema/index.js";

export interface EffectiveProperty extends PropertyDef {
  required: boolean;
  defaultValue: unknown;
  displayOrder: number;
}

/**
 * RendererRef — what a profile or workspace stores as its renderer choice
 * for a (slot, profile) pair.
 *
 * Structural mirror of `RendererTarget` from `@synap-core/renderer-runtime`.
 * Kept as a structural type in the database layer (rather than importing the
 * frontend package) so the schema package stays UI-free. The canonical type
 * lives in `@synap-core/renderer-runtime` and is re-exported by
 * `@synap-core/profile-renderer` as `RendererRef`.
 *
 * Stored as JSONB on `profiles.default_(list|detail)_renderer` and inside
 * `workspaces.settings.profileRenderers[slug]`.
 *
 * Spec: synap-team-docs/content/team/platform/profile-renderer.mdx
 */
export type RendererRef =
  | {
      kind: "cell";
      cellKey: string;
      props: Record<string, unknown>;
      title?: string;
      displayMode?: string;
      rendererHint?: Record<string, unknown>;
    }
  | {
      kind: "view";
      viewId: string;
      title?: string;
      displayMode?: string;
    }
  | {
      kind: "iframe-srcdoc";
      appId: string;
      srcdoc: string;
      title?: string;
      props?: Record<string, unknown>;
    }
  | {
      kind: "external-app";
      appId: string;
      url: string;
      title?: string;
      props?: Record<string, unknown>;
    }
  | {
      kind: "url";
      url: string;
      external?: boolean;
      title?: string;
    }
  | {
      kind: "view-adapter";
      adapterKey: string;
      props?: Record<string, unknown>;
      title?: string;
    };

/**
 * The content kinds a profile assigns a renderer to. Canonical taxonomy that
 * replaces the old list/detail/dashboard "slots":
 *   collection      ← old `list`
 *   entity-detail   ← old `detail`
 *   entity-profile  ← old `dashboard`
 *   entity-card     — NEW; postdates the slot era, so it has NO legacy slot and
 *                     NO legacy column. It lives only in `default_renderers`
 *                     and in the workspace overlay, both keyed by ContentKind.
 *
 * Structural mirror of `ProfileContentKind` from `@synap-core/capabilities`,
 * kept inline so the database layer stays UI-free.
 */
export type ProfileRendererContentKind =
  "entity-detail" | "entity-card" | "entity-profile" | "collection";

/**
 * Which layer of `getEffectiveRenderer`'s chain produced the ref.
 * `"default"` means NOTHING is bound — layer 3's hardcoded fallback answered.
 */
export type ProfileRendererSource = "workspace" | "profile" | "default";

/**
 * Back-compat: map a ContentKind to the legacy slot key still written into old
 * workspace overlays and the deprecated `default_*_renderer` columns.
 *
 * PARTIAL by design — `entity-card` has no legacy twin, and a missing entry is
 * the honest encoding of that. Callers must treat `undefined` as "there is no
 * legacy key to also look under", never as a slot to synthesize.
 */
const LEGACY_SLOT_BY_CONTENT_KIND: Partial<
  Record<ProfileRendererContentKind, "list" | "detail" | "dashboard">
> = {
  collection: "list",
  "entity-detail": "detail",
  "entity-profile": "dashboard",
};

export class ProfileResolutionService {
  private _db: PostgresJsDatabase<typeof schema>;
  private profileRepo: ProfileRepository;
  private profilePropertyRepo: ProfilePropertyRepository;
  private propertyDefRepo: PropertyDefRepository;

  /** TTL cache for entityScope lookups (60s) */
  private static entityScopeCache = new Map<
    string,
    { scope: "pod" | "workspace"; expiresAt: number }
  >();
  private static CACHE_TTL = 60_000;

  /** TTL cache for getEffectiveAiPosture lookups (60s) — same shape/TTL as entityScopeCache. */
  private static aiPostureCache = new Map<
    string,
    { posture: AiPosture; expiresAt: number }
  >();

  constructor(db: PostgresJsDatabase<typeof schema>) {
    this._db = db;
    this.profileRepo = new ProfileRepository(db);
    this.profilePropertyRepo = new ProfilePropertyRepository(db);
    this.propertyDefRepo = new PropertyDefRepository(db);
  }

  /**
   * Get the entity scope for a profile — determines whether entities of
   * this type are pod-wide (visible everywhere) or workspace-scoped.
   * Results are cached for 60 seconds.
   */
  async getEntityScope(
    profileSlug: string,
    workspaceId: string | null
  ): Promise<"pod" | "workspace"> {
    const cacheKey = `${profileSlug}:${workspaceId ?? "__nows__"}`;
    const cached = ProfileResolutionService.entityScopeCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.scope;

    const profile = workspaceId
      ? await this.profileRepo.getBySlugForWorkspace(profileSlug, workspaceId)
      : await this.profileRepo.getBySlug(profileSlug);
    // Schema default + write door = pod. Only an explicit "workspace" pins.
    // Missing profile / null column → pod (identity by default), never ambient.
    const scope = profile?.entityScope === "workspace" ? "workspace" : "pod";

    ProfileResolutionService.entityScopeCache.set(cacheKey, {
      scope,
      expiresAt: Date.now() + ProfileResolutionService.CACHE_TTL,
    });

    return scope;
  }

  /** Invalidate the entityScope cache (call on profile updates) */
  static invalidateEntityScopeCache(profileSlug?: string): void {
    if (profileSlug) {
      for (const key of ProfileResolutionService.entityScopeCache.keys()) {
        if (key.startsWith(`${profileSlug}:`)) {
          ProfileResolutionService.entityScopeCache.delete(key);
        }
      }
    } else {
      ProfileResolutionService.entityScopeCache.clear();
    }
  }

  /**
   * Resolve profile by slug or ID
   */
  async resolveProfile(
    identifier: string,
    userId: string,
    workspaceId: string | null
  ): Promise<Profile | null> {
    // Try by slug first — workspace-aware, returns only what's accessible.
    // Empty string for workspaceId is the convention for "no workspace lens"
    // (workspace-less users in hydration).
    let profile = await this.profileRepo.getBySlug(
      identifier,
      workspaceId ?? "",
      userId
    );
    if (profile) return profile;

    // Try by ID — only if the identifier looks like a UUID to avoid a
    // guaranteed-failing query (and confusing postgres errors) when a slug
    // is passed that simply doesn't exist in the DB yet.
    const UUID_RE =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(identifier)) return null;

    profile = await this.profileRepo.getById(identifier);
    if (profile && (await this.isAccessible(profile, userId, workspaceId))) {
      return profile;
    }

    return null;
  }

  /**
   * Check if profile is accessible to user/workspace
   */
  private async isAccessible(
    profile: Profile,
    userId: string,
    workspaceId: string | null
  ): Promise<boolean> {
    if (profile.scope === "system") return true;
    // Profiles have a globally unique slug constraint, so workspace-scoped
    // profiles are effectively shared schema definitions across workspaces
    if (profile.scope === "workspace") return true;
    if (profile.scope === "user" && profile.userId === userId) return true;
    if (profile.scope === "shared") {
      if (!workspaceId) return false;
      // Check profile_workspace_access join table
      const granted = await this.profileRepo.getGrantedWorkspaces(profile.id);
      return granted.includes(workspaceId);
    }
    return false;
  }

  /**
   * Get all profiles accessible to a user in a workspace.
   * Pass null/empty for workspace-less contexts (returns SYSTEM + USER-scope only).
   */
  async getAccessibleProfiles(
    userId: string,
    workspaceId: string | null
  ): Promise<Profile[]> {
    return this.profileRepo.getAccessibleProfiles(userId, workspaceId ?? "");
  }

  /**
   * Get profile hierarchy (root → leaf)
   */
  async getProfileHierarchy(profileId: string): Promise<Profile[]> {
    return this.profileRepo.getHierarchy(profileId);
  }

  /**
   * Get all descendant profile slugs for a given profile slug.
   * Walks DOWN the profile tree (parent → children → grandchildren).
   * Returns only the descendant slugs (not the parent itself).
   *
   * Uses a single query to fetch all profiles and walks the tree in-memory
   * (profiles are bounded in number — typically <50 per pod).
   */
  async getDescendantSlugs(
    parentSlug: string,
    _workspaceId?: string
  ): Promise<string[]> {
    // Fetch all profiles (bounded set — typically <50 per pod)
    const allProfiles = await this._db.query.profiles.findMany({
      columns: { id: true, slug: true, parentProfileId: true },
    });

    // Build parent → children map
    const childrenOf = new Map<string, string[]>();
    const slugById = new Map<string, string>();
    const idBySlug = new Map<string, string>();

    for (const p of allProfiles) {
      slugById.set(p.id, p.slug);
      idBySlug.set(p.slug, p.id);
      if (p.parentProfileId) {
        const children = childrenOf.get(p.parentProfileId) ?? [];
        children.push(p.id);
        childrenOf.set(p.parentProfileId, children);
      }
    }

    // BFS from the parent slug
    const parentId = idBySlug.get(parentSlug);
    if (!parentId) return [];

    const result: string[] = [];
    const queue = [parentId];

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      const children = childrenOf.get(currentId) ?? [];
      for (const childId of children) {
        const childSlug = slugById.get(childId);
        if (childSlug) {
          result.push(childSlug);
          queue.push(childId); // Continue BFS for grandchildren
        }
      }
    }

    return result;
  }

  /**
   * Get effective properties for a profile (with inheritance) as rendered
   * through a specific workspace's lens.
   *
   * Merges properties from parent profiles (child values override parent).
   * When `workspaceId` is provided, drops overlay defs owned by other
   * workspaces — the caller sees only "base" defs plus its own overlays.
   *
   * Passing `workspaceId = null | undefined` returns the full unfiltered
   * set (admin / introspection path). Almost every real caller has a
   * workspace context and should pass it.
   *
   * Uses 3 flat queries regardless of hierarchy depth (no N+1):
   *   1. getHierarchy()   — profiles in ancestor chain
   *   2. getByProfiles()  — all profile_properties rows for those profiles
   *   3. getManyByIds()   — workspace-filtered at SQL level
   */
  async getEffectiveProperties(
    profileId: string,
    workspaceId?: string | null
  ): Promise<EffectiveProperty[]> {
    // 1. Profile hierarchy (root → leaf) — 1 query per level (small, bounded depth)
    const hierarchy = await this.getProfileHierarchy(profileId);
    if (hierarchy.length === 0) return [];

    // 2. All profile-property links for every profile in the hierarchy — 1 query
    const profileIds = hierarchy.map((p) => p.id);
    const allProfileProperties =
      await this.profilePropertyRepo.getByProfiles(profileIds);

    if (allProfileProperties.length === 0) return [];

    // 3. All property defs referenced by those links — 1 query, filtered
    //    by workspace scope at SQL level (cheaper than fetch-then-drop).
    const propDefIds = [
      ...new Set(allProfileProperties.map((pp) => pp.propertyDefId)),
    ];
    const propDefMap = await this.propertyDefRepo.getManyByIds(
      propDefIds,
      workspaceId
    );

    // Merge: process root-to-leaf so child values override parent values.
    // Any propertyDef filtered out above simply won't be in the map, so the
    // matching profile_properties link is skipped — exactly the intended
    // "this workspace doesn't see that overlay" behaviour.
    const propertyMap = new Map<string, EffectiveProperty>();

    for (const profile of hierarchy) {
      const profileProperties = allProfileProperties.filter(
        (pp) => pp.profileId === profile.id
      );

      for (const profileProperty of profileProperties) {
        const propertyDef = propDefMap.get(profileProperty.propertyDefId);
        if (!propertyDef) continue;

        if (!propertyMap.has(propertyDef.slug)) {
          // First occurrence (from root) — add as-is
          propertyMap.set(propertyDef.slug, {
            ...propertyDef,
            required: profileProperty.required,
            defaultValue: profileProperty.defaultValue,
            displayOrder: profileProperty.displayOrder,
          });
        } else {
          // Child overrides: required can only go up; child default + order take precedence
          const existing = propertyMap.get(propertyDef.slug)!;
          propertyMap.set(propertyDef.slug, {
            ...existing,
            required: profileProperty.required || existing.required,
            defaultValue:
              profileProperty.defaultValue !== null
                ? profileProperty.defaultValue
                : existing.defaultValue,
            displayOrder: profileProperty.displayOrder,
          });
        }
      }
    }

    const result = Array.from(propertyMap.values()).sort(
      (a, b) => a.displayOrder - b.displayOrder
    );

    // Resolve entity-link targets → uiHints.linkedProfileSlug so the entity
    // picker constrains its search to the target profile (e.g. "question",
    // "project") instead of listing every entity. The target is stored as
    // `targetProfileId` (uuid); the picker needs a slug. Resolve once, batched.
    // Read-time resolution covers ALL defs (legacy + new) at one canonical seam.
    await this.resolveLinkTargets(result);

    return result;
  }

  /**
   * Populate `uiHints.linkedProfileSlug` from `targetProfileId` for entity-link
   * properties that don't already carry it. Mutates the passed properties in
   * place. Single batched profiles lookup; no-op when nothing to resolve.
   */
  private async resolveLinkTargets(props: EffectiveProperty[]): Promise<void> {
    const pending = props.filter(
      (p) => p.targetProfileId && !p.uiHints?.linkedProfileSlug
    );
    if (pending.length === 0) return;

    const targetIds = [
      ...new Set(pending.map((p) => p.targetProfileId as string)),
    ];
    const targets = await this._db.query.profiles.findMany({
      where: inArray(profiles.id, targetIds),
      columns: { id: true, slug: true },
    });
    const slugById = new Map(targets.map((t) => [t.id, t.slug]));

    for (const p of pending) {
      const slug = slugById.get(p.targetProfileId as string);
      if (slug) {
        p.uiHints = { ...(p.uiHints ?? {}), linkedProfileSlug: slug };
      }
    }
  }

  /**
   * Get effective property by slug — scoped to the given workspace lens.
   */
  async getEffectiveProperty(
    profileId: string,
    propertySlug: string,
    workspaceId?: string | null
  ): Promise<EffectiveProperty | null> {
    const properties = await this.getEffectiveProperties(
      profileId,
      workspaceId
    );
    return properties.find((p) => p.slug === propertySlug) || null;
  }

  /**
   * Get the effective renderer for a profile in this workspace, by ContentKind.
   *
   * Sister to `getEffectiveProperties` — the single rendering rule for choosing
   * how a profile's collection / one entity / the whole profile should display.
   *
   * Resolution chain (each step has a back-compat fallback to the old "slot"
   * keys so overlays + columns written before the ContentKind migration still
   * resolve):
   *   1. Workspace overlay — `settings.profileRenderers[slug][contentKind]`,
   *      then the legacy slot key (collection→list, entity-detail→detail,
   *      entity-profile→dashboard).
   *   2. Profile default — `profile.defaultRenderers[contentKind]` (the new
   *      map), then the deprecated `default_(list|detail|dashboard)_renderer`
   *      column for un-migrated rows.
   *   3. Hardcoded system fallback — keeps the pod bootable when nothing is
   *      configured.
   *
   * Returns only the ref. Callers that need to tell an EXPLICIT binding apart
   * from the layer-3 system default (the frontend resolver, the Renderer
   * Studio) must use `getEffectiveRendererWithSource` instead — layer 3 always
   * returns a value, so a bare ref cannot answer "was this configured?".
   *
   * Spec: synap-team-docs/content/team/platform/profile-renderer.mdx
   */
  async getEffectiveRenderer(
    profileSlug: string,
    workspaceId: string | null,
    contentKind: ProfileRendererContentKind
  ): Promise<RendererRef> {
    const { ref } = await this.getEffectiveRendererWithSource(
      profileSlug,
      workspaceId,
      contentKind
    );
    return ref;
  }

  /**
   * Same resolution as `getEffectiveRenderer`, but reports WHICH layer answered:
   *   - `"workspace"` — layer 1, `workspaces.settings.profileRenderers`
   *   - `"profile"`   — layer 2, `profiles.defaultRenderers` or a legacy column
   *   - `"default"`   — layer 3, the hardcoded system fallback (NOT configured)
   *
   * `source === "default"` is the signal that nothing is bound: the resolver may
   * prefer its own local convention, and the Studio must not offer a "Reset"
   * for a binding that doesn't exist.
   */
  async getEffectiveRendererWithSource(
    profileSlug: string,
    workspaceId: string | null,
    contentKind: ProfileRendererContentKind
  ): Promise<{ ref: RendererRef; source: ProfileRendererSource }> {
    const legacySlot = LEGACY_SLOT_BY_CONTENT_KIND[contentKind];

    // 1. Workspace overlay (new contentKind key → legacy slot key)
    if (workspaceId) {
      const workspace = await this._db.query.workspaces.findFirst({
        where: eq(workspaces.id, workspaceId),
        columns: { settings: true },
      });
      const settings = workspace?.settings as
        Record<string, unknown> | null | undefined;
      const overlayRoot = settings?.profileRenderers as
        Record<string, Record<string, RendererRef | undefined>> | undefined;
      const profileOverlay = overlayRoot?.[profileSlug];
      const overlay =
        profileOverlay?.[contentKind] ??
        (legacySlot ? profileOverlay?.[legacySlot] : undefined);
      if (overlay) return { ref: overlay, source: "workspace" };
    }

    // 2. Profile default (new map → deprecated column)
    const profile = workspaceId
      ? await this.profileRepo.getBySlugForWorkspace(profileSlug, workspaceId)
      : await this.profileRepo.getBySlug(profileSlug);

    if (profile) {
      const defaultRenderers = (
        profile as {
          defaultRenderers?: Record<string, unknown> | null;
        }
      ).defaultRenderers;
      const mapped = defaultRenderers?.[contentKind];
      if (mapped) return { ref: mapped as RendererRef, source: "profile" };

      // Keyed off the legacy SLOT, not the ContentKind, so a kind with no
      // legacy twin (`entity-card`) reads no column at all instead of falling
      // through an else-branch into someone else's binding.
      const legacyColumn =
        legacySlot === "list"
          ? profile.defaultListRenderer
          : legacySlot === "dashboard"
            ? (profile as { defaultDashboardRenderer?: unknown })
                .defaultDashboardRenderer
            : legacySlot === "detail"
              ? profile.defaultDetailRenderer
              : undefined;
      if (legacyColumn)
        return { ref: legacyColumn as RendererRef, source: "profile" };
    }

    // 3. Hardcoded system fallback — NOT a binding. Reported as `"default"` so
    //    callers can prefer their own local convention (e.g. the browser's
    //    per-profile `entity-detail-${slug}` cells). Note that `list` is not
    //    registered in any frontend cellRegistry today; it survives only as a
    //    non-null sentinel that keeps the pod bootable.
    if (contentKind === "entity-profile")
      return {
        ref: { kind: "cell", cellKey: "profile-dashboard", props: {} },
        source: "default",
      };
    // `__entity-block` is the cell that ALREADY renders every entity card
    // (bento block, document embed, whiteboard shape, sheet). Naming it here is
    // the honest sentinel — but it is also the cell that ASKS this question, so
    // it must recognise its own key and stop, exactly as it does for
    // `source === "default"`.
    if (contentKind === "entity-card")
      return {
        ref: { kind: "cell", cellKey: "__entity-block", props: {} },
        source: "default",
      };
    return contentKind === "collection"
      ? { ref: { kind: "cell", cellKey: "list", props: {} }, source: "default" }
      : {
          ref: { kind: "cell", cellKey: "entity-detail", props: {} },
          source: "default",
        };
  }

  /**
   * Get the effective AI-teaching posture for a subject kind (AI Teaching
   * Substrate D4) — shallow-merged over 3 layers, same resolution shape as
   * `getEffectiveRenderer`/`getEffectiveProperties`:
   *   1. `DEFAULT_AI_POSTURES[profileSlug]` (code defaults)
   *   2. `profiles.aiPosture` (base, per-pod) — only when a `profiles` row
   *      for this slug actually exists. Several main-capability slugs in the
   *      brief list (document, view, cell, project, session, playbook,
   *      automation, workspace, capability, capture) are NOT rows in the
   *      `profiles` table (they're first-class tables/subject-types, not
   *      entity kinds) — for those, this layer is simply absent and the
   *      merge falls back to layer 1 + layer 3. Reuses the SAME lookup as
   *      `getEffectiveRenderer` (`profileRepo.getBySlugForWorkspace` /
   *      `getBySlug`), so a real profile row's base layer is honored too.
   *   3. `workspaces.settings.profileAiPosture[profileSlug]` (workspace overlay)
   * Results are cached for 60 seconds (mirrors `getEntityScope`'s cache).
   */
  async getEffectiveAiPosture(
    profileSlug: string,
    workspaceId: string | null
  ): Promise<AiPosture> {
    const cacheKey = `${profileSlug}:${workspaceId ?? "__nows__"}`;
    const cached = ProfileResolutionService.aiPostureCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.posture;

    const base = DEFAULT_AI_POSTURES[profileSlug] ?? {};

    const profile = workspaceId
      ? await this.profileRepo.getBySlugForWorkspace(profileSlug, workspaceId)
      : await this.profileRepo.getBySlug(profileSlug);
    const profileLayer =
      (profile as { aiPosture?: AiPosture | null } | null)?.aiPosture ?? {};

    let overlay: AiPosture = {};
    if (workspaceId) {
      const workspace = await this._db.query.workspaces.findFirst({
        where: eq(workspaces.id, workspaceId),
        columns: { settings: true },
      });
      const settings = workspace?.settings as
        Record<string, unknown> | null | undefined;
      const overlayRoot = settings?.profileAiPosture as
        Record<string, AiPosture | undefined> | undefined;
      overlay = overlayRoot?.[profileSlug] ?? {};
    }

    const posture: AiPosture = { ...base, ...profileLayer, ...overlay };

    ProfileResolutionService.aiPostureCache.set(cacheKey, {
      posture,
      expiresAt: Date.now() + ProfileResolutionService.CACHE_TTL,
    });

    return posture;
  }

  /**
   * Invalidate the getEffectiveAiPosture cache. Mirrors
   * `invalidateEntityScopeCache` — call on `profiles.aiPosture` writes or
   * `workspaces.settings.profileAiPosture` writes. Not yet wired to a write
   * path (out of this wave's write scope — packages/api/src/routers/profiles.ts
   * and the workspace-settings writer are owned elsewhere); tracked follow-up.
   */
  static invalidateAiPostureCache(profileSlug?: string): void {
    if (profileSlug) {
      for (const key of ProfileResolutionService.aiPostureCache.keys()) {
        if (key.startsWith(`${profileSlug}:`)) {
          ProfileResolutionService.aiPostureCache.delete(key);
        }
      }
      return;
    }
    ProfileResolutionService.aiPostureCache.clear();
  }
}
