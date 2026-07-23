/**
 * workspaceToPackageDefinition — the INVERSE of `createWorkspaceFromDefinition`.
 * ============================================================================
 *
 * Reverse-serialize a LIVE workspace back into a `PackageDefinition` — the same
 * shape `POST /api/hub/packages/apply` consumes — so a workspace built by hand
 * (or by an agent) can be re-published as a reusable template WITHOUT going
 * through the frontend's lossy `useExportWorkspaceAsPackage` hook (which emits
 * only profiles + widget-type-only bento blocks, dropping every automation,
 * playbook, capability, entity-link, display-template, action-placement,
 * sidebar item, onboarding spec and dependency).
 *
 * This is a POD-NATIVE, read-only extraction: it reuses the canonical
 * repositories/services (`ProfileRepository`, `ProfileResolutionService`'s
 * `getEffectiveProperties`, `RelationDefRepository`, …) and the shared
 * `PackageDefinition` type — it hand-rolls no shapes and writes nothing.
 *
 * FIDELITY NOTES (honest about the edges):
 *   • Profiles: workspace-owned + user profiles are emitted with ALL their
 *     effective properties; SHARED/SYSTEM (reused) profiles are emitted only
 *     when this workspace added at least one OVERLAY property, and then only the
 *     overlay props (the base body is owned by whatever template seeded it — a
 *     re-apply resolves the slug to that same pod-wide row and adds our overlays
 *     back). A pristine SYSTEM profile the workspace never touched is skipped.
 *   • Bento: the workspace HOME dashboard (`metadata.homeScope==="workspace"`)
 *     is split back into `bentoLayout` (widgets) + `bentoViewBlocks` (views,
 *     viewId → viewName). Profile-scoped bento views round-trip through `views`
 *     with their internal view-blocks likewise de-referenced to viewName.
 *   • Capabilities are emitted as `{ templateKey }` from the container's stamped
 *     `metadata.templateKey`; a container without one is skipped (there is no
 *     inline capability shape to reconstruct losslessly).
 */

import {
  getDb,
  db,
  and,
  eq,
  inArray,
  ProfileRepository,
  ProfileResolutionService,
  ProfileScope,
  RelationDefRepository,
  ProfileRelationRepository,
  views as viewsTable,
  automations as automationsTable,
  playbooks as playbooksTable,
  capabilities as capabilitiesTable,
  entityTemplates,
  links as linksTable,
  tools as toolsTable,
  skills as skillsTable,
  workspaces as workspacesTable,
  type PackageDefinition,
  type WorkspaceSettings,
} from "@synap/database";

/** Home/profile bento block as stored in a bento view's `config.blocks`. */
interface StoredBentoBlock {
  id?: string;
  kind?: "widget" | "view";
  widgetType?: string;
  viewId?: string;
  viewName?: string;
  pos?: { x: number; y: number; w: number; h: number };
  config?: Record<string, unknown>;
  overrides?: Record<string, unknown>;
}

/**
 * Serialize a live workspace into a `PackageDefinition`. READ-ONLY. The caller
 * MUST have already authorized read access to `workspaceId` (the Hub route gates
 * on the workspace membership before calling this).
 */
