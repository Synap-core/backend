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
 *   POST   /cell-instances/html                       — createHtmlCell (governed)
 *   PATCH  /cell-instances/:id/config                 — updateConfig (governed)
 */

import { z } from "zod";
import {
  db,
  eq,
  and,
  desc,
  documents,
  documentVersions,
  cellInstances,
  normalizeDocumentType,
  storedVersionValues,
  uploadDocumentVersionSnapshot,
} from "@synap/database";
import { storage } from "@synap/storage";
import { randomUUID } from "crypto";
import {
  hasScope,
  logger,
  resolveActingContext,
  resolveActorId,
  verifyWorkspaceReadAccess,
  type HubHono,
  httpStatusForTrpcError,
} from "./_shared.js";
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
        500
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
    const id = c.req.param("id");
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
    const actorResolution = await resolveActorId(body.agentUserId, userId);
    if ("error" in actorResolution)
      return c.json({ error: actorResolution.error }, 400);

    try {
      const { checkPermissionOrPropose } =
        await import("../../../utils/permission-check.js");
      const perm = await checkPermissionOrPropose({
        userId,
        agentUserId: body.agentUserId,
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
          agentUserId: body.agentUserId,
        },
        reasoning: body.reasoning,
        sourceMessageId: body.sourceMessageId,
      });
      if ("denied" in perm && perm.denied) {
        return c.json({ status: "denied", message: perm.reason }, 403);
      }
      if ("proposalId" in perm) {
        return c.json({
          status: "proposed",
          proposalId: perm.proposalId,
          summary: perm.summary,
          reasoning: perm.reasoning,
          reviewPath: perm.reviewPath,
          reviewUrl: perm.reviewUrl,
        });
      }

      const [row] = await db
        .insert(cellInstances)
        .values({
          workspaceId,
          userId,
          cellType: body.cellType,
          config: body.config ?? {},
          name: body.name,
          isTemplate: body.isTemplate ?? false,
          sourceDocumentId: body.sourceDocumentId,
          createdByKind: body.agentUserId ? "agent" : "user",
          trustLevel: body.agentUserId ? "generated" : "trusted",
        })
        .returning();

      return c.json(serialize(row));
    } catch (err) {
      logger.error({ err }, "cellInstances.create failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * POST /cell-instances/html — createHtmlCell (governed).
   * Reuses the existing MinIO document path (see routers/documents.ts).
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
    const actorResolution = await resolveActorId(body.agentUserId, userId);
    if ("error" in actorResolution)
      return c.json({ error: actorResolution.error }, 400);

    try {
      const { checkPermissionOrPropose } =
        await import("../../../utils/permission-check.js");
      const perm = await checkPermissionOrPropose({
        userId,
        agentUserId: body.agentUserId,
        workspaceId,
        subjectType: "cell",
        action: "create",
        // "agent" is not a valid EventSource — agent identity is on agentUserId; see SynapEventSchema
        source: "intelligence",
        data: {
          cellType: "html-embed",
          name: body.name,
          html: body.html,
          userId,
          workspaceId,
          agentUserId: body.agentUserId,
        },
        reasoning: body.reasoning,
        sourceMessageId: body.sourceMessageId,
      });
      if ("denied" in perm && perm.denied) {
        return c.json({ status: "denied", message: perm.reason }, 403);
      }
      if ("proposalId" in perm) {
        return c.json({
          status: "proposed",
          proposalId: perm.proposalId,
          summary: perm.summary,
          reasoning: perm.reasoning,
          reviewPath: perm.reviewPath,
          reviewUrl: perm.reviewUrl,
        });
      }

      const title = body.name ?? "HTML Cell";
      const documentId = randomUUID();
      const docType = normalizeDocumentType("text", "text");
      const storageKey = storage.buildPath(
        userId,
        "document",
        documentId,
        "html"
      );
      const metadata = await storage.upload(storageKey, body.html, {
        contentType: "text/html",
      });
      const versionId = randomUUID();
      const snapshot = await uploadDocumentVersionSnapshot({
        userId,
        documentId,
        versionId,
        documentType: "html",
        mimeType: "text/html",
        content: body.html,
      });
      const [document] = await db
        .insert(documents)
        .values({
          id: documentId,
          userId,
          workspaceId,
          title,
          type: docType as "text" | "markdown" | "code" | "pdf" | "docx",
          storageUrl: metadata.url,
          storageKey: metadata.path,
          size: metadata.size,
          mimeType: "text/html",
          currentVersion: 1,
          lastSavedVersion: 1,
        })
        .returning();

      await db.insert(documentVersions).values({
        id: versionId,
        documentId,
        version: 1,
        ...storedVersionValues(snapshot),
        author: "user",
        authorId: userId,
        message: "Initial version",
      });

      const [row] = await db
        .insert(cellInstances)
        .values({
          workspaceId,
          userId,
          cellType: "html-embed",
          config: {},
          name: body.name,
          isTemplate: false,
          sourceDocumentId: document.id,
          createdByKind: body.agentUserId ? "agent" : "user",
          trustLevel: body.agentUserId ? "generated" : "trusted",
        })
        .returning();

      return c.json(serialize(row));
    } catch (err) {
      logger.error({ err }, "cellInstances.createHtmlCell failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
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
    const id = c.req.param("id");
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
    const actorResolution = await resolveActorId(body.agentUserId, userId);
    if ("error" in actorResolution)
      return c.json({ error: actorResolution.error }, 400);

    try {
      const { checkPermissionOrPropose } =
        await import("../../../utils/permission-check.js");
      const perm = await checkPermissionOrPropose({
        userId,
        agentUserId: body.agentUserId,
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
        return c.json({
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
        500
      );
    }
  });
}
