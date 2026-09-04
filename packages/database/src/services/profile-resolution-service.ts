/**
 * Profile Resolution Service
 *
 * Resolves profiles and their effective property sets (with inheritance).
 */

import { and, eq, inArray, isNull, or } from "drizzle-orm";

import { ProfileRepository } from "../repositories/profile-repository.js";
import { ProfilePropertyRepository } from "../repositories/profile-property-repository.js";
import { PropertyDefRepository } from "../repositories/property-def-repository.js";
import { workspaces } from "../schema/workspaces.js";
import { profiles } from "../schema/profiles.js";
import { capabilities } from "../schema/capabilities.js";
import { rendererBindings } from "../schema/renderer-bindings.js";
import { activeRendererBindingWhere } from "./renderer-binding-service.js";
import type { RendererBindingScope } from "../schema/renderer-bindings.js";
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
/**
 * DeclarativeBlock — a MINIMAL, bounded Block-Kit-style schema for a
 * `declarative` renderer (the config-first surface a capability page can carry
 * without a coded cell or a saved view). Intentionally small: five block kinds,
 * each a plain data shape the browser can render generically. Additive — it
 * exists ONLY to give the new `RendererRef.declarative` kind a typed `schema`.
 */
export type DeclarativeBlock =
  | { type: "heading"; text: string; level?: 1 | 2 | 3 }
  | { type: "text"; text: string }
  | { type: "stat"; label: string; value: string | number; hint?: string }
  | { type: "list"; items: string[]; ordered?: boolean }
  | {
      type: "button";
      label: string;
      /** A capability verb key or a route the browser knows how to open. */
      action: string;
      params?: Record<string, unknown>;
    };

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
    }
  | {
      kind: "declarative";
      schema: DeclarativeBlock[];
      title?: string;
      props?: Record<string, unknown>;
      displayMode?: string;
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
 *
 *   `"user"`      — a `renderer_bindings` row scoped to the calling user.
 *   `"pod"`       — a `renderer_bindings` row scoped pod-wide.
 *   `"workspace"` — a workspace binding: a `renderer_bindings` row scoped to a
 *                   workspace, OR the legacy `workspaces.settings
 *                   .profileRenderers` overlay. `binding` on the result tells
 *                   the two apart.
 *   `"profile"`   — `profiles.defaultRenderers` or a deprecated column.
 *   `"default"`   — NOTHING is bound; the hardcoded fallback answered.
 *
 * ADDITIVE by design. `"user"` and `"pod"` are new values, and every consumer
 * branches only on `source === "default"` (see `pickEffectiveRenderer` in
 * `@synap-core/cell-runtime`, whose precedence flip fires on that value alone),
 * so widening the union changes no behaviour.
 */
export type ProfileRendererSource =
  "user" | "workspace" | "pod" | "profile" | "default";

/**
 * Present ONLY when a `renderer_bindings` row answered — the discriminant that
 * separates a workspace BINDING from the legacy workspace settings overlay,
 * both of which report `source: "workspace"`.
 */
export interface RendererBindingHit {
  id: string;
  scope: RendererBindingScope;
  /** `null` when the binding covers the whole KIND rather than one object. */
  subjectId: string | null;
}

/**
 * Optional lens for `getEffectiveRendererWithSource`. Both fields only ever
 * ADD rungs: omit them and the ladder skips the user rungs and the object
 * rungs, which is exactly the resolution that existed before the table.
 */
export interface RendererResolutionScope {
  /** The calling user, enabling the two `user` rungs. Omitted = skip them. */
  userId?: string | null;
  /** One object's id, enabling the three `·object` rungs. Omitted = skip them. */
  subjectId?: string | null;
}

/**
 * The scope ladder, MOST SPECIFIC FIRST. Ranked here and only here — the query
 * fetches every candidate row for the (subjectKind, contentKind) pair in one
 * round trip and this order picks the winner, so adding a rung can never mean
 * adding a query.
 */
const RENDERER_BINDING_LADDER: ReadonlyArray<{
  scope: RendererBindingScope;
  /** true = this rung wants the row that pins ONE object. */
  objectScoped: boolean;
}> = [
  { scope: "user", objectScoped: true },
  { scope: "user", objectScoped: false },
  { scope: "workspace", objectScoped: true },
  { scope: "workspace", objectScoped: false },
  { scope: "pod", objectScoped: true },
  { scope: "pod", objectScoped: false },
];

/**
 * Capability renderers — the capability-subject analogue of a profile's
 * `defaultRenderers`. A capability is NOT a row in `profiles` (it lives in the
 * `capabilities` table), so it cannot reuse the profile resolver; the parallel
 * store + `getEffectiveCapabilityRenderer` below mirror it one subject over.
 *
 * A capability carries an ORDERED, multi-PAGE set (a capability detail is a
 * page-set, not a single slot): `capabilities.metadata.renderers = { pages }`.
 * Each page pins one `RendererRef` (cell | view | declarative | …) under a
 * stable `slot` with a human `title`. The workspace overlay analogue is
 * `workspaces.settings.capabilityRenderers[capabilityId]`, mirroring
 * `settings.profileRenderers[slug]`.
 */
export interface CapabilityRendererPage {
  /** Stable page key within the capability's page-set (e.g. "overview"). */
  slot: string;
  title: string;
  ref: RendererRef;
}

/** The stored shape at `capabilities.metadata.renderers` and in the overlay. */
export interface CapabilityRenderersConfig {
  pages: CapabilityRendererPage[];
}

/**
 * Which layer answered `getEffectiveCapabilityRenderer`:
 *   - `"workspace"`  — `workspaces.settings.capabilityRenderers[capabilityId]`
 *   - `"capability"` — `capabilities.metadata.renderers`
 *   - `"default"`    — NOTHING bound; the page-set is empty and the browser must
 *                      fall back to its hardcoded capability surface.
 */
export type CapabilityRendererSource = "workspace" | "capability" | "default";

export interface EffectiveCapabilityRenderer {
  pages: CapabilityRendererPage[];
  source: CapabilityRendererSource;
}

/**
 * Resolve a capability's effective renderer page-set — a direct clone of
 * `ProfileResolutionService.getEffectiveRendererWithSource`, one subject over.
 *
 * 3-layer precedence:
 *   1. workspace overlay — `workspaces.settings.capabilityRenderers[capabilityId]`
 *   2. capability default — `capabilities.metadata.renderers`
 *   3. system default — nothing bound → `{ pages: [], source: "default" }`, the
 *      honest "not configured" signal so the browser keeps its hardcoded surface.
 *
 * A layer is only taken when it holds a NON-EMPTY `pages` array; an empty page
 * set is treated as "no binding here" and falls through, so a workspace can't
 * accidentally blank a capability's own default by storing `{ pages: [] }`.
 *
 * Standalone (not a method) because a capability is not a `profiles` row and the
 * resolver only needs the raw `db` handle, `capabilityId`, and an optional
 * workspace lens.
 */
export async function getEffectiveCapabilityRenderer(
  db: PostgresJsDatabase<typeof schema>,
  capabilityId: string,
  workspaceId?: string | null
): Promise<EffectiveCapabilityRenderer> {
  // 1. Workspace overlay.
  if (workspaceId) {
    const workspace = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
      columns: { settings: true },
    });
    const settings = workspace?.settings as
      Record<string, unknown> | null | undefined;
    const overlayRoot = settings?.capabilityRenderers as
      Record<string, CapabilityRenderersConfig | undefined> | undefined;
    const overlay = overlayRoot?.[capabilityId];
    if (overlay && Array.isArray(overlay.pages) && overlay.pages.length > 0) {
      return { pages: overlay.pages, source: "workspace" };
    }
  }

  // 2. Capability default.
  const capability = await db.query.capabilities.findFirst({
    where: eq(capabilities.id, capabilityId),
    columns: { metadata: true },
  });
  const metadata = capability?.metadata as
    Record<string, unknown> | null | undefined;
  const config = metadata?.renderers as CapabilityRenderersConfig | undefined;
  if (config && Array.isArray(config.pages) && config.pages.length > 0) {
    return { pages: config.pages, source: "capability" };
  }

  // 3. Nothing bound — empty page-set so the browser keeps its hardcoded surface.
  return { pages: [], source: "default" };
}

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
   * Layer 0 — `renderer_bindings`, the ONE store — sits ABOVE all three; see
   * `getEffectiveRendererWithSource` for its six-rung ladder.
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
    contentKind: ProfileRendererContentKind,
    scope: RendererResolutionScope = {}
  ): Promise<RendererRef> {
    const { ref } = await this.getEffectiveRendererWithSource(
      profileSlug,
      workspaceId,
      contentKind,
      scope
    );
    return ref;
  }

  /**
   * Same resolution as `getEffectiveRenderer`, but reports WHICH layer answered:
   *   - layer 0, `renderer_bindings` (the ONE store), six rungs most specific
   *     first: user·object → user·kind → workspace·object → workspace·kind →
   *     pod·object → pod·kind. Reports `source` = the binding's own scope
   *     (`"user"` | `"workspace"` | `"pod"`) and carries a `binding`
   *     discriminant, which is what separates a workspace BINDING from the
   *     legacy overlay below that reports the same `source`.
   *   - `"workspace"` — layer 1, `workspaces.settings.profileRenderers`
   *   - `"profile"`   — layer 2, `profiles.defaultRenderers` or a legacy column
   *   - `"default"`   — layer 3, the hardcoded system fallback (NOT configured)
   *
   * `source === "default"` is the signal that nothing is bound: the resolver may
   * prefer its own local convention, and the Studio must not offer a "Reset"
   * for a binding that doesn't exist.
   *
   * `scope` is OPTIONAL and only ever ADDS rungs — no `userId` skips the two
   * user rungs, no `subjectId` skips the three object rungs. Every existing
   * three-argument caller therefore resolves exactly as it did before, and
   * while the table has no writer it resolves exactly as it did before the
   * table existed.
   *
   * NOTE the legacy per-entity `systemData.renderer` override is NOT part of
   * this chain and is deliberately left where it is applied (the browser).
   */
  async getEffectiveRendererWithSource(
    profileSlug: string,
    workspaceId: string | null,
    contentKind: ProfileRendererContentKind,
    scope: RendererResolutionScope = {}
  ): Promise<{
    ref: RendererRef;
    source: ProfileRendererSource;
    binding?: RendererBindingHit;
  }> {
    const legacySlot = LEGACY_SLOT_BY_CONTENT_KIND[contentKind];

    // 0. renderer_bindings — the ONE store, six rungs, most specific first.
    //    Consulted BEFORE every legacy store. With no writer yet the table is
    //    empty on every pod, so this returns undefined and resolution below is
    //    byte-identical to what it was before the table existed.
    const binding = await this.resolveRendererBinding(
      profileSlug,
      workspaceId,
      contentKind,
      scope
    );
    if (binding) return binding;

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
   * The `renderer_bindings` rung of {@link getEffectiveRendererWithSource}.
   *
   * ONE query fetches every ACTIVE candidate row for the (subjectKind,
   * contentKind) pair — bounded by the partial unique index to at most one row
   * per (scope, owner, subject) — and {@link RENDERER_BINDING_LADDER} picks the
   * winner. Ranking in code rather than in SQL keeps the ladder readable and
   * makes a new rung a list entry, never another round trip.
   *
   * The query is ALREADY floored to what this call may see: user rows are
   * fetched only for the passed `userId`, workspace rows only for the passed
   * `workspaceId`, pod rows are pod-wide by definition. That mirrors the
   * `renderer_bindings` VisibilityRule in `access/registry.ts` — keep the two
   * in sync, the same way `facetVisibilityConditions` and its rule are.
   *
   * Returns `undefined` when nothing is bound, which is the ONLY outcome until
   * a write door exists.
   */
  private async resolveRendererBinding(
    subjectKind: string,
    workspaceId: string | null,
    contentKind: ProfileRendererContentKind,
    scope: RendererResolutionScope
  ): Promise<
    | {
        ref: RendererRef;
        source: ProfileRendererSource;
        binding: RendererBindingHit;
      }
    | undefined
  > {
    const userId = scope.userId ?? null;
    const subjectId = scope.subjectId ?? null;

    // Scope branches are built from what the CALLER actually has. No userId
    // means the user rungs cannot match anything, so they are not queried —
    // never widened to "any user", which would hand one user another's
    // personal override.
    const scopeBranches = [
      eq(rendererBindings.scopeKind, "pod"),
      ...(workspaceId
        ? [
            and(
              eq(rendererBindings.scopeKind, "workspace"),
              eq(rendererBindings.workspaceId, workspaceId)
            )!,
          ]
        : []),
      ...(userId
        ? [
            and(
              eq(rendererBindings.scopeKind, "user"),
              eq(rendererBindings.userId, userId)
            )!,
          ]
        : []),
    ];

    // Whole-KIND rows always qualify; the object rows only when a subject id
    // was passed — a caller resolving "the kind" must never inherit some other
    // object's personal binding.
    const subjectBranches = [
      isNull(rendererBindings.subjectId),
      ...(subjectId ? [eq(rendererBindings.subjectId, subjectId)] : []),
    ];

    const rows = await this._db
      .select({
        id: rendererBindings.id,
        scopeKind: rendererBindings.scopeKind,
        subjectId: rendererBindings.subjectId,
        ref: rendererBindings.ref,
      })
      .from(rendererBindings)
      .where(
        and(
          // The SHARED live-binding predicate — a revoked binding is a
          // tombstone every reader must walk past.
          activeRendererBindingWhere(),
          eq(rendererBindings.subjectKind, subjectKind),
          eq(rendererBindings.contentKind, contentKind),
          or(...scopeBranches),
          or(...subjectBranches)
        )
      );

    if (rows.length === 0) return undefined;

    for (const rung of RENDERER_BINDING_LADDER) {
      // A rung the caller has no key for cannot match. The WHERE above already
      // excludes those rows; re-checking here means the LADDER alone is a
      // correct floor, so a future caller that hands this function a row set
      // from somewhere else (a batch prefetch, a cache) cannot inherit another
      // user's personal override through a rung it never earned.
      if (rung.scope === "user" && !userId) continue;
      if (rung.scope === "workspace" && !workspaceId) continue;
      if (rung.objectScoped && !subjectId) continue;
      const hit = rows.find(
        (r) =>
          r.scopeKind === rung.scope &&
          (rung.objectScoped ? r.subjectId !== null : r.subjectId === null)
      );
      if (!hit) continue;
      return {
        ref: hit.ref,
        // The scope IS the source for a binding; `binding` below is what tells
        // a workspace BINDING apart from the legacy workspace settings overlay.
        source: hit.scopeKind,
        binding: {
          id: hit.id,
          scope: hit.scopeKind,
          subjectId: hit.subjectId,
        },
      };
    }
    return undefined;
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
