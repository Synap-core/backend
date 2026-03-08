/**
 * createWorkspaceFromDefinition
 *
 * Server-side workspace creation from a PackageDefinition.
 * Mirrors the frontend's 9-step useCreateWorkspaceFromProposal flow
 * but runs entirely on the backend in a single call.
 *
 * Does NOT enqueue workspace-init — the caller (API layer) handles that
 * since the database package must not depend on @synap/jobs.
 */

import { getDb, sql } from "../client-pg.js";
import { EventRepository } from "../repositories/event-repository.js";
import { WorkspaceRepository } from "../repositories/workspace-repository.js";
import { WorkspaceMemberRepository } from "../repositories/workspace-member-repository.js";
import { ProfileRepository } from "../repositories/profile-repository.js";
import { ProfileScope } from "../schema/profiles.js";
import { PropertyDefRepository } from "../repositories/property-def-repository.js";
import { ProfilePropertyRepository } from "../repositories/profile-property-repository.js";
import { ViewRepository } from "../repositories/view-repository.js";
import { EntityRepository } from "../repositories/entity-repository.js";
import { RelationRepository } from "../repositories/relation-repository.js";
import { RelationDefRepository } from "../repositories/relation-def-repository.js";
import { ProfileRelationRepository } from "../repositories/profile-relation-repository.js";
import { entityTemplates } from "../schema/entity-templates.js";
import type { WorkspaceSettings } from "../schema/workspaces.js";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "create-workspace-from-definition" });

// ─── Helpers for auto-generated profile bento views ──────────────────────────

/** Convert kebab-case icon name to PascalCase for bento widget ICON_MAP lookup */
function kebabToPascalCase(str: string): string {
  return str
    .split("-")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
}

/**
 * Build the default bento block set for a profile dashboard.
 * Layout: section-header (row 0) → stat-card count (row 2) → view-table (row 5)
 */
function buildDefaultProfileBentoBlocks(profile: {
  slug: string;
  displayName: string;
  icon?: string;
  color?: string;
}): Array<Record<string, unknown>> {
  const color = profile.color ?? "#6366F1";
  const icon = profile.icon ? kebabToPascalCase(profile.icon) : "Database";
  const slug = profile.slug;
  return [
    {
      id: `${slug}-header`,
      kind: "widget",
      widgetType: "section-header",
      pos: { x: 0, y: 0, w: 12, h: 2 },
      config: { title: profile.displayName, icon, profileSlug: slug, color },
    },
    {
      id: `${slug}-count`,
      kind: "widget",
      widgetType: "stat-card",
      pos: { x: 0, y: 2, w: 3, h: 3 },
      config: {
        label: `Total ${profile.displayName}s`,
        aggregation: "count",
        profileSlug: slug,
        icon,
        color,
      },
    },
    {
      id: `${slug}-table`,
      kind: "widget",
      widgetType: "view-table",
      pos: { x: 0, y: 5, w: 12, h: 9 },
      config: { profileSlug: slug },
    },
  ];
}

/**
 * Subset of PackageDefinition fields consumed by this utility.
 *
 * Supports two input formats interchangeably:
 *
 * 1. **Frontend proposal format** (used by local templates / useCreateWorkspaceFromProposal)
 *    - `profiles[].icon`, `profiles[].color`, `profiles[].description` — direct fields
 *    - `profiles[].properties[]` — flat array with `label`, `inputType`, `enumValues`
 *
 * 2. **Control-plane registry format** (used by CP templates / createFromDefinition fast path)
 *    - `profiles[].uiHints.icon`, `profiles[].uiHints.color`, `profiles[].uiHints.description`
 *    - `profiles[].propertyDefs[]` — with nested `uiHints.label/inputType` and `constraints.enum`
 *
 * The `createWorkspaceFromDefinition` function normalizes both formats transparently
 * before processing (see the profile loop in the implementation).
 */