export async function workspaceToPackageDefinition(opts: {
  workspaceId: string;
  /** Actor whose lens resolves accessible profiles (owner/member). */
  userId: string;
}): Promise<PackageDefinition> {
  const { workspaceId, userId } = opts;
  const dbConn = await getDb();

  // ── Workspace row + settings ────────────────────────────────────────────
  const ws = await dbConn.query.workspaces.findFirst({
    where: eq(workspacesTable.id, workspaceId),
  });
  if (!ws) throw new Error(`workspace ${workspaceId} not found`);
  const settings = (ws.settings as WorkspaceSettings | null) ?? {};

  const def: PackageDefinition = {
    workspaceName: ws.name,
    ...(ws.description ? { description: ws.description } : {}),
  };

  const meta: NonNullable<PackageDefinition["_meta"]> = {
    slug: settings.packageSlug ?? ws.name.toLowerCase().replace(/\s+/g, "-"),
  };
  if (settings.packageVersion) meta.version = settings.packageVersion;
  def._meta = meta;

  if (settings.workspaceSubtype)
    def.workspaceSubtype = settings.workspaceSubtype;
  if (settings.workspaceVisibility)
    def.workspaceVisibility = settings.workspaceVisibility;
  if (settings.workspaceCapabilities)
    def.workspaceCapabilities = settings.workspaceCapabilities;
  // NOTE: `icon`/`color`/`domain` have no dedicated slot on a live workspace's
  // `settings` (icon lives on `_meta` for a PUBLISHED template, `domain` is a
  // column with no PackageDefinition field) — an author sets them at publish
  // time. `_meta.slug`/`version` above are the stable provenance we can recover.
  if (settings.onboarding)
    def.onboarding = settings.onboarding as PackageDefinition["onboarding"];
  if (settings.profileEntityBentoTemplates)
    def.profileEntityBentoTemplates = settings.profileEntityBentoTemplates;
  // NOTE: settings.actionPlacements are emitted at the END — stored placements
  // carry resolved row-ids in `ref`, and the apply door expects NAMES, so they
  // are re-named once the playbook/automation id→name maps are built.

  // ── Profiles + effective (workspace-lensed) properties ──────────────────
  const profileRepo = new ProfileRepository(dbConn);
  const resolution = new ProfileResolutionService(dbConn);
  const accessible = await profileRepo.getAccessibleProfiles(
    userId,
    workspaceId
  );

  const emittedProfiles: NonNullable<PackageDefinition["profiles"]> = [];
  /** slug → profile.id, for entityLink source/target resolution. */
  const profileIdBySlug: Record<string, string> = {};
  const profileIdsEmitted: string[] = [];

  for (const p of accessible) {
    const isWorkspaceOwned =
      (p.scope === ProfileScope.WORKSPACE || p.scope === ProfileScope.USER) &&
      p.workspaceId === workspaceId;
    const effProps = await resolution.getEffectiveProperties(p.id, workspaceId);
    // Reused (SHARED/SYSTEM) profiles: emit ONLY this workspace's overlay props.
    const overlayProps = effProps.filter(
      (ep) => ep.workspaceId === workspaceId
    );
    const propsToEmit = isWorkspaceOwned ? effProps : overlayProps;

    // A pristine SYSTEM/SHARED profile the workspace never extended is not part
    // of THIS workspace's identity — skip it (a re-apply resolves it pod-wide).
    if (!isWorkspaceOwned && overlayProps.length === 0) continue;

    const uiHints = (p.uiHints as Record<string, unknown> | null) ?? {};
    profileIdBySlug[p.slug] = p.id;
    profileIdsEmitted.push(p.id);
    emittedProfiles.push({
      slug: p.slug,
      displayName: p.displayName,
      icon: uiHints.icon as string | undefined,
      color: uiHints.color as string | undefined,
      description: uiHints.description as string | undefined,
      scope: String(p.scope),
      entityScope: p.entityScope as "pod" | "workspace" | undefined,
      semanticSlug: p.semanticSlug,
      profileKind: p.profileKind as "kind" | "role" | undefined,
      applicableKinds: p.applicableKinds ?? undefined,
      properties: propsToEmit.map((ep) => {
        const epHints = (ep.uiHints as Record<string, unknown> | null) ?? {};
        const epConstraints =
          (ep.constraints as Record<string, unknown> | null) ?? {};
        return {
          slug: ep.slug,
          label: (epHints.label as string | undefined) ?? ep.slug,
          valueType: String(ep.valueType),
          inputType: epHints.inputType as string | undefined,
          placeholder: epHints.placeholder as string | undefined,
          enumValues:
            (epHints.enumValues as string[] | undefined) ??
            (epConstraints.enum as string[] | undefined),
          constraints:
            Object.keys(epConstraints).length > 0 ? epConstraints : undefined,
          targetProfileSlug: epConstraints.targetProfileSlug as
            string | undefined,
        };
      }),
    });
  }
  if (emittedProfiles.length > 0) def.profiles = emittedProfiles;

  // ── Views (incl. profile bentos) + home dashboard split ─────────────────
  const wsViews = await dbConn.query.views.findMany({
    where: eq(viewsTable.workspaceId, workspaceId),
  });
  const viewNameById: Record<string, string> = {};
  for (const v of wsViews) if (v.name) viewNameById[v.id] = v.name;
  const slugForProfileId: Record<string, string> = {};
  for (const [slug, id] of Object.entries(profileIdBySlug))
    slugForProfileId[id] = slug;

  /** viewId → viewName inside a bento block list (for re-appliable references). */
  const deRefBlocks = (blocks: StoredBentoBlock[]): StoredBentoBlock[] =>
    blocks.map((b) => {
      if (b.kind === "view" && b.viewId) {
        const nm = viewNameById[b.viewId];
        const next: StoredBentoBlock = { ...b, viewName: nm ?? b.viewName };
        delete next.viewId;
        return next;
      }
      return b;
    });

  const emittedViews: NonNullable<PackageDefinition["views"]> = [];
  for (const v of wsViews) {
    const vMeta = (v.metadata as Record<string, unknown> | null) ?? {};
    // The workspace HOME dashboard is emitted as bentoLayout/bentoViewBlocks.
    if (v.type === "bento" && vMeta.homeScope === "workspace") {
      const blocks = Array.isArray(
        (v.config as Record<string, unknown>)?.blocks
      )
        ? ((v.config as Record<string, unknown>).blocks as StoredBentoBlock[])
        : [];
      const widgetBlocks = blocks.filter((b) => b.kind === "widget");
      const viewBlocks = blocks.filter((b) => b.kind === "view");
      if (widgetBlocks.length > 0) {
        def.bentoLayout = widgetBlocks.map((b) => ({
          widgetType: b.widgetType ?? "empty",
          pos: b.pos ?? { x: 0, y: 0, w: 4, h: 2 },
          config: b.config,
        }));
      }
      if (viewBlocks.length > 0) {
        (def as Record<string, unknown>).bentoViewBlocks = viewBlocks.map(
          (b) => ({
            kind: "view" as const,
            viewName: b.viewId ? viewNameById[b.viewId] : b.viewName,
            pos: b.pos ?? { x: 0, y: 0, w: 4, h: 2 },
            overrides: b.overrides,
          })
        );
      }
      if (v.name) (def as Record<string, unknown>).bentoViewName = v.name;
      continue;
    }

    const scopeIds = (v.scopeProfileIds as string[] | null) ?? [];
    const scopeSlugs = scopeIds
      .map((id) => slugForProfileId[id])
      .filter(Boolean);
    // De-reference any embedded view-blocks so a profile bento re-applies.
    let config = (v.config as Record<string, unknown> | null) ?? undefined;
    if (config && Array.isArray(config.blocks)) {
      config = {
        ...config,
        blocks: deRefBlocks(config.blocks as StoredBentoBlock[]),
      };
    }
    emittedViews.push({
      name: v.name ?? undefined,
      type: v.type,
      scopeProfileSlug: scopeSlugs[0],
      scopeProfileSlugs: scopeSlugs.length > 1 ? scopeSlugs : undefined,
      config,
    });
  }
  if (emittedViews.length > 0) def.views = emittedViews;

  // ── Entity links (schema relations among emitted profiles) ──────────────
  if (profileIdsEmitted.length > 0) {
    const relDefRepo = new RelationDefRepository(dbConn);
    const profileRelRepo = new ProfileRelationRepository(dbConn);
    const relDefs = await relDefRepo.list(workspaceId);
    const relDefById: Record<string, { slug: string; displayName?: string }> =
      {};
    for (const rd of relDefs)
      relDefById[rd.id] = { slug: rd.slug, displayName: rd.displayName };
    const relations = await profileRelRepo.listForProfiles(profileIdsEmitted);
    const seen = new Set<string>();
    const entityLinks: NonNullable<PackageDefinition["entityLinks"]> = [];
    for (const r of relations) {
      const sourceSlug = slugForProfileId[r.sourceProfileId];
      const targetSlug = slugForProfileId[r.targetProfileId];
      const relDef = relDefById[r.relationDefId];
      if (!sourceSlug || !targetSlug || !relDef) continue;
      const key = `${sourceSlug}->${targetSlug}:${relDef.slug}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entityLinks.push({
        sourceProfileSlug: sourceSlug,
        targetProfileSlug: targetSlug,
        type: relDef.slug,
        label: relDef.displayName,
      });
    }
    if (entityLinks.length > 0) def.entityLinks = entityLinks;
  }

  // ── Display templates (entity card templates) ───────────────────────────
  const displayTemplateRows = await db
    .select({
      name: entityTemplates.name,
      description: entityTemplates.description,
      entityType: entityTemplates.entityType,
      targetType: entityTemplates.targetType,
      isDefault: entityTemplates.isDefault,
      config: entityTemplates.config,
    })
    .from(entityTemplates)
    .where(eq(entityTemplates.workspaceId, workspaceId));
  if (displayTemplateRows.length > 0) {
    def.displayTemplates = displayTemplateRows.map((t) => ({
      name: t.name,
      description: t.description ?? undefined,
      entityType: t.entityType ?? undefined,
      targetType: t.targetType,
      isDefault: t.isDefault,
      config: (t.config as Record<string, unknown>) ?? {},
    }));
  }

  // ── Automations ─────────────────────────────────────────────────────────
  const automationRows = await db
    .select({
      name: automationsTable.name,
      description: automationsTable.description,
      triggerType: automationsTable.triggerType,
      triggerConfig: automationsTable.triggerConfig,
      flowDefinition: automationsTable.flowDefinition,
      status: automationsTable.status,
    })
    .from(automationsTable)
    .where(eq(automationsTable.workspaceId, workspaceId));
  /** Automation name → itself, for actionPlacement ref re-naming (already a name). */
  if (automationRows.length > 0) {
    def.automations = automationRows.map((a) => {
      const flow = a.flowDefinition as {
        nodes?: unknown[];
        edges?: unknown[];
      } | null;
      const trig = (a.triggerConfig as Record<string, unknown>) ?? {};
      return {
        name: a.name,
        description: a.description ?? undefined,
        trigger: {
          type: a.triggerType as "event" | "cron" | "webhook" | "manual",
          eventPattern: trig.eventPattern as string | undefined,
          cron: trig.cron as string | undefined,
          filters: trig.filters as Record<string, unknown> | undefined,
        },
        flow: flow
          ? {
              nodes: (flow.nodes as Array<Record<string, unknown>>) ?? [],
              edges: (flow.edges as Array<Record<string, unknown>>) ?? [],
            }
          : undefined,
        status: a.status as "draft" | "active" | "paused" | undefined,
      };
    });
  }

  // ── Playbooks (+ grants from links) ─────────────────────────────────────
  const playbookRows = await db
    .select({
      id: playbooksTable.id,
      name: playbooksTable.name,
      description: playbooksTable.description,
      goalTemplate: playbooksTable.goalTemplate,
      params: playbooksTable.params,
      executor: playbooksTable.executor,
      inputStrategy: playbooksTable.inputStrategy,
      channelSpec: playbooksTable.channelSpec,
      schedule: playbooksTable.schedule,
      subjectProfile: playbooksTable.subjectProfile,
      status: playbooksTable.status,
    })
    .from(playbooksTable)
    .where(eq(playbooksTable.workspaceId, workspaceId));

  if (playbookRows.length > 0) {
    // Resolve each playbook's `grants` link edges (playbook --grants--> tool|skill)
    // back to the tool/skill NAMES the apply door re-resolves.
    const playbookIds = playbookRows.map((p) => p.id);
    const grantEdges = await db
      .select({
        fromId: linksTable.fromId,
        toType: linksTable.toType,
        toId: linksTable.toId,
      })
      .from(linksTable)
      .where(
        and(
          eq(linksTable.fromType, "playbook"),
          eq(linksTable.linkType, "grants"),
          inArray(linksTable.fromId, playbookIds)
        )
      );
    const toolIds = grantEdges
      .filter((e) => e.toType === "tool")
      .map((e) => e.toId);
    const skillIds = grantEdges
      .filter((e) => e.toType === "skill")
      .map((e) => e.toId);
    const toolNameById: Record<string, string> = {};
    if (toolIds.length > 0) {
      const rows = await db
        .select({ id: toolsTable.id, name: toolsTable.name })
        .from(toolsTable)
        .where(inArray(toolsTable.id, toolIds));
      for (const r of rows) toolNameById[r.id] = r.name;
    }
    const skillNameById: Record<string, string> = {};
    if (skillIds.length > 0) {
      const rows = await db
        .select({ id: skillsTable.id, name: skillsTable.name })
        .from(skillsTable)
        .where(inArray(skillsTable.id, skillIds));
      for (const r of rows) skillNameById[r.id] = r.name;
    }
    const grantsByPlaybook: Record<string, string[]> = {};
    for (const e of grantEdges) {
      const name =
        e.toType === "tool" ? toolNameById[e.toId] : skillNameById[e.toId];
      if (!name) continue;
      (grantsByPlaybook[e.fromId] ??= []).push(name);
    }

    def.playbooks = playbookRows.map((p) => {
      const inputStrategy = p.inputStrategy as { kind?: string } | null;
      return {
        name: p.name,
        description: p.description ?? undefined,
        goalTemplate: p.goalTemplate,
        params: p.params as NonNullable<
          PackageDefinition["playbooks"]
        >[number]["params"],
        executor: p.executor as "is-agent" | "external-agent" | "hybrid",
        inputStrategy: inputStrategy?.kind as
          "none" | "static" | "rotating" | "query" | undefined,
        channelSpec: p.channelSpec as NonNullable<
          PackageDefinition["playbooks"]
        >[number]["channelSpec"],
        schedule: p.schedule as { cron: string } | null,
        subjectProfile: p.subjectProfile as
          { profileSlug: string; filter?: Record<string, unknown> } | undefined,
        grants: grantsByPlaybook[p.id],
        status: p.status as "draft" | "active" | "paused" | undefined,
      };
    });
  }

  // ── Capabilities (containers → templateKey) ─────────────────────────────
  const capabilityRows = await db
    .select({
      name: capabilitiesTable.name,
      metadata: capabilitiesTable.metadata,
    })
    .from(capabilitiesTable)
    .where(eq(capabilitiesTable.workspaceId, workspaceId));
  const capabilities: NonNullable<PackageDefinition["capabilities"]> = [];
  for (const cap of capabilityRows) {
    const templateKey = (cap.metadata as { templateKey?: string } | null)
      ?.templateKey;
    if (!templateKey) continue; // no inline shape to reconstruct losslessly
    capabilities.push({ templateKey });
  }
  if (capabilities.length > 0) def.capabilities = capabilities;

  // ── Sidebar layout ──────────────────────────────────────────────────────
  if (
    settings.layout?.sidebarItems &&
    settings.layout.sidebarItems.length > 0
  ) {
    def.layoutConfig = {
      ...(settings.layout.pinnedApps
        ? { pinnedApps: settings.layout.pinnedApps }
        : {}),
      ...(settings.layout.defaultView
        ? { defaultView: settings.layout.defaultView }
        : {}),
      ...(settings.layout.theme ? { theme: settings.layout.theme } : {}),
      sidebarItems: settings.layout.sidebarItems as NonNullable<
        PackageDefinition["layoutConfig"]
      >["sidebarItems"],
    };
  }

  // ── Action placements (settings) — re-name playbook/automation refs ─────
  if (settings.actionPlacements && settings.actionPlacements.length > 0) {
    const pbNameById: Record<string, string> = {};
    for (const p of playbookRows) pbNameById[p.id] = p.name;
    const autoNameById: Record<string, string> = {};
    if (def.automations) {
      // automationRows carry names but not ids in the select above — fetch ids.
      const autoRows = await db
        .select({ id: automationsTable.id, name: automationsTable.name })
        .from(automationsTable)
        .where(eq(automationsTable.workspaceId, workspaceId));
      for (const a of autoRows) autoNameById[a.id] = a.name;
    }
    (def as Record<string, unknown>).actionPlacements =
      settings.actionPlacements.map((p) => {
        let ref = p.ref;
        if (p.kind === "playbook" && pbNameById[p.ref]) ref = pbNameById[p.ref];
        else if (p.kind === "automation" && autoNameById[p.ref])
          ref = autoNameById[p.ref];
        return { ...p, ref };
      });
  }

  return def;
}
