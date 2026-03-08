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
import { eq } from "drizzle-orm";
import { EventRepository } from "../repositories/event-repository.js";
import { WorkspaceRepository } from "../repositories/workspace-repository.js";
import { WorkspaceMemberRepository } from "../repositories/workspace-member-repository.js";
import { ProfileRepository } from "../repositories/profile-repository.js";
import { ProfileScope } from "../schema/profiles.js";
import { PropertyDefRepository } from "../repositories/property-def-repository.js";
import { ProfilePropertyRepository } from "../repositories/profile-property-repository.js";
import { ViewRepository } from "../repositories/view-repository.js";
import { views } from "../schema/views.js";
import { entities } from "../schema/entities.js";
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
      /** entity_id properties: which profile slug this field links to */
      targetProfileSlug?: string;
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
    /** Optional stable slug for the view (used for reference; not stored as a DB column). */
    slug?: string;
    type: string;
    scopeProfileSlug?: string;
    scopeProfileSlugs?: string[];
    config?: Record<string, unknown>;
    // View configuration — merged into config when saving to DB
    groupBy?: string;
    sortBy?: string;
    sortOrder?: "asc" | "desc";
    filterBy?: Record<string, unknown>;
    description?: string;
    defaultView?: boolean;
    hierarchyEdges?: Array<{ parent: string; child: string; via?: string }>;
    startField?: string;
    endField?: string;
    colorBy?: string;
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
  /** Alias for suggestedEntities — some templates use this name. Normalized before processing. */
  seedEntities?: Array<{
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

/**
 * State required to resume a previously-failed workspace creation.
 * Obtained from `workspace.settings.completedSteps` + `workspace.id`.
 */
export interface ResumeState {
  /** ID of the existing workspace that failed mid-provisioning. */
  workspaceId: string;
  /** Steps that completed before the failure (from settings.completedSteps). */
  completedSteps: string[];
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
  /** ID of the template from the control plane registry (for audit trail). */
  templateId?: string;
  /** Human-readable name of the template (stored in settings for workspace-init). */
  templateName?: string;
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
   * Optional progress callback. Called after each major step completes successfully.
   * @param step  - machine-readable step key
   * @param pct   - completion percentage (0–100)
   * @param label - human-readable label for display
   */
  onProgress?: (step: string, pct: number, label: string) => void;
  /**
   * When set, resumes a previously-failed workspace creation instead of creating
   * a new workspace. Steps listed in completedSteps are skipped (state is rebuilt
   * from the DB) and execution continues from the first incomplete step.
   */
  resumeFrom?: ResumeState;
}

// ─── Definition validation ────────────────────────────────────────────────────

/**
 * Validate definition structure before touching the DB.
 * Catches cross-reference errors (unknown profile slugs in views/entities/links)
 * so we fail fast with a descriptive error instead of a cryptic DB failure mid-way.
 */
function validateDefinition(def: WorkspaceDefinitionInput, label: string): void {
  const errors: string[] = [];
  const definedSlugs = new Set<string>();

  for (const p of def.profiles ?? []) {
    if (!p.slug) { errors.push(`A profile is missing the required 'slug' field`); continue; }
    if (!p.displayName) errors.push(`Profile '${p.slug}': missing required 'displayName'`);
    if (definedSlugs.has(p.slug)) errors.push(`Profile slug '${p.slug}' is duplicated`);
    definedSlugs.add(p.slug);
  }

  for (const v of def.views ?? []) {
    const vname = v.name ?? v.displayName ?? "(unnamed)";
    for (const s of [v.scopeProfileSlug, ...(v.scopeProfileSlugs ?? [])].filter(Boolean) as string[]) {
      if (!definedSlugs.has(s)) {
        errors.push(`View '${vname}': scopeProfile '${s}' not in definition.profiles`);
      }
    }
  }

  for (const e of def.suggestedEntities ?? []) {
    if (!e.profileSlug) { errors.push(`Entity '${e.title}': missing required 'profileSlug'`); continue; }
    if (!definedSlugs.has(e.profileSlug)) {
      errors.push(`Entity '${e.title}': profileSlug '${e.profileSlug}' not in definition.profiles`);
    }
  }

  for (const link of def.entityLinks ?? []) {
    if (!definedSlugs.has(link.sourceProfileSlug)) {
      errors.push(`entityLink: sourceProfileSlug '${link.sourceProfileSlug}' not in definition.profiles`);
    }
    if (!definedSlugs.has(link.targetProfileSlug)) {
      errors.push(`entityLink: targetProfileSlug '${link.targetProfileSlug}' not in definition.profiles`);
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Definition validation failed for '${label}' (${errors.length} error${errors.length > 1 ? "s" : ""}):\n` +
        errors.map((e) => `  • ${e}`).join("\n")
    );
  }
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
    userId,
    packageSlug,
    packageVersion,
    workspaceName,
    createdBy,
    systemSlug,
    templateId,
    templateName,
    onProgress,
    resumeFrom,
  } = opts;
  const { randomUUID } = await import("crypto");

  // ── Normalize definition: resolve field aliases ───────────────────────────────
  // Some templates use `seedEntities` instead of `suggestedEntities` — merge them.
  const definition: WorkspaceDefinitionInput = {
    ...opts.definition,
    suggestedEntities:
      opts.definition.suggestedEntities ??
      opts.definition.seedEntities,
  };

  // ── Validate before touching the DB ─────────────────────────────────────────
  const templateLabel = templateName ?? packageSlug ?? "unnamed";
  validateDefinition(definition, templateLabel);

  const dbConn = await getDb();
  const eventRepo = new EventRepository(sql);

  const isResume = !!resumeFrom;
  const workspaceId = isResume ? resumeFrom!.workspaceId : randomUUID();
  /** Steps that already completed in a previous run (resume only). */
  const priorSteps = new Set(isResume ? resumeFrom!.completedSteps : []);
  const stepDone = (step: string) => priorSteps.has(step);

  const profileIds: string[] = [];
  const viewIds: string[] = [];
  const entityIds: string[] = [];
  /** Steps completed in THIS run (accumulated; written to settings on finish/fail). */
  const completedSteps: string[] = isResume ? [...resumeFrom!.completedSteps] : [];

  const provisioningStartedAt = new Date().toISOString();

  // Build workspace settings with provenance
  const settings: WorkspaceSettings = {
    // Provisioning lifecycle — status starts "pending" so a crash mid-way leaves
    // an inspectable workspace instead of silent data loss. Marked "active" at the end.
    provisioningStatus: "pending",
    provisioningStartedAt,
    createdBy,
    completedSteps: [],
  };

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
  if (packageSlug) settings.packageSlug = packageSlug;
  if (packageVersion) settings.packageVersion = packageVersion;
  if (templateId) settings.templateId = templateId;
  if (templateName) settings.templateName = templateName;
  if (createdBy === "provisioning") {
    settings.provisionedAt = provisioningStartedAt;
  }
  if (systemSlug) settings.systemSlug = systemSlug;
  if (opts.workspaceType) settings.workspaceType = opts.workspaceType;
  if (opts.linkedAgentId) settings.linkedAgentId = opts.linkedAgentId;
  // Agent workspaces invert the normal hierarchy: the AI agent is owner
  // (creative authority) and the human is admin (irreversibility guard).
  if (opts.workspaceType === "agent") {
    settings.governanceMode = "agent-owned";
  }

  // 1. Create workspace
  const workspaceRepo = new WorkspaceRepository(dbConn, eventRepo);
  if (!stepDone("workspace")) {
    await workspaceRepo.create(
      {
        id: workspaceId,
        name: workspaceName ?? definition.workspaceName ?? "New Workspace",
        ownerId: userId,
        settings: settings as Record<string, unknown>,
      },
      userId
    );
    completedSteps.push("workspace");
  }
  onProgress?.("workspace", 10, isResume ? "Workspace restored" : "Workspace created");

  /**
   * Mark the workspace as failed in settings (for inspection / retry),
   * then throw a step-labeled error.
   *
   * Does NOT delete the workspace — callers can inspect the failed workspace
   * to understand what completed, then retry or clean up manually.
   * The idempotency check in the API layer handles re-creation of failed workspaces.
   */
  async function handleStepError(step: string, cause: unknown): Promise<never> {
    const message = cause instanceof Error ? cause.message : String(cause);
    logger.error(
      { workspaceId, step, cause, completedSteps },
      "createWorkspaceFromDefinition failed — marking workspace as failed"
    );
    // Best-effort: persist failure state so it can be inspected/retried
    try {
      await workspaceRepo.mergeSettings(
        workspaceId,
        {
          provisioningStatus: "failed",
          failedStep: step,
          failedStepError: message.slice(0, 500),
          completedSteps: [...completedSteps],
        },
        userId
      );
    } catch (settingsErr) {
      logger.warn(
        { workspaceId, settingsErr },
        "Could not persist failure state to workspace settings"
      );
    }
    throw new Error(`Workspace creation failed at step '${step}': ${message}`, {
      cause,
    });
  }

  /**
   * Rebuild in-memory maps from the DB for a partial/resumed workspace.
   * Called once when resuming, before any step processing.
   */
  async function rebuildStateFromDb(): Promise<{
    profileMap: Record<string, string>;
    profileHintsMap: Record<string, { icon?: string; color?: string }>;
    profileIds: string[];
    viewMap: Record<string, string>;
    viewIds: string[];
    profileBentoViewIds: Record<string, string>;
    entityIds: string[];
    entityRefMap: Record<string, string>;
  }> {
    const profileRepo_ = new ProfileRepository(dbConn);
    const existingProfiles = await profileRepo_.getAccessibleProfiles(userId, workspaceId);
    const profileMap_: Record<string, string> = {};
    const profileHintsMap_: Record<string, { icon?: string; color?: string }> = {};
    const profileIds_: string[] = [];
    for (const p of existingProfiles) {
      profileMap_[p.slug] = p.id;
      profileHintsMap_[p.slug] = {
        icon: (p.uiHints as any)?.icon,
        color: (p.uiHints as any)?.color,
      };
      profileIds_.push(p.id);
    }

    const existingViews = await dbConn.query.views.findMany({
      where: eq(views.workspaceId, workspaceId),
    });
    const viewMap_: Record<string, string> = {};
    const viewIds_: string[] = [];
    const profileBentoViewIds_: Record<string, string> = {};
    for (const v of existingViews) {
      if (v.name) viewMap_[v.name] = v.id;
      viewIds_.push(v.id);
      const meta = v.metadata as Record<string, unknown> | null;
      if (meta?.isProfileBento && typeof meta?.profileSlug === "string") {
        profileBentoViewIds_[meta.profileSlug] = v.id;
      }
    }

    const existingEntities = await dbConn.query.entities.findMany({
      where: eq(entities.workspaceId, workspaceId),
    });
    const entityIds_: string[] = existingEntities.map((e) => e.id);
    const entityRefMap_: Record<string, string> = {};
    for (const e of existingEntities) {
      entityRefMap_[`${e.type}:${e.title}`] = e.id;
    }

    return {
      profileMap: profileMap_,
      profileHintsMap: profileHintsMap_,
      profileIds: profileIds_,
      viewMap: viewMap_,
      viewIds: viewIds_,
      profileBentoViewIds: profileBentoViewIds_,
      entityIds: entityIds_,
      entityRefMap: entityRefMap_,
    };
  }

  // 2. Add creator as member.
  // In agent workspaces the human is "admin" (irreversibility guard) — the AI
  // agent will be added as "owner" (creative authority) on its first message.
  // In all other workspaces the creator is "owner" as usual.
  const memberRepo = new WorkspaceMemberRepository(dbConn, eventRepo);
  if (!stepDone("member")) {
    const creatorRole = opts.workspaceType === "agent" ? "admin" : "owner";
    try {
      await memberRepo.add(
        { workspaceId, userId, role: creatorRole as "owner" | "editor" | "viewer" },
        userId
      );
    } catch (err) {
      await handleStepError("member", err);
    }
    completedSteps.push("member");
  }
  onProgress?.("member", 15, "Member ready");

  // 3. Create profiles and collect slug → id mapping
  const profileMap: Record<string, string> = {};
  /** Resolved icon/color per slug — used later for auto-generated bento blocks. */
  const profileHintsMap: Record<string, { icon?: string; color?: string }> = {};
  const profileRepo = new ProfileRepository(dbConn);
  const propDefRepo = new PropertyDefRepository(dbConn);
  const profilePropRepo = new ProfilePropertyRepository(dbConn);

  if (stepDone("profiles")) {
    // Resume path: rebuild profileMap from existing accessible profiles
    const rebuilt = await rebuildStateFromDb();
    Object.assign(profileMap, rebuilt.profileMap);
    Object.assign(profileHintsMap, rebuilt.profileHintsMap);
    profileIds.push(...rebuilt.profileIds);
    onProgress?.("profiles", 25, "Profiles restored");
  } else {
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
      //   • Control-plane registry: uiHints.icon/color/description + propertyDefs[]
      //   • Frontend proposal:      icon/color/description (direct) + properties[]
      const resolvedIcon = profile.icon ?? profile.uiHints?.icon;
      const resolvedColor = profile.color ?? profile.uiHints?.color;
      const resolvedDescription = profile.description ?? profile.uiHints?.description;

      // Normalize properties: prefer proposal format, fall back to CP registry format.
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

      // Resolution order:
      //   1. Profile is accessible in this workspace (system, shared+grant, or workspace-owned)
      //      → reuse it as-is
      //   2. Profile exists pod-wide but NOT accessible here (another workspace's private profile)
      //      → fail with a clear actionable error
      //   3. Profile does not exist at all → create it
      let created;
      let profileIsReused = false;

      const accessible = await profileRepo.getBySlugForWorkspace(profile.slug, workspaceId);
      if (accessible) {
        logger.info(
          { slug: profile.slug, existingId: accessible.id, scope: accessible.scope },
          "Reusing accessible profile"
        );
        // Shared profiles need an explicit access grant for this workspace
        if (accessible.scope === ProfileScope.SHARED) {
          try {
            await profileRepo.grantAccess(accessible.id, workspaceId);
          } catch (err) {
            await handleStepError(`profiles[${profile.slug}].grantAccess`, err);
          }
        }
        created = accessible;
        profileIsReused = true;
      } else {
        const podWide = await profileRepo.getBySlug(profile.slug);
        if (podWide) {
          // Profile exists in the pod but belongs to another workspace's private scope
          await handleStepError(
            `profiles[${profile.slug}]`,
            new Error(
              `Profile slug '${profile.slug}' is already in use by a private profile in ` +
                `workspace '${podWide.workspaceId ?? "unknown"}'. ` +
                `Either rename this profile in the template, or convert the existing profile ` +
                `to 'shared' scope so it can be reused.`
            )
          );
        }

        try {
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
        } catch (err) {
          await handleStepError(`profiles[${profile.slug}].create`, err);
        }

        // For newly created shared profiles, grant the creating workspace access
        if (scope === "shared") {
          try {
            await profileRepo.grantAccess(created!.id, workspaceId);
          } catch (err) {
            await handleStepError(`profiles[${profile.slug}].grantAccess`, err);
          }
        }
      }

      profileMap[profile.slug] = created!.id;
      profileHintsMap[profile.slug] = { icon: resolvedIcon, color: resolvedColor };
      profileIds.push(created!.id);

      // 4. Create property definitions.
      // For reused profiles (system/shared), only add properties that don't already exist
      // so templates can extend system profiles with custom fields without breaking them.
      let existingPropSlugs = new Set<string>();
      if (profileIsReused && (resolvedProperties ?? []).length > 0) {
        try {
          const existingLinks = await profilePropRepo.getByProfile(created!.id);
          if (existingLinks.length > 0) {
            const pdMap = await propDefRepo.getManyByIds(existingLinks.map((l) => l.propertyDefId));
            for (const pd of pdMap.values()) existingPropSlugs.add(pd.slug);
          }
        } catch (_) {
          // If we can't determine existing props, skip property creation for reused profiles
          continue;
        }
      }
      if (profileIsReused && (resolvedProperties ?? []).length === 0) continue;

      for (let i = 0; i < (resolvedProperties ?? []).length; i++) {
        const prop = resolvedProperties![i];
        // For reused profiles, skip properties that already exist
        if (profileIsReused && existingPropSlugs.has(prop.slug)) continue;
        try {
          // Merge targetProfileSlug into constraints for entity_id properties
          const propConstraints: Record<string, unknown> = {
            ...(prop.constraints ?? {}),
            ...(prop.targetProfileSlug ? { targetProfileSlug: prop.targetProfileSlug } : {}),
          };
          const propDef = await propDefRepo.create({
            slug: prop.slug,
            valueType: prop.valueType as any,
            uiHints: {
              label: prop.label,
              inputType: prop.inputType,
              placeholder: prop.placeholder,
              enumValues: prop.enumValues,
            },
            ...(Object.keys(propConstraints).length > 0 ? { constraints: propConstraints } : {}),
            profileId: created!.id,
          });
          await profilePropRepo.link({
            profileId: created!.id,
            propertyDefId: propDef.id,
            required: false,
            displayOrder: i,
          });
        } catch (err) {
          await handleStepError(`profiles[${profile.slug}].properties[${prop.slug}]`, err);
        }
      }
    }
    completedSteps.push("profiles");
    onProgress?.("profiles", 25, "Profiles ready");
  }

  // 5. Create relation definitions and profile relations from entityLinks
  const relDefRepo = new RelationDefRepository(dbConn);
  const profileRelRepo = new ProfileRelationRepository(dbConn);

  if (!stepDone("relations")) {
    for (const link of definition.entityLinks ?? []) {
      const sourceProfileId = profileMap[link.sourceProfileSlug];
      const targetProfileId = profileMap[link.targetProfileSlug];
      if (!sourceProfileId || !targetProfileId) {
        // Validation already caught missing slugs; this handles slugs that resolved
        // to system profiles not yet in profileMap (shouldn't happen post-validation).
        await handleStepError(
          `relations[${link.sourceProfileSlug}->${link.targetProfileSlug}]`,
          new Error(
            `Profile slug '${!sourceProfileId ? link.sourceProfileSlug : link.targetProfileSlug}' ` +
              `was not found in profileMap after profile creation — this is a bug`
          )
        );
      }

      try {
        const relDef = await relDefRepo.create({
          slug: link.type,
          displayName: link.label ?? link.type.replace(/_/g, " "),
          workspaceId,
          userId,
        });
        await profileRelRepo.link({
          sourceProfileId: sourceProfileId!,
          targetProfileId: targetProfileId!,
          relationDefId: relDef.id,
        });
      } catch (err) {
        await handleStepError(`relations[${link.sourceProfileSlug}->${link.targetProfileSlug}]`, err);
      }
    }
    completedSteps.push("relations");
  }
  onProgress?.("relations", 35, "Relationships configured");

  // 6. Create display templates
  if (!stepDone("templates")) {
    for (const tmpl of definition.displayTemplates ?? []) {
      try {
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
      } catch (err) {
        await handleStepError(`displayTemplates[${tmpl.name}]`, err);
      }
    }
    completedSteps.push("templates");
  }
  onProgress?.("templates", 45, "Display templates installed");

  // 7. Create non-bento, non-flow views first so viewMap is fully populated
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

  if (stepDone("views")) {
    // Resume path: rebuild viewMap and split flow/bento for later steps
    const rebuilt = await rebuildStateFromDb();
    Object.assign(viewMap, rebuilt.viewMap);
    viewIds.push(...rebuilt.viewIds);
    // Still need to classify views for bento/flow steps if those haven't completed
    for (const view of normalizedViews) {
      if (view.type === "flow") flowViews.push(view);
      else if (view.type === "bento") bentoViews.push(view);
    }
    onProgress?.("views", 55, "Views restored");
  } else {
    for (const view of normalizedViews) {
      if (view.type === "flow") { flowViews.push(view); continue; }
      if (view.type === "bento") { bentoViews.push(view); continue; }

      const scopeProfileIds = view.scopeProfileSlugs
        ? view.scopeProfileSlugs.map((s) => profileMap[s]).filter(Boolean)
        : view.scopeProfileSlug
          ? [profileMap[view.scopeProfileSlug]].filter(Boolean)
          : undefined;

      // Merge top-level view config fields into the config object.
      // These are stripped by older versions of the Zod schema but now pass through.
      // Priority: explicit config.* values override top-level fields (template can fine-tune).
      const viewConfigExtra: Record<string, unknown> = {};
      const viewRecord = view as Record<string, unknown>;
      for (const k of [
        "groupBy", "sortBy", "sortOrder", "filterBy", "description",
        "defaultView", "hierarchyEdges", "startField", "endField", "colorBy", "slug",
      ]) {
        if (viewRecord[k] !== undefined) viewConfigExtra[k] = viewRecord[k];
      }
      const mergedConfig =
        Object.keys(viewConfigExtra).length > 0
          ? { ...viewConfigExtra, ...(view.config ?? {}) }
          : view.config;

      let viewResult;
      try {
        viewResult = await viewRepo.create(
          {
            name: view.name,
            type: view.type as any,
            scopeProfileIds: scopeProfileIds?.length ? scopeProfileIds : undefined,
            config: mergedConfig,
            workspaceId,
            userId,
          },
          userId
        );
      } catch (err) {
        await handleStepError(`views[${view.name}]`, err);
      }

      viewMap[view.name] = viewResult!.id;
      viewIds.push(viewResult!.id);
    }
    completedSteps.push("views");
    onProgress?.("views", 55, "Views created");
  }

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

  if (stepDone("bento")) {
    // Resume path: rebuild profileBentoViewIds from existing views
    const rebuilt = await rebuildStateFromDb();
    Object.assign(profileBentoViewIds, rebuilt.profileBentoViewIds);
    // viewMap already populated by the views step rebuild above
    onProgress?.("bento", 65, "Dashboards restored");
  } else {
    // Process explicit bento views from the template
    const profilesWithExplicitBento = new Set<string>();

    for (const view of bentoViews) {
      const scopeProfileSlug =
        view.scopeProfileSlug ??
        (view.scopeProfileSlugs?.length === 1 ? view.scopeProfileSlugs[0] : undefined);
      const scopeProfileIds = view.scopeProfileSlugs
        ? view.scopeProfileSlugs.map((s) => profileMap[s]).filter(Boolean)
        : scopeProfileSlug
          ? [profileMap[scopeProfileSlug]].filter(Boolean)
          : undefined;

      const rawBlocks = (view.config?.blocks as Array<Record<string, unknown>> | undefined) ?? [];
      const resolvedBlocks = rawBlocks.length > 0
        ? resolveBentoBlocks(rawBlocks, scopeProfileSlug ?? view.name)
        : rawBlocks;
      const resolvedConfig = rawBlocks.length > 0
        ? { ...view.config, blocks: resolvedBlocks }
        : view.config;

      const isProfileBento = !!scopeProfileSlug;
      const metadata = isProfileBento
        ? { isProfileBento: true, profileSlug: scopeProfileSlug }
        : undefined;

      let viewResult;
      try {
        viewResult = await viewRepo.create(
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
      } catch (err) {
        await handleStepError(`bento[${view.name}]`, err);
      }

      viewMap[view.name] = viewResult!.id;
      viewIds.push(viewResult!.id);
      if (scopeProfileSlug) {
        profilesWithExplicitBento.add(scopeProfileSlug);
        profileBentoViewIds[scopeProfileSlug] = viewResult!.id;
      }
    }

    // Auto-create default bento for profiles without an explicit one
    for (const profile of definition.profiles ?? []) {
      if (profilesWithExplicitBento.has(profile.slug)) continue;
      const scopeProfileId = profileMap[profile.slug];
      const hints = profileHintsMap[profile.slug] ?? {};
      const blocks = buildDefaultProfileBentoBlocks({
        ...profile,
        icon: hints.icon,
        color: hints.color,
      });

      let viewResult;
      try {
        viewResult = await viewRepo.create(
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
      } catch (err) {
        await handleStepError(`bento[auto:${profile.slug}]`, err);
      }
      viewMap[profile.displayName] = viewResult!.id;
      profileBentoViewIds[profile.slug] = viewResult!.id;
      viewIds.push(viewResult!.id);
    }
    completedSteps.push("bento");
    onProgress?.("bento", 65, "Dashboards built");
  }

  // 8. Create bento home dashboard
  let homeView: { id: string } | undefined;
  if (stepDone("home")) {
    // Rebuild homeView id from existing views
    const existingHomeViews = await dbConn.query.views.findMany({
      where: eq(views.workspaceId, workspaceId),
    });
    const existing = existingHomeViews.find(
      (v) => (v.metadata as Record<string, unknown> | null)?.homeScope === "workspace"
    );
    if (!existing) {
      await handleStepError("home", new Error("Resume: home dashboard view not found in DB"));
    }
    homeView = existing!;
    onProgress?.("home", 75, "Home dashboard restored");
  } else {
    const widgetBlocks = (definition.bentoLayout ?? []).map((widget, idx) => ({
      id: `widget-${idx}`,
      kind: "widget" as const,
      widgetType: widget.widgetType,
      pos: widget.pos,
      config: widget.config || {},
    }));

    const viewBlocks = (definition.bentoViewBlocks ?? [])
      .filter((vb) => {
        if (!viewMap[vb.viewName]) {
          logger.warn({ viewName: vb.viewName }, "bentoViewBlock references unknown view — skipping");
          return false;
        }
        return true;
      })
      .map((vb, idx) => ({
        id: `view-${idx}`,
        kind: "view" as const,
        viewId: viewMap[vb.viewName],
        pos: vb.pos,
        overrides: vb.overrides,
      }));

    try {
      homeView = await viewRepo.create(
        {
          name: definition.bentoViewName ?? "Home",
          type: "bento",
          config: { layout: "bento", blocks: [...widgetBlocks, ...viewBlocks] },
          metadata: { homeScope: "workspace" },
          workspaceId,
          userId,
        },
        userId
      );
    } catch (err) {
      await handleStepError("home", err);
    }
    viewIds.push(homeView!.id);
    completedSteps.push("home");
    onProgress?.("home", 75, "Home dashboard created");
  }

  // 9. Create seed entities
  const entityRepo = new EntityRepository(dbConn, eventRepo);
  const entityRefMap: Record<string, string> = {};

  if (stepDone("entities")) {
    const rebuilt = await rebuildStateFromDb();
    entityIds.push(...rebuilt.entityIds);
    Object.assign(entityRefMap, rebuilt.entityRefMap);
    onProgress?.("entities", 85, "Seed data restored");
  } else {
    for (const entity of definition.suggestedEntities ?? []) {
      let result;
      try {
        result = await entityRepo.create(
          {
            profileSlug: entity.profileSlug,
            title: entity.title,
            properties: entity.properties,
            workspaceId,
            userId,
          },
          userId
        );
      } catch (err) {
        await handleStepError(`entities[${entity.profileSlug}:${entity.title}]`, err);
      }
      entityIds.push(result!.id);
      entityRefMap[`${entity.profileSlug}:${entity.title}`] = result!.id;
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
        try {
          await entityRepo.update(entityId, { properties: updates }, userId);
        } catch (err) {
          logger.warn(
            { err, entityId, updates },
            "Failed to resolve entity cross-references (non-fatal)"
          );
        }
      }
    }
    completedSteps.push("entities");
    onProgress?.("entities", 85, "Seed data added");
  }

  // 10. Create flow views (need entity IDs for node configs)
  if (!stepDone("flows")) {
    for (const view of flowViews) {
      const scopeProfileIds = view.scopeProfileSlugs
        ? view.scopeProfileSlugs.map((s) => profileMap[s]).filter(Boolean)
        : view.scopeProfileSlug
          ? [profileMap[view.scopeProfileSlug]].filter(Boolean)
          : undefined;

      const config = { ...(view.config || {}) };
      if (config.nodes && Array.isArray(config.nodes)) {
        config.nodes = (config.nodes as Array<Record<string, unknown>>).map((node) => {
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
        });
      }

      try {
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
      } catch (err) {
        await handleStepError(`flows[${view.name}]`, err);
      }
    }
    completedSteps.push("flows");
  }
  onProgress?.("flows", 90, "Flow views ready");

  // 11. Create relations between seed entities
  const relationRepo = new RelationRepository(dbConn, eventRepo);
  if (!stepDone("relations-seed")) {
    for (const rel of definition.suggestedRelations ?? []) {
      const sourceId = entityRefMap[rel.sourceRef];
      const targetId = entityRefMap[rel.targetRef];
      if (!sourceId || !targetId) {
        logger.warn(
          { sourceRef: rel.sourceRef, targetRef: rel.targetRef },
          "suggestedRelation references unknown entity — skipping"
        );
        continue;
      }
      try {
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
      } catch (err) {
        await handleStepError(`relations-seed[${rel.sourceRef}->${rel.targetRef}]`, err);
      }
    }
    completedSteps.push("relations-seed");
  }

  // Atomically persist all accumulated settings in ONE call:
  // profileBentoViewIds, profileEntityBentoTemplates, homeDashboardViewId,
  // and final provisioningStatus / completedSteps.
  const finalSettingsPatch: Partial<WorkspaceSettings> = {
    provisioningStatus: "active",
    completedSteps,
  };
  if (Object.keys(profileBentoViewIds).length > 0) {
    finalSettingsPatch.profileBentoViewIds = profileBentoViewIds;
  }
  if (
    definition.profileEntityBentoTemplates &&
    Object.keys(definition.profileEntityBentoTemplates).length > 0
  ) {
    finalSettingsPatch.profileEntityBentoTemplates =
      definition.profileEntityBentoTemplates;
  }
  finalSettingsPatch.homeDashboardViewId = homeView!.id;

  await workspaceRepo.mergeSettings(workspaceId, finalSettingsPatch, userId);

  logger.info(
    {
      workspaceId,
      profileCount: profileIds.length,
      viewCount: viewIds.length,
      entityCount: entityIds.length,
      createdBy,
      packageSlug,
      templateId,
      templateName,
      completedSteps,
    },
    "Workspace created from definition"
  );

  onProgress?.("done", 100, "Complete");

  return { workspaceId, profileIds, viewIds, entityIds };
}
