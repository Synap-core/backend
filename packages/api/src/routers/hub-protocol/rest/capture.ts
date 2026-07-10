/**
 * Hub Protocol REST — capture (AI-powered tab clustering, structure, execute)
 */

import { randomUUID } from "crypto";

import { z } from "zod";

import {
  captureRouter,
  buildAvailableProfiles,
  type AccessibleProfileLike,
} from "../../capture.js";
import {
  adaptItems,
  type ImportSource,
} from "../../../import/import-adapters.js";
import {
  buildImportProposal,
  importProposalToComposite,
} from "../../../import/import-items.js";
import { aiEnrichImportItems } from "../../../import/import-ai.js";
import {
  deepStructureImportItems,
  makeGraphResolver,
} from "../../../import/import-deep.js";
import { searchService } from "@synap/search";
import {
  resolveIntelligenceService,
  getDefaultActiveService,
} from "../../../utils/intelligence-routing.js";
import { createEventBackedProposal } from "../../../utils/event-backed-proposal.js";
import { materializeCompositeGraph } from "../../../utils/materialize-composite.js";
import { entitiesRouter as regularEntitiesRouter } from "../../entities.js";
import { relationsRouter } from "../../relations.js";
import {
  db,
  getDb,
  ProfileResolutionService,
  eq,
  workspaces,
  workspaceMembers,
} from "@synap/database";
import type { Context } from "../../../types/context.js";
import { createHubProtocolCallerContext } from "../utils.js";
import { resolveCaptureActorUserId } from "../../../services/capture-agent/resolve-capture-actor.js";
import { submitCaptureGraph } from "../../../services/capture-agent/submit-capture-graph.js";
import { ErrorSchema } from "./_codecs/_openapi.js";
import {
  CaptureExecuteRequestSchema,
  CaptureStructureRequestSchema,
  ClusterTabsRequestSchema,
  ClusterTabsResponseSchema,
  ImportRequestSchema,
} from "./_codecs/misc.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  resolveActingContext,
  hasScope,
  logger,
  type HubHono,
} from "./_shared.js";

