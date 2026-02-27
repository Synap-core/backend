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

/**
 * Subset of PackageDefinition fields consumed by this utility.
 * Kept loose (Record-based) so it works with both control-plane
 * PackageDefinition and frontend WorkspaceProposal shapes.
 */
export interface WorkspaceDefinitionInput {
  workspaceName?: string;
  description?: string;
  profiles?: Array<{
    slug: string;
    displayName: string;
    icon?: string;
    color?: string;
    description?: string;
    scope?: string;
    properties?: Array<{
      slug: string;
      label?: string;
      valueType: string;
      inputType?: string;
      placeholder?: string;
      enumValues?: string[];
      constraints?: Record<string, unknown>;
    }>;
  }>;
  views?: Array<{
    name: string;
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
    sidebarApps?: string[];
    defaultView?: string;
    theme?: string;
  };
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

  // 2. Add creator as owner member
  const memberRepo = new WorkspaceMemberRepository(dbConn, eventRepo);
  await memberRepo.add({ workspaceId, userId, role: "owner" }, userId);

  // 3. Create profiles and collect slug → id mapping
  const profileMap: Record<string, string> = {};
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
          icon: profile.icon,
          color: profile.color,
          description: profile.description,
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
    profileIds.push(created.id);

    // 4. Create property definitions and link to profile.
    // Skip entirely if we reused an existing profile — its property defs are already
    // set up and re-inserting would hit the (slug, profile_id) unique constraint.
    if (profileIsReused) continue;
    for (let i = 0; i < (profile.properties ?? []).length; i++) {
      const prop = profile.properties![i];

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
    for (const tmpl of definition.displayTemplates) {
      await dbConn.insert(entityTemplates).values({
        id: randomUUID(),
        name: tmpl.name,
        description: tmpl.description,
        targetType: tmpl.targetType ?? "entity",
        entityType: tmpl.entityType,
        isDefault: tmpl.isDefault ?? false,
        workspaceId,
        userId,
        config: tmpl.config,
      });
    }
  }

  // 6. Create standard views (non-flow)
  const viewRepo = new ViewRepository(dbConn, eventRepo);
  const flowViews: typeof definition.views = [];
  const viewMap: Record<string, string> = {};

  for (const view of definition.views ?? []) {
    if (view.type === "flow") {
      flowViews!.push(view);
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
      name: "Home",
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

  // 9. Create flow views (need entity IDs for node configs)
  for (const view of flowViews ?? []) {
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
