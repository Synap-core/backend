/**
 * Hub Protocol REST — documents
 */

import { z } from "@hono/zod-openapi";

import { ErrorSchema } from "./_codecs/_openapi.js";
import {
  CreateDocumentProposalRequestSchema,
  CreateDocumentRequestSchema,
  GetDocumentQuerySchema,
  WireDocumentSchema,
} from "./_codecs/document.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  getCaller,
  getUserAccessibleWorkspaceIds,
  hasScope,
  logger,
  resolveActorId,
  verifyWorkspaceAccess,
  type HubHono,
} from "./_shared.js";

const UpdateDocumentBodySchema = z.object({
  userId: z.string(),
  title: z.string().optional(),
  content: z.string().optional(),
  agentUserId: z.string().optional(),
  sourceMessageId: z.string().optional(),
});

export function registerDocumentsRoutes(app: HubHono): void {
  // ── OpenAPI metadata ─────────────────────────────────────────────────────
  registerOpenApi(app, {
    method: "post",
    path: "/documents",
    tags: ["Documents"],
    summary: "Create a document",
    request: {
      body: CreateDocumentRequestSchema,
    },
    responses: {
      200: { description: "Created document", schema: WireDocumentSchema },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "get",
    path: "/documents/{documentId}",
    tags: ["Documents"],
    summary: "Fetch a document",
    request: {
      params: z.object({ documentId: z.string() }),
      query: GetDocumentQuerySchema,
    },
    responses: {
      200: { description: "Document", schema: WireDocumentSchema },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "post",
    path: "/documents/proposals",
    tags: ["Documents", "Proposals"],
    summary: "Submit a document edit as a proposal",
    description:
      "Persists a document-edit proposal (AI suggestion / user review comment / etc.). Approval applies the changes through the document service.",
    request: {
      body: CreateDocumentProposalRequestSchema,
    },
    responses: {
      200: {
        description: "Created proposal",
        schema: z
          .object({
            id: z.string(),
            status: z.string().optional(),
          })
          .passthrough(),
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  /**
   * POST /documents (create document – B4)
   */
  app.post("/documents", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const body = (await c.req.json()) as {
      userId: string;
      workspaceId?: string | null;
      title: string;
      content?: string;
      type?: "text" | "markdown" | "code" | "html" | "pdf" | "docx";
      reasoning?: string;
      agentUserId?: string;
      sourceMessageId?: string;
    };
    try {
      const actorResolution = await resolveActorId(
        body.agentUserId,
        body.userId
      );
      if ("error" in actorResolution)
        return c.json({ error: actorResolution.error }, 400);
      const actorId = actorResolution.actorId;
      const caller = await getCaller(c, {
        workspaceId: body.workspaceId ?? null,
        userId: actorId,
        sourceMessageId: body.sourceMessageId,
      });
      const result = await caller.documents.createDocument({
        userId: body.userId,
        workspaceId: body.workspaceId ?? null,
        title: body.title,
        content: body.content ?? "",
        type: body.type ?? "markdown",
        reasoning: body.reasoning,
        ...(body.agentUserId ? { agentUserId: body.agentUserId } : {}),
      });
      return c.json(result);
    } catch (err) {
      logger.error({ err }, "createDocument failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * GET /documents/:documentId
   */
  app.get("/documents/:documentId", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const documentId = c.req.param("documentId");
    const userId = c.req.query("userId");
    if (!userId) {
      return c.json({ error: "userId query is required" }, 400);
    }
    try {
      const effectiveWsId =
        (await getUserAccessibleWorkspaceIds(userId))[0] || undefined;
      const caller = await getCaller(c, { workspaceId: effectiveWsId, userId });
      const result = await caller.documents.getDocument({
        documentId,
        userId,
      });
      const docWsId = (result as Record<string, unknown> | null)
        ?.workspaceId as string | undefined;
      if (docWsId) {
        const hasAccess = await verifyWorkspaceAccess(userId, docWsId);
        if (!hasAccess) {
          return c.json(
            { error: "Access denied to document's workspace" },
            403
          );
        }
      }
      return c.json(result);
    } catch (err) {
      logger.error({ err, documentId }, "getDocument failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  // ── GET /documents/:documentId/raw ───────────────────────────────────────
  // Must come before PATCH to avoid Hono treating "raw" as the documentId.
  registerOpenApi(app, {
    method: "get",
    path: "/documents/{documentId}/raw",
    tags: ["Documents"],
    summary: "Serve raw document content",
    description:
      "Returns the document's raw bytes with the correct Content-Type (text/html, text/markdown, application/pdf, etc.). " +
      "Useful for iframes, CLI downloads, and external consumers. Requires hub-protocol.read scope. " +
      "Pass userId as a query param.",
    request: {
      params: z.object({ documentId: z.string() }),
      query: z.object({ userId: z.string() }),
    },
    responses: {
      200: { description: "Raw document bytes", schema: z.string() },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Not found", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.get("/documents/:documentId/raw", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const documentId = c.req.param("documentId");
    const userId =
      c.req.query("userId") ?? (c.get("userId") as string | undefined);
    if (!userId) return c.json({ error: "userId is required" }, 400);

    try {
      const caller = await getCaller(c, { userId });
      const result = (await caller.documents.get({ documentId })) as {
        document: {
          mimeType?: string | null;
          title?: string | null;
          type?: string | null;
        };
        content: string;
      };
      if (!result) return c.json({ error: "Document not found" }, 404);

      const mimeType = result.document?.mimeType ?? "text/plain";
      const filename = (result.document?.title ?? documentId)
        .replace(/[^a-z0-9_\-. ]/gi, "_")
        .slice(0, 80);

      return new Response(result.content, {
        headers: {
          "Content-Type": mimeType,
          "Content-Disposition": `inline; filename="${filename}"`,
          "X-Frame-Options": "SAMEORIGIN",
          "Cache-Control": "private, max-age=60",
        },
      });
    } catch (err) {
      logger.error({ err, documentId }, "rawDocument failed");
      const isNotFound =
        err instanceof Error && err.message.includes("NOT_FOUND");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        isNotFound ? 404 : 500
      );
    }
  });

  // ── PATCH /documents/:documentId ─────────────────────────────────────────
  registerOpenApi(app, {
    method: "patch",
    path: "/documents/{documentId}",
    tags: ["Documents"],
    summary: "Update a document's title or content",
    description:
      "Replaces a document's content and/or title. Content is the full replacement string (not a diff). Goes through governance — `document.update` is auto-approved by default.",
    request: {
      params: z.object({ documentId: z.string() }),
      body: UpdateDocumentBodySchema,
    },
    responses: {
      200: { description: "Updated document", schema: WireDocumentSchema },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Not found", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  /**
   * PATCH /documents/:documentId
   * Update title and/or content. Content is the full replacement string.
   */
  app.patch("/documents/:documentId", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const documentId = c.req.param("documentId");
    const body = UpdateDocumentBodySchema.safeParse(await c.req.json());
    if (!body.success) {
      return c.json({ error: body.error.message }, 400);
    }
    const {
      userId,
      title,
      content,
      agentUserId: bodyAgentUserId,
      sourceMessageId,
    } = body.data;

    try {
      const ctxAgentUserId = c.get("agentUserId") as string | undefined;
      const resolvedAgentUserId = bodyAgentUserId ?? ctxAgentUserId;
      // Document ownership check in tRPC uses the caller's userId — pass the human.
      const actorResolution = await resolveActorId(resolvedAgentUserId, userId);
      if ("error" in actorResolution)
        return c.json({ error: actorResolution.error }, 400);

      const caller = await getCaller(c, { userId, sourceMessageId });
      const result = await caller.documents.update({
        documentId,
        ...(title !== undefined ? { title } : {}),
        ...(content !== undefined ? { delta: [{ content }] } : {}),
      });
      return c.json(result);
    } catch (err) {
      logger.error({ err, documentId }, "updateDocument failed");
      const isNotFound =
        err instanceof Error && err.message.includes("NOT_FOUND");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        isNotFound ? 404 : 500
      );
    }
  });

  /**
   * POST /documents/proposals
   */
  app.post("/documents/proposals", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const body = (await c.req.json()) as {
      documentId: string;
      userId: string;
      agentUserId?: string;
      threadId?: string;
      sourceMessageId?: string;
      proposalType?: "ai_edit" | "user_suggestion" | "review_comment";
      changes: Array<{
        op: "insert" | "delete" | "replace";
        position?: number;
        range?: [number, number];
        text?: string;
      }>;
      proposedContent: string;
      originalContent?: string;
    };
    try {
      const caller = await getCaller(c, {
        sourceMessageId: body.sourceMessageId,
      });
      const result = await caller.documents.createDocumentProposal({
        documentId: body.documentId,
        userId: body.userId,
        ...(body.agentUserId ? { agentUserId: body.agentUserId } : {}),
        threadId: body.threadId,
        sourceMessageId: body.sourceMessageId,
        proposalType: body.proposalType ?? "ai_edit",
        changes: body.changes,
        proposedContent: body.proposedContent,
        originalContent: body.originalContent,
      });
      return c.json(result);
    } catch (err) {
      logger.error({ err }, "createDocumentProposal failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}
