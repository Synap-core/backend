/**
 * Hub Protocol REST — cell instances
 *
 * IS / agent surface for the persisted cell rendering unit. Agent-origin
 * writes (create, updateConfig) are governed by `checkPermissionOrPropose()` —
 * mirroring the relations/commands hub routes — so an agent's cell write either
 * commits (auto-approve whitelist) or becomes a reviewable proposal.
 *
 * Endpoints:
 *   GET    /cell-instances?workspaceId=&isTemplate=   — list
 *   GET    /cell-instances/:id                        — get
 *   POST   /cell-instances                            — create (governed)
 *   POST   /cell-instances/html                       — createHtmlCell: the page
 *          through the Hub document door (governed `document/create`), the
 *          cell a placement of it
 *   PATCH  /cell-instances/:id/config                 — updateConfig (governed)
 */

import { z } from "zod";
import { db, eq, and, desc, cellInstances } from "@synap/database";
import { insertCellInstance } from "../../../services/cells/create-cell-instance.js";
import {
  getCaller,
  hasScope,
  logger,
  resolveActingContext,
  resolveActorId,
  verifyWorkspaceReadAccess,
  type HubHono,
  httpStatusForTrpcError,
  requireUuidParam,
} from "./_shared.js";
import { jsonGoverned } from "../proposal-response.js";
import { getConfinedWorkspace } from "../confine-workspace.js";

const CreateBodySchema = z.object({
  workspaceId: z.string().uuid(),
  cellType: z.string().min(1),
  config: z.record(z.string(), z.unknown()).optional(),
  name: z.string().optional(),
  isTemplate: z.boolean().optional(),
  sourceDocumentId: z.string().uuid().optional(),
  userId: z.string().optional(),
  agentUserId: z.string().optional(),
  reasoning: z.string().optional(),
  sourceMessageId: z.string().optional(),
});

const CreateHtmlBodySchema = z.object({
  workspaceId: z.string().uuid(),
  html: z.string(),
  name: z.string().optional(),
  /** What the page reads through the frame bridge (checked by the page door). */
  reads: z.unknown().optional(),
  userId: z.string().optional(),
  agentUserId: z.string().optional(),
  reasoning: z.string().optional(),
  sourceMessageId: z.string().optional(),
});

const UpdateConfigBodySchema = z.object({
  workspaceId: z.string().uuid(),
  config: z.record(z.string(), z.unknown()),
  userId: z.string().optional(),
  agentUserId: z.string().optional(),
  reasoning: z.string().optional(),
  sourceMessageId: z.string().optional(),
});

