/**
 * Hub Protocol REST — capture (AI-powered tab clustering, structure, execute)
 */

import { randomUUID } from "crypto";

import { z } from "zod";

import { captureRouter } from "../../capture.js";
import { adaptItems, type ImportSource } from "../../../utils/import-adapters.js";
import {
  buildImportProposal,
  importProposalToComposite,
} from "../../../utils/import-items.js";
import { createEventBackedProposal } from "../../../utils/event-backed-proposal.js";
import { createHubProtocolCallerContext } from "../utils.js";
import { ErrorSchema } from "./_codecs/_openapi.js";
import {
  CaptureExecuteRequestSchema,
  CaptureStructureRequestSchema,
  ClusterTabsRequestSchema,
  ClusterTabsResponseSchema,
} from "./_codecs/misc.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  getUserAccessibleWorkspaceIds,
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

    const bodySchema = z.object({
      userId: z.string().min(1),
      text: z.string().min(1).max(8000),
      url: z.string().url().optional(),
      html: z.string().max(50_000).optional(),
      context: z.string().optional(),
      workspaceId: z.string().uuid().optional(),
      previousEntities: z
        .array(
          z.object({
            tempId: z.string(),
            profileSlug: z.string(),
            title: z.string(),
            description: z.string().optional(),
            properties: z.record(z.string(), z.unknown()).optional(),
          })
        )
        .optional(),
    });

    const parsed = bodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid request body", details: parsed.error.issues },
        400
      );
    }

    const body = parsed.data;
    const userId = body.userId;

    let workspaceId = body.workspaceId;
    if (!workspaceId) {
      const wsIds = await getUserAccessibleWorkspaceIds(userId);
      workspaceId = wsIds[0];
      if (!workspaceId) {
        return c.json(
          { error: "No accessible workspace found for this user" },
          400
        );
      }
    }

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

    const bodySchema = z.object({
      userId: z.string().min(1),
      workspaceId: z.string().uuid().optional(),
      entities: z.array(
        z.object({
          tempId: z.string(),
          profileSlug: z.string(),
          title: z.string(),
          description: z.string().optional(),
          properties: z.record(z.string(), z.unknown()).optional(),
          /** Link to an existing entity instead of creating a new one */
          existingEntityId: z.string().uuid().optional(),
        })
      ),
      relations: z
        .array(
          z.object({
            sourceTempId: z.string(),
            targetTempId: z.string(),
            relationType: z.string(),
          })
        )
        .optional(),
    });

    const parsed = bodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid request body", details: parsed.error.issues },
        400
      );
    }

    const body = parsed.data;
    const userId = body.userId;

    let workspaceId = body.workspaceId;
    if (!workspaceId) {
      const wsIds = await getUserAccessibleWorkspaceIds(userId);
      workspaceId = wsIds[0];
      if (!workspaceId) {
        return c.json(
          { error: "No accessible workspace found for this user" },
          400
        );
      }
    }

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

    const bodySchema = z.object({
      userId: z.string().min(1),
      workspaceId: z.string().uuid().optional(),
      source: z.enum(["obsidian"]),
      /** Relation type for cross-references (default "references"). */
      relationType: z.string().min(1).max(64).optional(),
      items: z
        .array(
          z.object({
            /** Source-relative path, e.g. "Projects/Launch.md". */
            path: z.string().min(1).max(1024),
            content: z.string().max(200_000),
          })
        )
        .min(1)
        .max(2000),
    });

    const parsed = bodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid request body", details: parsed.error.issues },
        400
      );
    }

    const body = parsed.data;

    // Resolve workspace (membership-scoped) — consistent with /capture/*.
    let workspaceId = body.workspaceId;
    if (!workspaceId) {
      const wsIds = await getUserAccessibleWorkspaceIds(body.userId);
      workspaceId = wsIds[0];
      if (!workspaceId) {
        return c.json(
          { error: "No accessible workspace found for this user" },
          400
        );
      }
    }

    try {
      const items = adaptItems(body.source as ImportSource, body.items);
      const proposal = buildImportProposal(items, body.relationType);
      // Also hand back a ready-to-run capture.execute payload so the client can
      // materialize the approved proposal with a single forward call (no glue).
      // Bridge to ONE governed graph composite proposal: N entities + M
      // relations, approved atomically. Materialization is deferred to human
      // approval (the generalized composite branch in proposals.ts resolves
      // each tempId ref → real entity id and creates the whole graph in order).
      const { operations, droppedReferences } =
        importProposalToComposite(proposal);
      const summary = `Import ${proposal.stats.itemCount} ${body.source} item(s) → ${proposal.stats.typeCount} type(s), ${operations.length - proposal.stats.itemCount} link(s)`;
      const { proposal: created } = await createEventBackedProposal({
        userId: body.userId,
        workspaceId,
        targetType: "entity",
        targetId: randomUUID(),
        proposalType: "import.graph",
        action: "create",
        source: "intelligence",
        summary,
        data: { operations, source: body.source },
      });

      logger.info(
        {
          userId: body.userId,
          workspaceId,
          source: body.source,
          proposalId: (created as { id?: string })?.id,
          items: proposal.stats.itemCount,
          types: proposal.stats.typeCount,
          references: proposal.stats.referenceCount,
          droppedReferences,
        },
        "POST /import/analyze"
      );
      return c.json({
        workspaceId,
        source: body.source,
        proposalId: (created as { id?: string })?.id,
        ...proposal,
        droppedReferences,
      });
    } catch (err) {
      logger.error({ err, userId: body.userId }, "POST /import/analyze failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}