export interface WorkspaceDefinitionInput {
  workspaceName?: string;
  description?: string;
  profiles?: Array<{
    slug: string;
    displayName: string;
    // Proposal format: direct fields
    icon?: string;
    color?: string;
    description?: string;
    scope?: string;
    // Proposal format: flat property list
    properties?: Array<{
      slug: string;
      label?: string;
      valueType: string;
      inputType?: string;
      placeholder?: string;
      enumValues?: string[];
      constraints?: Record<string, unknown>;
    }>;
    // CP registry format (alternative to the above direct fields)
    uiHints?: {
      icon?: string;
      color?: string;
      description?: string;
    };
    // CP registry format (alternative to `properties`)
    propertyDefs?: Array<{
      slug: string;
      valueType: string;
      required?: boolean;
      constraints?: { enum?: string[]; [k: string]: unknown };
      uiHints?: {
        label?: string;
        inputType?: string;
        placeholder?: string;
      };
    }>;
  }>;
  views?: Array<{
    /** View name in proposal format. Accepts both 'name' and 'displayName' (registry format). */
    name?: string;
    displayName?: string;
    type: string;
    scopeProfileSlug?: string;
    scopeProfileSlugs?: string[];
    config?: Record<string, unknown>;
  }>;
  bentoLayout?: Array<{
    widgetType: string;
    pos: { x: number; y: number; w: number; h: number };
    config?: Record<string, unknown>;
  }>;
  bentoViewBlocks?: Array<{
    kind: "view";
    viewName: string;
    pos: { x: number; y: number; w: number; h: number };
    overrides?: Record<string, unknown>;
  }>;
  /** Override the default "Home" name for the workspace home bento view */
  bentoViewName?: string;
  suggestedEntities?: Array<{
    profileSlug: string;
    title: string;
    properties?: Record<string, unknown>;
    content?: string;
  }>;
  suggestedRelations?: Array<{
    sourceRef: string;
    targetRef: string;
    type: string;
    metadata?: Record<string, unknown>;
  }>;
  displayTemplates?: Array<{
    name: string;
    description?: string;
    entityType?: string;
    targetType?: string;
    isDefault?: boolean;
    config: Record<string, unknown>;
  }>;
  layoutConfig?: {
    pinnedApps?: string[];
    defaultView?: string;
    theme?: string;
    sidebarItems?: Array<{
      kind: "app" | "view" | "profile" | "external";
      appId?: string;
      viewName?: string;
      profileSlug?: string;
      url?: string;
      label?: string;
      icon?: string;
    }>;
  };
  /**
   * Per-profile default bento layout used when opening a single entity of that type.
   * Stored in workspace.settings.profileEntityBentoTemplates.
   * Example: { "deal": { blocks: [...] } }
   */
  profileEntityBentoTemplates?: Record<
    string,
    { blocks: Array<Record<string, unknown>> }
  >;

  /** Schema-level links between entity types (profiles). Creates relation_defs + profile_relations. */
  entityLinks?: Array<{
    sourceProfileSlug: string;
    targetProfileSlug: string;
    type: string;
    label?: string;
  }>;
}

export interface CreateFromDefinitionOptions {
  definition: WorkspaceDefinitionInput;
  userId: string;
  packageSlug?: string;
  packageVersion?: string;
  workspaceName?: string;
  createdBy: "user" | "provisioning" | "plugin";
  /** Optional system slug written atomically into settings on creation (e.g. "pod-admin"). */
  systemSlug?: string;
  /**
   * Semantic role of the workspace within the pod.
   * - "personal"     — user's curated space (default)
   * - "agent"        — AI staging area (no proposal flow required)
   * - "project"      — scoped project context
   * - "operational"  — system/admin workspace
   */
  workspaceType?: "personal" | "agent" | "project" | "operational";
  /**
   * For agent workspaces: the userId (userType="agent") that owns this workspace.
   */
  linkedAgentId?: string;
  /**
   * Optional progress callback. Called at each major creation step so callers
   * can emit real-time progress events (e.g. via WebSocket bridge).
   * @param step  - machine-readable step key
   * @param pct   - completion percentage (0–100)
   * @param label - human-readable label for display
   */
  onProgress?: (step: string, pct: number, label: string) => void;
}