function serialize(row: typeof cellInstances.$inferSelect) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    userId: row.userId,
    cellType: row.cellType,
    config: (row.config ?? {}) as Record<string, unknown>,
    name: row.name,
    isTemplate: row.isTemplate,
    sourceDocumentId: row.sourceDocumentId,
    createdByKind: row.createdByKind,
    trustLevel: row.trustLevel,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function registerCellInstancesRoutes(app: HubHono): void {
  /**
   * GET /cell-instances?workspaceId=...&isTemplate=...
   */
  app.get("/cell-instances", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const workspaceId = c.req.query("workspaceId");
    if (!workspaceId) {
      return c.json({ error: "workspaceId query param is required" }, 400);
    }
    const userId = c.get("userId") as string;
    if (!(await verifyWorkspaceReadAccess(userId, workspaceId))) {
      return c.json({ error: "Access denied to workspace" }, 403);
    }
    const isTemplateRaw = c.req.query("isTemplate");
    const isTemplate =
      isTemplateRaw === undefined
        ? undefined
        : isTemplateRaw === "true"
          ? true
          : isTemplateRaw === "false"
            ? false
            : undefined;
    try {
      const where =
        isTemplate === undefined
          ? eq(cellInstances.workspaceId, workspaceId)
          : and(
              eq(cellInstances.workspaceId, workspaceId),
              eq(cellInstances.isTemplate, isTemplate)
            );
      const rows = await db
        .select()
        .from(cellInstances)
        .where(where)
        .orderBy(desc(cellInstances.updatedAt));
      return c.json(rows.map(serialize));
    } catch (err) {
      logger.error({ err }, "cellInstances.list failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        httpStatusForTrpcError(err)
      );
    }
  });

  /**
   * GET /cell-instances/:id
   */
  app.get("/cell-instances/:id", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const id = requireUuidParam(c, "id");
    if (id instanceof Response) return id;
    try {
      const [row] = await db
        .select()
        .from(cellInstances)
        .where(eq(cellInstances.id, id))
        .limit(1);
      if (!row) return c.json({ error: "Cell instance not found" }, 404);
      const userId = c.get("userId") as string;
      if (!(await verifyWorkspaceReadAccess(userId, row.workspaceId))) {
        return c.json({ error: "Access denied to workspace" }, 403);
      }
      return c.json(serialize(row));
    } catch (err) {
      logger.error({ err }, "cellInstances.get failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        httpStatusForTrpcError(err)
      );
    }
  });

  /**
   * POST /cell-instances — create (governed).
   */
  app.post("/cell-instances", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const raw = (await c.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!raw) return c.json({ error: "Invalid JSON in request body" }, 400);
    const parsed = CreateBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues.map((i) => i.message).join(", ") },
        400
      );
    }
    const body = parsed.data;

    // SECURITY — acting identity MUST come from the verified auth context,
    // never `body.userId` directly (governed-agent-write → ungoverned-
    // operator-write IDOR). Mirrors POST /profiles / POST /property-defs.
    //
    // Item 3 Part 3: positively pin a bound service key to its workspace
    // BEFORE it reaches resolveActingContext. The body schema requires
    // workspaceId (z.string().uuid()). A mismatching bound key throws
    // FORBIDDEN → surface 403, not a blanket 500.
    let clampedWorkspaceId: string;
    try {
      clampedWorkspaceId = getConfinedWorkspace(c, body.workspaceId) as string;
    } catch (err) {
      if ((err as { code?: unknown })?.code === "FORBIDDEN")
        return c.json(
          { error: err instanceof Error ? err.message : "Forbidden" },
          403
        );
      throw err;
    }
    const acting = await resolveActingContext(c, {
      userId: body.userId,
      workspaceId: clampedWorkspaceId,
    });
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);
    if (!acting.workspaceId) {
      return c.json({ error: "workspaceId is required" }, 400);
    }
    const userId = acting.userId;
    const workspaceId = acting.workspaceId;
    // Body wins, else the authenticated key's agent — an agent key that does not
    // echo its own id must not resolve as the human (ungoverned + unattributed).
    const resolvedAgentUserId =
      body.agentUserId ?? (c.get("agentUserId") as string | undefined);
    const actorResolution = await resolveActorId(resolvedAgentUserId, userId);
    if ("error" in actorResolution)
      return c.json({ error: actorResolution.error }, 400);

    try {
      const { checkPermissionOrPropose } =
        await import("../../../utils/permission-check.js");
      const perm = await checkPermissionOrPropose({
        userId,
        agentUserId: resolvedAgentUserId,
        workspaceId,
        subjectType: "cell",
        action: "create",
        // "agent" is not a valid EventSource — agent identity is on agentUserId; see SynapEventSchema
        source: "intelligence",
        data: {
          cellType: body.cellType,
          name: body.name,
          userId,
          workspaceId,
          config: body.config ?? {},
          isTemplate: body.isTemplate ?? false,
          sourceDocumentId: body.sourceDocumentId,
          agentUserId: resolvedAgentUserId,
        },
        reasoning: body.reasoning,
        sourceMessageId: body.sourceMessageId,
      });
      if ("denied" in perm && perm.denied) {
        return c.json({ status: "denied", message: perm.reason }, 403);
      }
      if ("proposalId" in perm) {
        return jsonGoverned(c, {
          status: "proposed",
          proposalId: perm.proposalId,
          summary: perm.summary,
          reasoning: perm.reasoning,
          reviewPath: perm.reviewPath,
          reviewUrl: perm.reviewUrl,
        });
      }

      const row = await insertCellInstance({
        workspaceId,
        userId,
        cellType: body.cellType,
        config: body.config,
        name: body.name,
        isTemplate: body.isTemplate,
        sourceDocumentId: body.sourceDocumentId,
        agentUserId: resolvedAgentUserId,
      });

      return c.json(serialize(row));
    } catch (err) {
      logger.error({ err }, "cellInstances.create failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        httpStatusForTrpcError(err)
      );
    }
  });

  /**
   * POST /cell-instances/html — an html page placed as a cell.
   *
   * ONE HTML write door: the page is written
   * by the Hub document door (`documents.createDocument {type: "html"}`, the
   * same code path as `synap_create_document`): its governance
   * (`document/create`), its checks (size cap, declared reads) and its
   * warnings. The html-embed cell is only a placement of that page, made by
   * the same door (`placeAs`): at once when the write applies, on the
   * proposal's approval when it is proposed. The response keeps its shape:
   * the cell (applied), or the governed proposal.
   */
  app.post("/cell-instances/html", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const raw = (await c.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!raw) return c.json({ error: "Invalid JSON in request body" }, 400);
    const parsed = CreateHtmlBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues.map((i) => i.message).join(", ") },
        400
      );
    }
    const body = parsed.data;

    // SECURITY — acting identity MUST come from the verified auth context,
    // never `body.userId` directly (governed-agent-write → ungoverned-
    // operator-write IDOR). Mirrors POST /profiles / POST /property-defs.
    //
    // Item 3 Part 3: positively pin a bound service key to its workspace
    // BEFORE it reaches resolveActingContext. The body schema requires
    // workspaceId (z.string().uuid()). A mismatching bound key throws
    // FORBIDDEN → surface 403, not a blanket 500.
    let clampedWorkspaceId: string;
    try {
      clampedWorkspaceId = getConfinedWorkspace(c, body.workspaceId) as string;
    } catch (err) {
      if ((err as { code?: unknown })?.code === "FORBIDDEN")
        return c.json(
          { error: err instanceof Error ? err.message : "Forbidden" },
          403
        );
      throw err;
    }
    const acting = await resolveActingContext(c, {
      userId: body.userId,
      workspaceId: clampedWorkspaceId,
    });
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);
    if (!acting.workspaceId) {
      return c.json({ error: "workspaceId is required" }, 400);
    }
    const userId = acting.userId;
    const workspaceId = acting.workspaceId;
    // Body wins, else the authenticated key's agent — an agent key that does not
    // echo its own id must not resolve as the human (ungoverned + unattributed).
    const resolvedAgentUserId =
      body.agentUserId ?? (c.get("agentUserId") as string | undefined);
    const actorResolution = await resolveActorId(resolvedAgentUserId, userId);
    if ("error" in actorResolution)
      return c.json({ error: actorResolution.error }, 400);

    try {
      const caller = await getCaller(c, {
        workspaceId,
        userId,
        sourceMessageId: body.sourceMessageId,
      });
      const result = await caller.documents.createDocument({
        userId,
        workspaceId,
        title: body.name?.trim() || "HTML Cell",
        content: body.html,
        type: "html",
        ...(body.reads !== undefined ? { reads: body.reads } : {}),
        ...(body.reasoning ? { reasoning: body.reasoning } : {}),
        ...(resolvedAgentUserId ? { agentUserId: resolvedAgentUserId } : {}),
        // The cell id is reserved by the document door itself.
        placeAs: {
          kind: "html-embed-cell",
          ...(body.name ? { name: body.name } : {}),
        },
      });
      if (result.status === "proposed") {
        return jsonGoverned(c, {
          status: "proposed",
          proposalId: result.proposalId,
          summary: result.summary,
          reasoning: result.reasoning,
          reviewPath: result.reviewPath,
          reviewUrl: result.reviewUrl,
        });
      }
      const cellId = "cellInstanceId" in result ? result.cellInstanceId : null;
      const [row] = cellId
        ? await db
            .select()
            .from(cellInstances)
            .where(eq(cellInstances.id, cellId))
            .limit(1)
        : [];
      if (!row) {
        // The page landed but no cell was placed: never reported as a cell.
        logger.error(
          { documentId: result.documentId },
          "cellInstances.createHtmlCell: page written, cell not placed"
        );
        return c.json(
          {
            error: `The page was written (document ${result.documentId}) but its cell was not placed.`,
          },
          500
        );
      }
      const warnings =
        "warnings" in result && Array.isArray(result.warnings)
          ? result.warnings
          : [];
      return c.json({
        ...serialize(row),
        ...(warnings.length > 0 ? { warnings } : {}),
      });
    } catch (err) {
      // The document door's governance refusal (and an agent the key cannot
      // act as) is FORBIDDEN: the route's `denied` shape, as before.
      if ((err as { code?: unknown })?.code === "FORBIDDEN") {
        return c.json(
          {
            status: "denied",
            message: err instanceof Error ? err.message : "Forbidden",
          },
          403
        );
      }
      logger.error({ err }, "cellInstances.createHtmlCell failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        httpStatusForTrpcError(err)
      );
    }
  });

  /**
   * PATCH /cell-instances/:id/config — updateConfig (governed).
   */
  app.patch("/cell-instances/:id/config", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const id = requireUuidParam(c, "id");
    if (id instanceof Response) return id;
    const raw = (await c.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!raw) return c.json({ error: "Invalid JSON in request body" }, 400);
    const parsed = UpdateConfigBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues.map((i) => i.message).join(", ") },
        400
      );
    }
    const body = parsed.data;

    // SECURITY — acting identity MUST come from the verified auth context,
    // never `body.userId` directly (governed-agent-write → ungoverned-
    // operator-write IDOR). Mirrors POST /profiles / POST /property-defs.
    //
    // Item 3 Part 3: positively pin a bound service key to its workspace
    // BEFORE it reaches resolveActingContext. The body schema requires
    // workspaceId (z.string().uuid()). A mismatching bound key throws
    // FORBIDDEN → surface 403, not a blanket 500.
    let clampedWorkspaceId: string;
    try {
      clampedWorkspaceId = getConfinedWorkspace(c, body.workspaceId) as string;
    } catch (err) {
      if ((err as { code?: unknown })?.code === "FORBIDDEN")
        return c.json(
          { error: err instanceof Error ? err.message : "Forbidden" },
          403
        );
      throw err;
    }
    const acting = await resolveActingContext(c, {
      userId: body.userId,
      workspaceId: clampedWorkspaceId,
    });
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);
    if (!acting.workspaceId) {
      return c.json({ error: "workspaceId is required" }, 400);
    }
    const userId = acting.userId;
    const workspaceId = acting.workspaceId;
    // Body wins, else the authenticated key's agent — an agent key that does not
    // echo its own id must not resolve as the human (ungoverned + unattributed).
    const resolvedAgentUserId =
      body.agentUserId ?? (c.get("agentUserId") as string | undefined);
    const actorResolution = await resolveActorId(resolvedAgentUserId, userId);
    if ("error" in actorResolution)
      return c.json({ error: actorResolution.error }, 400);

    try {
      const { checkPermissionOrPropose } =
        await import("../../../utils/permission-check.js");
      const perm = await checkPermissionOrPropose({
        userId,
        agentUserId: resolvedAgentUserId,
        workspaceId,
        subjectType: "cell",
        action: "update",
        // "agent" is not a valid EventSource — agent identity is on agentUserId; see SynapEventSchema
        source: "intelligence",
        // Widened (gate-payload sufficiency): `{ id }` described NO change — the
        // whole point of this door is the new `config`, and without it an
        // approved proposal had nothing to write. `workspaceId` is the CONFINED
        // value (never raw `body.workspaceId`) so a replay re-scopes the same
        // way the direct `.set()` below does. A cell config is user/agent
        // content, not a secret.
        data: { id, config: body.config, workspaceId },
        reasoning: body.reasoning,
        sourceMessageId: body.sourceMessageId,
      });
      if ("denied" in perm && perm.denied) {
        return c.json({ status: "denied", message: perm.reason }, 403);
      }
      if ("proposalId" in perm) {
        return jsonGoverned(c, {
          status: "proposed",
          proposalId: perm.proposalId,
          summary: perm.summary,
          reasoning: perm.reasoning,
          reviewPath: perm.reviewPath,
          reviewUrl: perm.reviewUrl,
        });
      }

      const [row] = await db
        .update(cellInstances)
        .set({ config: body.config, updatedAt: new Date() })
        .where(
          and(
            eq(cellInstances.id, id),
            eq(cellInstances.workspaceId, workspaceId)
          )
        )
        .returning();
      if (!row) return c.json({ error: "Cell instance not found" }, 404);
      return c.json(serialize(row));
    } catch (err) {
      logger.error({ err }, "cellInstances.updateConfig failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        httpStatusForTrpcError(err)
      );
    }
  });
}
