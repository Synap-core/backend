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
import { resolveIntelligenceService } from "../../../utils/intelligence-routing.js";
import { createEventBackedProposal } from "../../../utils/event-backed-proposal.js";
import { materializeCompositeGraph } from "../../../utils/materialize-composite.js";
import { entitiesRouter as regularEntitiesRouter } from "../../entities.js";
import { relationsRouter } from "../../relations.js";
import { db, getDb, ProfileResolutionService } from "@synap/database";
import type { Context } from "../../../types/context.js";
import { createHubProtocolCallerContext } from "../utils.js";
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

    const isUrl = process.env.INTELLIGENCE_HUB_URL ?? "http://localhost:3002";
    const isApiKey = process.env.INTELLIGENCE_HUB_API_KEY ?? "";

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
        url: body.url,
        html: body.html,
        context: body.context,
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
      const ctx = await createHubProtocolCallerContext(
        userId,
        scopes,
        workspaceId
      );
      const caller = captureRouter.createCaller(
        ctx as Parameters<typeof captureRouter.createCaller>[0]
      );
      const result = await caller.execute({
        entities: body.entities,
        relations: body.relations ?? [],
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
            workspaceId,
            capability: "default",
          });
          const deep = await deepStructureImportItems(
            items,
            client,
            {
              availableProfiles,
              validSlugs,
              resolveExisting: makeGraphResolver(searchService, {
                userId,
                workspaceId,
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
              workspaceId,
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
            workspaceId,
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
}