export interface CreateFromDefinitionResult {
  workspaceId: string;
  profileIds: string[];
  viewIds: string[];
  entityIds: string[];
}

export async function createWorkspaceFromDefinition(
  opts: CreateFromDefinitionOptions
): Promise<CreateFromDefinitionResult> {
  const {
    definition,
    userId,
    packageSlug,
    packageVersion,
    workspaceName,
    createdBy,
    systemSlug,
    onProgress,
  } = opts;
  const { randomUUID } = await import("crypto");

  const dbConn = await getDb();
  const eventRepo = new EventRepository(sql);

  const workspaceId = randomUUID();
  const profileIds: string[] = [];
  const viewIds: string[] = [];
  const entityIds: string[] = [];

  // Build workspace settings with provenance
  const settings: WorkspaceSettings = {};
  if (definition.layoutConfig) {
    settings.layout = definition.layoutConfig;
  }

  // Auto-generate sidebarItems from profiles when the template doesn't specify them.
  // Each profile gets one sidebar tab pointing to its auto-created bento view (named
  // after profile.displayName). Templates can override this by providing sidebarItems.
  if (
    !(definition.layoutConfig as any)?.sidebarItems &&
    (definition.profiles ?? []).length > 0
  ) {
    settings.layout = {
      ...(settings.layout ?? {}),
      sidebarItems: (definition.profiles ?? []).map((p) => ({
        kind: "profile",
        profileSlug: p.slug,
        label: p.displayName,
        icon: p.icon ?? p.uiHints?.icon,
      })),
    } as any;
  }
  if (packageSlug) {
    settings.packageSlug = packageSlug;
  }
  if (packageVersion) {
    settings.packageVersion = packageVersion;
  }
  settings.createdBy = createdBy;
  if (createdBy === "provisioning") {
    settings.provisionedAt = new Date().toISOString();
    settings.provisioningStatus = "active";
  }
  if (systemSlug) {
    settings.systemSlug = systemSlug;
  }
  if (opts.workspaceType) {
    settings.workspaceType = opts.workspaceType;
  }
  if (opts.linkedAgentId) {
    settings.linkedAgentId = opts.linkedAgentId;
  }
  // Agent workspaces invert the normal hierarchy: the AI agent is owner
  // (creative authority) and the human is admin (irreversibility guard).
  if (opts.workspaceType === "agent") {
    settings.governanceMode = "agent-owned";
  }

  onProgress?.("workspace", 10, "Creating workspace");

  // 1. Create workspace
  const workspaceRepo = new WorkspaceRepository(dbConn, eventRepo);
  await workspaceRepo.create(
    {
      id: workspaceId,
      name: workspaceName ?? definition.workspaceName ?? "New Workspace",
      ownerId: userId,
      settings: settings as Record<string, unknown>,
    },
    userId
  );

  // 2. Add creator as member.
  // In agent workspaces the human is "admin" (irreversibility guard) — the AI
  // agent will be added as "owner" (creative authority) on its first message.
  // In all other workspaces the creator is "owner" as usual.
  const memberRepo = new WorkspaceMemberRepository(dbConn, eventRepo);
  const creatorRole = opts.workspaceType === "agent" ? "admin" : "owner";
  await memberRepo.add(
    { workspaceId, userId, role: creatorRole as "owner" | "editor" | "viewer" },
    userId
  );

  onProgress?.("profiles", 25, "Setting up profiles");

  // 3. Create profiles and collect slug → id mapping
  const profileMap: Record<string, string> = {};
  /** Resolved icon/color per slug — used later for auto-generated bento blocks. */
  const profileHintsMap: Record<string, { icon?: string; color?: string }> = {};
  const profileRepo = new ProfileRepository(dbConn);
  const propDefRepo = new PropertyDefRepository(dbConn);
  const profilePropRepo = new ProfilePropertyRepository(dbConn);

  for (const profile of definition.profiles ?? []) {
    const scopeMap: Record<string, string> = {
      SYSTEM: "system",
      SHARED: "shared",
      WORKSPACE: "workspace",
      USER: "user",
    };
    const scope = profile.scope
      ? (scopeMap[profile.scope] ?? "workspace")
      : "workspace";

    // Normalize profile fields: support both formats
    //   • Control-plane registry format: uiHints.icon/color/description + propertyDefs[]
    //   • Frontend proposal format:      icon/color/description (direct) + properties[]
    // (Both are typed in WorkspaceDefinitionInput — no casting needed)
    const resolvedIcon = profile.icon ?? profile.uiHints?.icon;
    const resolvedColor = profile.color ?? profile.uiHints?.color;
    const resolvedDescription =
      profile.description ?? profile.uiHints?.description;

    // Normalize properties: prefer proposal format (properties[]) when present,
    // fall back to CP registry format (propertyDefs[] with nested uiHints).
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

    // Handle pod-wide slug uniqueness: if the slug already exists (e.g., "company"
    // was created by a previous workspace from the same template), reuse the
    // existing profile rather than failing the entire creation.
    const existing = await profileRepo.getBySlug(profile.slug);
    let profileIsReused = false;
    let created;

    if (existing) {
      logger.info(
        { slug: profile.slug, existingId: existing.id, scope: existing.scope },
        "Profile slug exists; reusing existing profile"
      );
      // For shared profiles that already exist, grant this workspace access
      if (existing.scope === "shared") {
        await profileRepo.grantAccess(existing.id, workspaceId);
      }
      created = existing;
      profileIsReused = true;
    } else {
      created = await profileRepo.create({
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
      });
      // For newly created shared profiles, grant the creating workspace access
      if (scope === "shared") {
        await profileRepo.grantAccess(created.id, workspaceId);
      }
    }

    profileMap[profile.slug] = created.id;
    profileHintsMap[profile.slug] = {
      icon: resolvedIcon,
      color: resolvedColor,
    };
    profileIds.push(created.id);

    // 4. Create property definitions and link to profile.
    // Skip entirely if we reused an existing profile — its property defs are already
    // set up and re-inserting would hit the (slug, profile_id) unique constraint.
    if (profileIsReused) continue;
    for (let i = 0; i < (resolvedProperties ?? []).length; i++) {
      const prop = resolvedProperties![i];

      const propDef = await propDefRepo.create({
        slug: prop.slug,
        valueType: prop.valueType as any,
        uiHints: {
          label: prop.label,
          inputType: prop.inputType,
          placeholder: prop.placeholder,
          enumValues: prop.enumValues,
        },
        ...(prop.constraints ? { constraints: prop.constraints } : {}),
        // Scope def to this profile so generic slugs (status, type, owner)
        // can be reused across profiles without colliding on the global unique index.
        profileId: created.id,
      });

      await profilePropRepo.link({
        profileId: created.id,
        propertyDefId: propDef.id,
        required: false,
        displayOrder: i,
      });
    }
  }

  onProgress?.("relations", 35, "Configuring relationships");

  // 5. Create relation definitions and profile relations from entityLinks
  const relDefRepo = new RelationDefRepository(dbConn);
  const profileRelRepo = new ProfileRelationRepository(dbConn);

  for (const link of definition.entityLinks ?? []) {
    const sourceProfileId = profileMap[link.sourceProfileSlug];
    const targetProfileId = profileMap[link.targetProfileSlug];
    if (!sourceProfileId || !targetProfileId) continue;

    // Upsert relation definition (deduplicates by slug + workspace)
    const relDef = await relDefRepo.create({
      slug: link.type,
      displayName: link.label ?? link.type.replace(/_/g, " "),
      workspaceId,
      userId,
    });

    // Link profiles via the relation definition
    await profileRelRepo.link({
      sourceProfileId,
      targetProfileId,
      relationDefId: relDef.id,
    });
  }

  // 6. Create display templates
  if (definition.displayTemplates?.length) {
    onProgress?.("templates", 45, "Installing display templates");
    for (const tmpl of definition.displayTemplates) {
      await dbConn.insert(entityTemplates).values({
        id: randomUUID(),
        name: tmpl.name,
        description: tmpl.description,
        targetType: tmpl.targetType ?? "entity",
        entityType: tmpl.entityType,
        isDefault: tmpl.isDefault ?? false,
        workspaceId,
        config: tmpl.config,
      });
    }
  }

  onProgress?.("views", 55, "Creating views");

  // 6. Create non-bento, non-flow views first so viewMap is fully populated
  //    before bento views reference them by name.
  //
  // Normalize views: accept both 'name' (proposal format) and 'displayName'
  // (registry format returned by control plane API). Skip views with no name.
  const normalizedViews = (definition.views ?? [])
    .map((v) => ({ ...v, name: v.name ?? v.displayName ?? "" }))
    .filter((v) => v.name.length > 0);

  const viewRepo = new ViewRepository(dbConn, eventRepo);
  const flowViews: Array<(typeof normalizedViews)[number]> = [];
  const bentoViews: Array<(typeof normalizedViews)[number]> = [];
  const viewMap: Record<string, string> = {};

  for (const view of normalizedViews) {
    if (view.type === "flow") {
      flowViews.push(view);
      continue;
    }
    if (view.type === "bento") {
      bentoViews.push(view);
      continue;
    }

    const scopeProfileIds = view.scopeProfileSlugs
      ? view.scopeProfileSlugs.map((s) => profileMap[s]).filter(Boolean)
      : view.scopeProfileSlug
        ? [profileMap[view.scopeProfileSlug]].filter(Boolean)
        : undefined;

    const viewResult = await viewRepo.create(
      {
        name: view.name,
        type: view.type as any,
        scopeProfileIds: scopeProfileIds?.length ? scopeProfileIds : undefined,
        config: view.config,
        workspaceId,
        userId,
      },
      userId
    );

    viewMap[view.name] = viewResult.id;
    viewIds.push(viewResult.id);
  }

  onProgress?.("bento", 65, "Building dashboards");

  // 6b. Create bento views (explicit from template + auto-generated for remaining profiles).
  //
  // Explicit bento views (from definition.views with type="bento") are processed first.
  // Their config.blocks may contain { kind:"view", viewName:"..." } entries — these are
  // resolved to viewId using viewMap. Profile-scoped bentos are stamped with
  // metadata.isProfileBento + profileSlug. All resulting viewIds are stored in
  // workspace.settings.profileBentoViewIds (not on the profile row) so system/shared
  // profiles can have different bento views per workspace.
  //
  // Any profile without an explicit bento view gets a default 3-block layout.
  const profileBentoViewIds: Record<string, string> = {};
  /** Resolve view-name references in a bento block list using the viewMap. */
  function resolveBentoBlocks(
    rawBlocks: Array<Record<string, unknown>>,
    slugPrefix: string
  ): Array<Record<string, unknown>> {
    return rawBlocks
      .map((block, idx) => {
        if (block.kind !== "view") return block;
        const viewName = block.viewName as string | undefined;
        if (!viewName) return null;
        const resolvedViewId = viewMap[viewName];
        if (!resolvedViewId) {
          logger.warn(
            { viewName, slugPrefix },
            "Bento block references unknown view — skipping"
          );
          return null;
        }
        return {
          ...block,
          viewId: resolvedViewId,
          viewName: undefined,
          id: block.id ?? `${slugPrefix}-v${idx}`,
        };
      })
      .filter(Boolean) as Array<Record<string, unknown>>;
  }

  // Process explicit bento views from the template
  const profilesWithExplicitBento = new Set<string>();

  for (const view of bentoViews) {
    // Resolve effective profile slug from either singular or plural form
    const scopeProfileSlug =
      view.scopeProfileSlug ??
      (view.scopeProfileSlugs?.length === 1
        ? view.scopeProfileSlugs[0]
        : undefined);
    const scopeProfileIds = view.scopeProfileSlugs
      ? view.scopeProfileSlugs.map((s) => profileMap[s]).filter(Boolean)
      : scopeProfileSlug
        ? [profileMap[scopeProfileSlug]].filter(Boolean)
        : undefined;

    // Resolve view-name references in blocks if present
    const rawBlocks =
      (view.config?.blocks as Array<Record<string, unknown>> | undefined) ?? [];
    const resolvedBlocks =
      rawBlocks.length > 0
        ? resolveBentoBlocks(rawBlocks, scopeProfileSlug ?? view.name)
        : rawBlocks;

    const resolvedConfig =
      rawBlocks.length > 0
        ? { ...view.config, blocks: resolvedBlocks }
        : view.config;

    // Stamp profile bento metadata when scoped to a single profile
    const isProfileBento = !!scopeProfileSlug;
    const metadata = isProfileBento
      ? { isProfileBento: true, profileSlug: scopeProfileSlug }
      : undefined;

    const viewResult = await viewRepo.create(
      {
        name: view.name,
        type: "bento" as any,
        scopeProfileIds: scopeProfileIds?.length ? scopeProfileIds : undefined,
        config: resolvedConfig,
        metadata,
        workspaceId,
        userId,
      },
      userId
    );

    viewMap[view.name] = viewResult.id;
    viewIds.push(viewResult.id);

    if (scopeProfileSlug) {
      profilesWithExplicitBento.add(scopeProfileSlug);
      profileBentoViewIds[scopeProfileSlug] = viewResult.id;
      logger.debug(
        { profileSlug: scopeProfileSlug, viewId: viewResult.id },
        "Created explicit profile bento view"
      );
    }
  }

  // Auto-create default bento for profiles that don't have an explicit one
  for (const profile of definition.profiles ?? []) {
    if (profilesWithExplicitBento.has(profile.slug)) continue;
    const scopeProfileId = profileMap[profile.slug];
    const hints = profileHintsMap[profile.slug] ?? {};
    const blocks = buildDefaultProfileBentoBlocks({
      ...profile,
      icon: hints.icon,
      color: hints.color,
    });

    const viewResult = await viewRepo.create(
      {
        name: profile.displayName,
        type: "bento" as any,
        scopeProfileIds: scopeProfileId ? [scopeProfileId] : undefined,
        config: { layout: "bento", blocks },
        metadata: { isProfileBento: true, profileSlug: profile.slug },
        workspaceId,
        userId,
      },
      userId
    );
    viewMap[profile.displayName] = viewResult.id;
    profileBentoViewIds[profile.slug] = viewResult.id;
    viewIds.push(viewResult.id);
    logger.debug(
      { profileSlug: profile.slug, viewId: viewResult.id },
      "Auto-created default profile bento view"
    );
  }

  // Persist profileBentoViewIds (+ optional profileEntityBentoTemplates) into workspace settings
  const settingsPatch: Partial<WorkspaceSettings> = {};
  if (Object.keys(profileBentoViewIds).length > 0) {
    settingsPatch.profileBentoViewIds = profileBentoViewIds;
  }
  if (
    definition.profileEntityBentoTemplates &&
    Object.keys(definition.profileEntityBentoTemplates).length > 0
  ) {
    settingsPatch.profileEntityBentoTemplates =
      definition.profileEntityBentoTemplates;
  }
  if (Object.keys(settingsPatch).length > 0) {
    const workspaceRepo2 = new WorkspaceRepository(dbConn, eventRepo);
    await workspaceRepo2.mergeSettings(workspaceId, settingsPatch, userId);
  }

  onProgress?.("home", 75, "Setting up home");

  // 7. Create bento home dashboard
  const widgetBlocks = (definition.bentoLayout ?? []).map((widget, idx) => ({
    id: `widget-${idx}`,
    kind: "widget" as const,
    widgetType: widget.widgetType,
    pos: widget.pos,
    config: widget.config || {},
  }));

  const viewBlocks = (definition.bentoViewBlocks ?? [])
    .filter((vb) => viewMap[vb.viewName])
    .map((vb, idx) => ({
      id: `view-${idx}`,
      kind: "view" as const,
      viewId: viewMap[vb.viewName],
      pos: vb.pos,
      overrides: vb.overrides,
    }));

  const homeView = await viewRepo.create(
    {
      name: definition.bentoViewName ?? "Home",
      type: "bento",
      config: {
        layout: "bento",
        blocks: [...widgetBlocks, ...viewBlocks],
      },
      metadata: { homeScope: "workspace" },
      workspaceId,
      userId,
    },
    userId
  );
  viewIds.push(homeView.id);

  // Store homeDashboardViewId in workspace settings for O(1) lookup
  {
    const workspaceRepo3 = new WorkspaceRepository(dbConn, eventRepo);
    await workspaceRepo3.mergeSettings(
      workspaceId,
      { homeDashboardViewId: homeView.id },
      userId
    );
  }

  onProgress?.("entities", 85, "Adding initial data");

  // 8. Create seed entities
  const entityRepo = new EntityRepository(dbConn, eventRepo);
  const entityRefMap: Record<string, string> = {};

  for (const entity of definition.suggestedEntities ?? []) {
    const result = await entityRepo.create(
      {
        profileSlug: entity.profileSlug,
        title: entity.title,
        properties: entity.properties,
        workspaceId,
        userId,
      },
      userId
    );

    entityIds.push(result.id);
    entityRefMap[`${entity.profileSlug}:${entity.title}`] = result.id;
  }

  // Resolve entity_id cross-references (ref:profileSlug:Title → real UUID)
  for (const entity of definition.suggestedEntities ?? []) {
    const entityId = entityRefMap[`${entity.profileSlug}:${entity.title}`];
    if (!entityId || !entity.properties) continue;

    const updates: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(entity.properties)) {
      if (typeof val === "string" && val.startsWith("ref:")) {
        const refKey = val.slice(4);
        const resolvedId = entityRefMap[refKey];
        if (resolvedId) updates[key] = resolvedId;
      }
    }
    if (Object.keys(updates).length > 0) {
      await entityRepo.update(entityId, { properties: updates }, userId);
    }
  }

  onProgress?.("flows", 90, "Finalizing views");

  // 9. Create flow views (need entity IDs for node configs)
  for (const view of flowViews) {
    const scopeProfileIds = view.scopeProfileSlugs
      ? view.scopeProfileSlugs.map((s) => profileMap[s]).filter(Boolean)
      : view.scopeProfileSlug
        ? [profileMap[view.scopeProfileSlug]].filter(Boolean)
        : undefined;

    const config = { ...(view.config || {}) };
    if (config.nodes && Array.isArray(config.nodes)) {
      config.nodes = (config.nodes as Array<Record<string, unknown>>).map(
        (node) => {
          const entityIndex = node.data
            ? (node.data as Record<string, unknown>).entityIndex
            : undefined;
          if (
            typeof entityIndex === "number" &&
            entityIndex >= 0 &&
            entityIndex < entityIds.length
          ) {
            return { ...node, entityId: entityIds[entityIndex] };
          }
          return node;
        }
      );
    }

    const flowViewResult = await viewRepo.create(
      {
        name: view.name,
        type: view.type as any,
        scopeProfileIds: scopeProfileIds?.length ? scopeProfileIds : undefined,
        config,
        workspaceId,
        userId,
      },
      userId
    );
    viewIds.push(flowViewResult.id);
  }

  onProgress?.("done", 100, "Complete");

  // 10. Create relations between seed entities
  const relationRepo = new RelationRepository(dbConn, eventRepo);
  for (const rel of definition.suggestedRelations ?? []) {
    const sourceId = entityRefMap[rel.sourceRef];
    const targetId = entityRefMap[rel.targetRef];
    if (sourceId && targetId) {
      await relationRepo.create(
        {
          sourceEntityId: sourceId,
          targetEntityId: targetId,
          type: rel.type,
          workspaceId,
          userId,
          metadata: rel.metadata,
        },
        userId
      );
    }
  }

  logger.info(
    {
      workspaceId,
      profileCount: profileIds.length,
      viewCount: viewIds.length,
      entityCount: entityIds.length,
      createdBy,
      packageSlug,
    },
    "Workspace created from definition"
  );

  return { workspaceId, profileIds, viewIds, entityIds };
}