export function registerCaptureRoutes(app: HubHono): void {
  // ── OpenAPI metadata ─────────────────────────────────────────────────────
  registerOpenApi(app, {
    method: "post",
    path: "/capture/cluster-tabs",
    tags: ["Capture"],
    summary: "Cluster open browser tabs into topic groups",
    description:
      "Forwards tabs to the Intelligence Service for AI clustering and returns a list of named clusters with each cluster's tabs.",
    request: {
      body: ClusterTabsRequestSchema,
    },
    responses: {
      200: { description: "Tab clusters", schema: ClusterTabsResponseSchema },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      502: { description: "Upstream IS error", schema: ErrorSchema },
      503: {
        description: "Clustering service unavailable",
        schema: ErrorSchema,
      },
    },
  });

  registerOpenApi(app, {
    method: "post",
    path: "/capture/structure",
    tags: ["Capture"],
    summary: "AI-structure raw input into entity proposals",
    description:
      "Sends free-form text (and optional URL/HTML/context) to the AI capture pipeline. Returns proposed entities ready for /capture/execute.",
    request: {
      body: CaptureStructureRequestSchema,
    },
    responses: {
      200: {
        description: "Structured entity proposals",
        schema: z.record(z.string(), z.unknown()),
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "post",
    path: "/capture/execute",
    tags: ["Capture"],
    summary: "Materialize structured proposals into entities",
    description:
      "Creates the proposed entities and relations from a /capture/structure response.",
    request: {
      body: CaptureExecuteRequestSchema,
    },
    responses: {
      200: {
        description: "Created entities + relations",
        schema: z.record(z.string(), z.unknown()),
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  /**
   * POST /capture/cluster-tabs
   */
  app.post("/capture/cluster-tabs", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }

    const body = (await c.req.json().catch(() => null)) as {
      tabs?: Array<{
        url: string;
        title: string;
        favIconUrl?: string;
        tabId?: number;
        windowId?: number;
      }>;
    } | null;

    if (!body?.tabs?.length) {
      return c.json({ error: "tabs array required" }, 400);
    }

    // Canonical IS credential resolution (decrypted DB key), not stale env.
    const { endpoint: isUrl, apiKey: isApiKey } =
      await getDefaultActiveService();

    try {
      const simplifiedTabs = body.tabs.map(({ url, title }) => ({
        url,
        title,
      }));

      const res = await fetch(`${isUrl}/api/tools/cluster-tabs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": isApiKey,
        },
        body: JSON.stringify({ tabs: simplifiedTabs }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        logger.warn(
          { status: res.status, err },
          "IS cluster-tabs returned error"
        );
        return c.json({ error: err.error ?? "IS error" }, 502);
      }

      const { clusters } = (await res.json()) as {
        clusters: Array<{
          name: string;
          icon: string;
          tabs: Array<{ url: string; title: string }>;
        }>;
      };

      const urlToFullTab = new Map(body.tabs.map((t) => [t.url, t]));

      const fullClusters = clusters.map((cluster) => ({
        name: cluster.name,
        icon: cluster.icon,
        tabs: cluster.tabs
          .map((t) => urlToFullTab.get(t.url))
          .filter((t): t is NonNullable<typeof t> => t !== undefined),
      }));

      return c.json({ clusters: fullClusters });
    } catch (err) {
      logger.error({ err }, "POST /capture/cluster-tabs failed");
      return c.json({ error: "Clustering service unavailable" }, 503);
    }
  });

  /**
   * POST /capture/structure
   */
  app.post("/capture/structure", async (c) => {
    if (
      !hasScope(c.get("scopes") as string[], "hub-protocol.read") &&
      !hasScope(c.get("scopes") as string[], "mcp.read")
    ) {
      return c.json(
        { error: "Missing scope: hub-protocol.read or mcp.read" },
        403
      );
    }

    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    // Single source of truth: validate with the same codec the OpenAPI spec
    // publishes (avoids an inline shadow drifting from the published schema).
    const parsed = CaptureStructureRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid request body", details: parsed.error.issues },
        400
      );
    }

    const body = parsed.data;
    const acting = await resolveActingContext(c, body);
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);
    const { userId, workspaceId } = acting;

    try {
      const scopes = c.get("scopes") as string[];
      const ctx = await createHubProtocolCallerContext(
        userId,
        scopes,
        workspaceId
      );
      const caller = captureRouter.createCaller(
        ctx as Parameters<typeof captureRouter.createCaller>[0]
      );
      const result = await caller.structure({
        text: body.text,
        file: body.file,
        url: body.url,
        html: body.html,
        context: body.context,
        instructions: body.instructions,
        previousEntities: body.previousEntities,
      });
      return c.json(result);
    } catch (err) {
      logger.error({ err, userId }, "POST /capture/structure failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * POST /capture/execute
   */
  app.post("/capture/execute", async (c) => {
    if (
      !hasScope(c.get("scopes") as string[], "hub-protocol.write") &&
      !hasScope(c.get("scopes") as string[], "mcp.write")
    ) {
      return c.json(
        { error: "Missing scope: hub-protocol.write or mcp.write" },
        403
      );
    }

    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    // Single source of truth: validate with the same codec the OpenAPI spec
    // publishes (CaptureExecuteRequestSchema). An inline duplicate here once
    // silently dropped the entity `content` field (Zod strips unknown keys),
    // which broke long-form document materialization end-to-end.
    const parsed = CaptureExecuteRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid request body", details: parsed.error.issues },
        400
      );
    }

    const body = parsed.data;
    const acting = await resolveActingContext(c, body);
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);
    const { userId, workspaceId } = acting;

    try {
      const scopes = c.get("scopes") as string[];
      // Thread the seeded Capture agent as the acting agent for the capture
      // pipeline (always — this endpoint IS the capture flow). NOTE: /capture/
      // execute is a direct first-party write (captureRouter.execute uses
      // entityRepo.create directly and does NOT call checkPermissionOrPropose),
      // so auto-apply does not depend on this — the actor is carried for
      // provenance/consistency with the header-gated shared routes. Graceful
      // fallback to the caller's own id if the Capture agent isn't seeded yet.
      const captureActorUserId = await resolveCaptureActorUserId(c, undefined, {
        always: true,
      });
      const ctx = await createHubProtocolCallerContext(
        userId,
        scopes,
        workspaceId,
        null,
        null,
        captureActorUserId
      );
      const caller = captureRouter.createCaller(
        ctx as Parameters<typeof captureRouter.createCaller>[0]
      );
      // Event-mode scoping: forward the active focus session (X-Session-Id) so
      // captured entities link to it via `session --produced--> entity`. Same
      // header the entities door reads; absent = unchanged behavior.
      const sessionId = c.req.header("x-session-id") || undefined;

      const result = await caller.execute({
        entities: body.entities,
        relations: body.relations ?? [],
        projectId: body.projectId ?? undefined,
        // Forward workspace routing so this door auto-routes like MCP.
        workspaceRouting: body.workspaceRouting,
        aiWorkspaceId: body.aiWorkspaceId,
        aiWorkspaceConfidence: body.aiWorkspaceConfidence,
        aiWorkspaceReason: body.aiWorkspaceReason,
        sessionId,
      });
      return c.json(result);
    } catch (err) {
      logger.error({ err, userId }, "POST /capture/execute failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * POST /import/analyze
   *
   * Source-agnostic import analysis. Takes raw `{ path, content }` records plus a
   * `source` (e.g. "obsidian"), normalizes them to ImportItems via the matching
   * adapter, and returns a GOVERNED structure proposal: which entity types to
   * create, which items map to each, and which cross-references become relations.
   *
   * Review-only (no writes). Deterministic and cheap — safe to run on a whole
   * corpus. The client reviews, then materializes via POST /capture/execute
   * (which carries the proposal/approval gate). This is FAITHFUL ingestion of
   * already-structured data; it is NOT the AI capture path (/capture/structure),
   * which is for turning one unstructured blob into entities.
   */
  app.post("/import/analyze", async (c) => {
    if (
      !hasScope(c.get("scopes") as string[], "hub-protocol.read") &&
      !hasScope(c.get("scopes") as string[], "mcp.read")
    ) {
      return c.json(
        { error: "Missing scope: hub-protocol.read or mcp.read" },
        403
      );
    }

    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = ImportRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid request body", details: parsed.error.issues },
        400
      );
    }

    const body = parsed.data;
    const acting = await resolveActingContext(c, body);
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);
    const { userId, workspaceId } = acting;

    try {
      // Resolve the workspace's REAL profiles → typed hints for the structuring
      // model + the allow-list of slugs that may be assigned as a type.
      const db2 = await getDb();
      const accessible = await new ProfileResolutionService(
        db2
      ).getAccessibleProfiles(userId, workspaceId);
      const availableProfiles = buildAvailableProfiles(
        accessible as unknown as AccessibleProfileLike[]
      );
      const validSlugs = new Set(availableProfiles.map((p) => p.slug));
      // The user's workspaces — for the model's workspace-routing suggestion.
      const wsRows = await db2
        .select({
          id: workspaces.id,
          name: workspaces.name,
          description: workspaces.description,
        })
        .from(workspaces)
        .innerJoin(
          workspaceMembers,
          eq(workspaceMembers.workspaceId, workspaces.id)
        )
        .where(eq(workspaceMembers.userId, userId))
        .limit(8);
      const availableWorkspaces = wsRows.map((w) => ({
        id: w.id,
        name: w.name,
        description: w.description ?? undefined,
      }));

      const items = adaptItems(body.source as ImportSource, body.items);

      // Optional AI pass: route items through bulk-structuring so each note gets
      // a real typed profile + extracted properties. Best-effort: on any IS
      // failure aiEnrichImportItems returns items unchanged and we proceed with
      // the deterministic proposal.
      let aiTyped = 0;
      // Prose (markdown/obsidian) → DEEP extraction: decompose each note into a
      // typed entity graph (the SAME engine as ImportOrchestrator.submitBatch —
      // single source: import-deep). Structured rows stay on the shallow 1:1
      // path. Deep is best-effort; on no yield we fall back to shallow.
      const isProse = body.source === "obsidian" || body.source === "markdown";
      let operations:
        | ReturnType<typeof importProposalToComposite>["operations"]
        | undefined;
      let summary = "";
      let droppedReferences = 0;
      let stats: Record<string, unknown> = {};
      let mode: "deep" | "shallow" = "shallow";

      if (isProse && body.aiStructure !== false) {
        try {
          const { client } = await resolveIntelligenceService({
            userId,
            workspaceId: workspaceId ?? undefined,
            capability: "default",
          });
          const deep = await deepStructureImportItems(
            items,
            client,
            {
              availableProfiles,
              validSlugs,
              availableWorkspaces,
              resolveExisting: makeGraphResolver(searchService, {
                userId,
                workspaceId: workspaceId ?? undefined,
              }),
            },
            { logger }
          );
          if (deep.stats.entityCount > 0) {
            operations = deep.operations;
            aiTyped = deep.stats.entityCount;
            mode = "deep";
            stats = { ...deep.stats };
            const typeCount = Object.keys(deep.stats.byType).length;
            summary = `Deep import ${deep.stats.itemsProcessed} ${body.source} note(s) → ${deep.stats.entityCount} entities (${typeCount} types), ${deep.stats.relationCount} relations`;
          }
        } catch (e) {
          logger.warn(
            { e, userId },
            "import/analyze deep failed, falling back to shallow"
          );
        }
      }

      if (mode === "shallow") {
        if (body.aiStructure !== false) {
          try {
            const { client } = await resolveIntelligenceService({
              userId,
              workspaceId: workspaceId ?? undefined,
              capability: "default",
            });
            const enriched = await aiEnrichImportItems(
              items,
              client,
              { availableProfiles },
              { logger }
            );
            aiTyped = enriched.aiTyped;
          } catch (e) {
            logger.warn(
              { e, userId },
              "import/analyze AI enrich failed, using deterministic"
            );
          }
        }
        const proposal = buildImportProposal(
          items,
          body.relationType,
          validSlugs
        );
        const composite = importProposalToComposite(proposal);
        operations = composite.operations;
        droppedReferences = composite.droppedReferences;
        stats = { ...proposal.stats };
        summary = `Import ${proposal.stats.itemCount} ${body.source} item(s) → ${proposal.stats.typeCount} type(s), ${operations.length - proposal.stats.itemCount} link(s)`;
      }

      const { proposal: created } = await createEventBackedProposal({
        userId,
        workspaceId,
        targetType: "entity",
        targetId: randomUUID(),
        proposalType: "import.graph",
        action: "create",
        source: "intelligence",
        summary,
        data: { operations: operations!, source: body.source },
      });

      logger.info(
        {
          userId,
          workspaceId,
          source: body.source,
          mode,
          proposalId: (created as { id?: string })?.id,
          droppedReferences,
          aiTyped,
          ...stats,
        },
        "POST /import/analyze"
      );
      return c.json({
        workspaceId,
        source: body.source,
        mode,
        proposalId: (created as { id?: string })?.id,
        stats,
        droppedReferences,
        aiTyped,
      });
    } catch (err) {
      logger.error({ err, userId }, "POST /import/analyze failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * POST /import/apply
   *
   * User-initiated DIRECT import: materialize the structured graph (N entities +
   * linked documents + M relations) immediately — NO proposal. This is the
   * user's own data (a deterministic faithful mirror), so per the permission
   * model it follows the "human's own UI action = direct write (with a
   * preview-before from /import/analyze)" rule, not the agent proposal gate.
   *
   * The frontend flow: POST /import/analyze (preview) → user confirms →
   * POST /import/apply (same items) materializes. Reuses the EXACT composite
   * materialization the approve loop uses, so behavior is identical.
   */
  app.post("/import/apply", async (c) => {
    if (
      !hasScope(c.get("scopes") as string[], "hub-protocol.write") &&
      !hasScope(c.get("scopes") as string[], "mcp.write")
    ) {
      return c.json(
        { error: "Missing scope: hub-protocol.write or mcp.write" },
        403
      );
    }

    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = ImportRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid request body", details: parsed.error.issues },
        400
      );
    }
    const body = parsed.data;

    // Bind the acting identity to the authenticated principal and verify the
    // RESOLVED user is a member of the target workspace. This materializes
    // directly (user-initiated, no proposal), so the caller MUST own the write.
    const acting = await resolveActingContext(c, body);
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);
    const { userId, workspaceId, role } = acting;

    try {
      const db2 = await getDb();
      const accessible = await new ProfileResolutionService(
        db2
      ).getAccessibleProfiles(userId, workspaceId);
      const availableProfiles = buildAvailableProfiles(
        accessible as unknown as AccessibleProfileLike[]
      );
      const validSlugs = new Set(availableProfiles.map((p) => p.slug));

      const items = adaptItems(body.source as ImportSource, body.items);

      // Optional AI pass: typed profiles + extracted properties (best-effort).
      let aiTyped = 0;
      if (body.aiStructure !== false) {
        try {
          const { client } = await resolveIntelligenceService({
            userId,
            workspaceId: workspaceId ?? undefined,
            capability: "default",
          });
          const enriched = await aiEnrichImportItems(
            items,
            client,
            { availableProfiles },
            { logger }
          );
          aiTyped = enriched.aiTyped;
        } catch (e) {
          logger.warn(
            { e, userId },
            "import/apply AI enrich failed, using deterministic"
          );
        }
      }

      const proposal = buildImportProposal(
        items,
        body.relationType,
        validSlugs
      );
      const { operations } = importProposalToComposite(proposal);

      // Workspace-scoped caller context — identical shape to the approve loop's
      // compositeCtx, so materialization behaves the same (full side-effects,
      // linked documents, relation FKs).
      const ctx = {
        db,
        authenticated: true as const,
        userId,
        workspaceId,
        workspaceRole: role,
      } as unknown as Context;
      const entityCaller = regularEntitiesRouter.createCaller(ctx);
      const relationCaller = relationsRouter.createCaller(ctx);

      const { created, linked } = await materializeCompositeGraph(
        operations,
        entityCaller,
        relationCaller,
        (err, type) =>
          logger.warn({ err, type }, "import/apply: relation create failed"),
        // Imports are workspace-scoped: pin entities to the target workspace
        // (overrides pod-default profiles) so they isolate to this workspace
        // and are purged when the workspace is deleted.
        { workspaceScoped: true }
      );

      logger.info(
        {
          userId,
          workspaceId,
          source: body.source,
          created,
          linked,
          droppedReferences: proposal.stats.unresolvedReferences,
          aiTyped,
        },
        "POST /import/apply materialized"
      );
      return c.json({
        workspaceId,
        source: body.source,
        created,
        linked,
        stats: proposal.stats,
        aiTyped,
      });
    } catch (err) {
      logger.error({ err, userId }, "POST /import/apply failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * POST /capture/graph
   *
   * Propose a whole CRM graph in ONE reviewable composite proposal — the
   * keystone of the "understand the server → propose entities + relations"
   * flow. Takes the agent's DESIGNED graph ({ entities, relations }) and creates
   * a single `import.graph` proposal whose approval materializes everything
   * atomically via materializeCompositeGraph (the exact path /import/apply uses).
   * The operator reviews + accepts ONCE instead of approving N single proposals.
   *
   * Entities may CREATE (profileSlug + title/properties) or LINK an existing
   * entity (existingEntityId) so the graph mixes new + known without duplicates.
   * Relations reference entities by their `ref` (resolved to real ids on approve).
   */
  app.post("/capture/graph", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }
    const userId = c.get("userId") as string;
    const body = (await c.req.json().catch(() => null)) as {
      workspaceId?: string;
      entities?: Array<{
        ref: string;
        profileSlug: string;
        title?: string;
        properties?: Record<string, unknown>;
        existingEntityId?: string;
        facets?: Array<{
          profileSlug: string;
          status?: string;
          properties?: Record<string, unknown>;
          contextRef?: string;
        }>;
      }>;
      relations?: Array<{ sourceRef: string; targetRef: string; type: string }>;
      // Discord channel → entity bindings, applied on APPROVE (after the entities
      // materialize): each channel is bound to refToRealId[entityRef] with its
      // firewall role. Lets one accept land entities + relations + channel binds.
      bindings?: Array<{
        externalChannelId: string;
        entityRef: string;
        branchPurpose?: "client-comms" | "team";
        title?: string;
      }>;
      summary?: string;
    } | null;

    if (!body || !Array.isArray(body.entities) || body.entities.length === 0) {
      return c.json({ error: "entities[] is required (at least one)" }, 400);
    }
    // Refs must be unique; relations must reference known refs (fail loud — a
    // dangling ref would silently drop the link at materialization time).
    const refs = new Set<string>();
    for (const e of body.entities) {
      if (!e.ref || !e.profileSlug) {
        return c.json(
          { error: "each entity needs a `ref` and a `profileSlug`" },
          400
        );
      }
      if (refs.has(e.ref)) {
        return c.json({ error: `duplicate entity ref: ${e.ref}` }, 400);
      }
      refs.add(e.ref);
    }
    let relations = Array.isArray(body.relations) ? body.relations : [];
    for (const r of relations) {
      if (!refs.has(r.sourceRef) || !refs.has(r.targetRef)) {
        return c.json(
          {
            error: `relation references an unknown ref: ${r.sourceRef} -> ${r.targetRef}`,
          },
          400
        );
      }
    }
    let bindings = Array.isArray(body.bindings) ? body.bindings : [];
    for (const b of bindings) {
      if (!b.externalChannelId || !b.entityRef) {
        return c.json(
          { error: "each binding needs `externalChannelId` and `entityRef`" },
          400
        );
      }
      if (!refs.has(b.entityRef)) {
        return c.json(
          { error: `binding references an unknown entity ref: ${b.entityRef}` },
          400
        );
      }
    }

    try {
      // The within-batch dedup, persisted-entity dedup, operations build, and
      // event-backed proposal all live in the shared core so in-process
      // producers (Cal.com webhook/backfill) go through the SAME door path.
      const result = await submitCaptureGraph({
        userId,
        workspaceId: body.workspaceId ?? null,
        entities: body.entities,
        relations,
        bindings,
        summary: body.summary,
      });
      logger.info(
        {
          userId,
          workspaceId: body.workspaceId,
          entityCount: result.entityCount,
          relationCount: result.relationCount,
          proposalId: result.proposalId,
        },
        "POST /capture/graph"
      );
      return c.json(result);
    } catch (err) {
      logger.error({ err, userId }, "POST /capture/graph failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}
