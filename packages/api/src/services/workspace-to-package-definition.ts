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
  ne,
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
  widgetDefinitions as widgetDefinitionsTable,
  type PackageDefinition,
  type PackageCellDef,
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
  const viewSlugById: Record<string, string> = {};
  for (const v of wsViews) if (v.name) viewNameById[v.id] = v.name;
  for (const v of wsViews) {
    const config = (v.config as Record<string, unknown> | null) ?? {};
    if (typeof config.slug === "string") viewSlugById[v.id] = config.slug;
  }
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

  // ── Cells (Cards authored in this workspace's Cell Studio) ──────────────
  //
  // AUTHORED vs INSTALLED — the boundary, made explicit:
  //   - A Card AUTHORED here (`widgetDefinitions.upsert`, Cell Studio) belongs
  //     in the export: it is this workspace's own code, and the whole point of
  //     `--from-workspace` is that "your running workspace IS the package".
  //   - A cell INSTALLED from another package (`defineCell`'s package-install
  //     path — `market.install({kind:"cell"})` or a package's inline
  //     `cells[]` applied through `installCellFromDefinition`) is NOT
  //     re-emitted here. Doing so would copy another author's code into THIS
  //     package under a new slug — silently forking it out of its own
  //     lifecycle (updates, licensing, attribution) and, per `defineCell`,
  //     stamping it with a NEW `cell:<thisPackageSlug>:<key>` typeKey that no
  //     longer round-trips to the original. There is no dependency mechanism
  //     to fall back on either: `dependencies` is itself one of the keys this
  //     serializer cannot emit (`EXPORTER_UNEMITTED_KEYS` in
  //     `synap-cli/src/lib/exporter-coverage.ts`) — so an installed cell is
  //     simply excluded, and the author keeps the marketplace's normal
  //     "depend on / install" relationship with it instead of an implicit
  //     copy that pretends to be original work.
  //
  // The AUTHORITATIVE signal for "authored, not installed" is
  // `category !== "installed"`: `defineCell` (the ONE door every
  // package-install path funnels through) always writes `category:
  // "installed"` on the row it upserts (see `services/cells/define-cell.ts`),
  // while the authoring door (`widgetDefinitions.upsert`) defaults to
  // `"app-specific"` or whatever the author picked — never `"installed"`. The
  // `typeKey` prefix (`cell:<pkg>:<key>`, minted by `packageCellTypeKey`) is
  // checked too, belt-and-suspenders, in case a row's category was ever
  // hand-edited out of band.
  //
  // `code` (the CP/pod schema's required field) is `rendererSource` — the raw
  // ESM source for both `iframe` and `frame` renderer types (there is no
  // executable `native` renderer any more; see `NATIVE_RENDERER_REJECTED`).
  // Only `isActive` rows are emitted — a soft-deleted Card should not be
  // resurrected by a re-export.
  const cellRows = await db
    .select()
    .from(widgetDefinitionsTable)
    .where(
      and(
        eq(widgetDefinitionsTable.workspaceId, workspaceId),
        eq(widgetDefinitionsTable.isActive, true),
        ne(widgetDefinitionsTable.category, "installed")
      )
    );
  const emittedCells: PackageCellDef[] = [];
  for (const c of cellRows) {
    if (c.typeKey.startsWith("cell:")) continue; // belt-and-suspenders — see above
    if (!c.rendererSource) continue; // nothing to emit as `code` (required)
    // A `builtin` row's "renderer" is HOST code keyed by name — there is nothing
    // a package can carry that would reconstitute it on another pod, and
    // emitting it would publish a row that installs as a `frame` cell with
    // source that was never meant to be evaluated. Declared loss, not a silent
    // one: the export simply does not claim to carry builtins. (`native` cannot
    // occur — NATIVE_RENDERER_REJECTED.)
    if (c.rendererType !== "iframe" && c.rendererType !== "frame") continue;
    const cell: PackageCellDef = {
      key: c.typeKey,
      name: c.name,
      code: c.rendererSource,
      // The MECHANISM, carried explicitly. This select had NO filter on
      // `rendererType` and the payload no slot for it, so an `iframe` HTML Card
      // exported, published, and installed elsewhere as an ESM React cell —
      // `defineCell` applied its `"frame"` default — and failed to mount at
      // every hop, silently. Emitted for BOTH values rather than only the
      // non-default: an explicit `"frame"` costs nothing and makes the round
      // trip readable.
      rendererType: c.rendererType,
    };
    if (c.deps && Object.keys(c.deps).length > 0) cell.deps = c.deps;
    if (c.defaultSize) cell.defaultSize = c.defaultSize;
    // Minimum grid footprint. `widget_definitions` stores it and `defineCell`
    // accepts it, but the package payload had no slot — so an authored Card
    // round-tripped without its floor and could land in a grid too small to
    // render anything.
    if (c.minSize) cell.minSize = c.minSize;
    if (c.configSchema && Object.keys(c.configSchema).length > 0)
      cell.configSchema = c.configSchema;
    if (c.viewRendererViewTypes && c.viewRendererViewTypes.length > 0)
      cell.viewTypes = c.viewRendererViewTypes;
    // EGRESS IS EMITTED UNCONDITIONALLY, INCLUDING EMPTY.
    //
    // Every other field here is omit-is-silence all the way down: absent ⇒
    // `installCellFromDefinition` passes `undefined` ⇒ `defineCell` leaves the
    // stored value alone. For a SECURITY ALLOWLIST that makes revocation
    // unrepresentable — an author removes an origin, re-exports, re-installs,
    // and the OLD grant survives on the target pod. Grants would widen easily
    // and never narrow, and per migration 0249 there is no cell reconciler to
    // catch it later.
    //
    // An explicit `[]` IS the revocation on the wire: `normalizeStringList`
    // maps it to `null`, which `defineCell` writes as "reaches no external
    // origin". Emitting it always also means a re-export of an ungranted Card
    // states its containment rather than merely failing to mention it.
    cell.externalHosts = c.externalHosts ?? [];
    if (c.contentKind && c.contentKind !== "widget")
      cell.contentKind = c.contentKind;
    emittedCells.push(cell);
  }
  if (emittedCells.length > 0) def.cells = emittedCells;

  // ── Workspace layout ────────────────────────────────────────────────────
  // Serialize every persisted layout field, not only workspaces that happen to
  // have sidebar items. In particular, retain an explicit
  // `primarySurface: null`: that is a meaningful "return to workspace home"
  // instruction when this package is later reconciled.
  if (settings.layout) {
    const liveLayout = settings.layout;
    const primarySurface = (() => {
      if (
        !Object.prototype.hasOwnProperty.call(liveLayout, "primarySurface") ||
        liveLayout.primarySurface == null ||
        liveLayout.primarySurface.kind !== "view"
      ) {
        return liveLayout.primarySurface;
      }
      const viewName = viewNameById[liveLayout.primarySurface.viewId];
      if (!viewName) {
        throw new Error(
          `Cannot export primary view ${liveLayout.primarySurface.viewId}: workspace view not found`
        );
      }
      return {
        kind: "view" as const,
        viewName,
        ...(viewSlugById[liveLayout.primarySurface.viewId]
          ? { viewSlug: viewSlugById[liveLayout.primarySurface.viewId] }
          : {}),
        ...(liveLayout.primarySurface.title
          ? { title: liveLayout.primarySurface.title }
          : {}),
      };
    })();
    const layoutConfig: NonNullable<PackageDefinition["layoutConfig"]> = {
      ...(liveLayout.pinnedApps ? { pinnedApps: liveLayout.pinnedApps } : {}),
      ...(liveLayout.defaultView
        ? { defaultView: liveLayout.defaultView }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(liveLayout, "primarySurface")
        ? { primarySurface }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(liveLayout, "defaultApp")
        ? { defaultApp: liveLayout.defaultApp }
        : {}),
      ...(liveLayout.theme ? { theme: liveLayout.theme } : {}),
      ...(liveLayout.sidebarItems
        ? {
            sidebarItems: liveLayout.sidebarItems as NonNullable<
              PackageDefinition["layoutConfig"]
            >["sidebarItems"],
          }
        : {}),
    };
    if (Object.keys(layoutConfig).length > 0) {
      def.layoutConfig = layoutConfig;
    }
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
