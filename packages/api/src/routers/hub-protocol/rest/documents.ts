/**
 * Hub Protocol REST — documents
 */

import { z } from "@hono/zod-openapi";

import { ErrorSchema } from "./_codecs/_openapi.js";
import {
  CreateDocumentProposalRequestSchema,
  CreateDocumentRequestSchema,
  GetDocumentQuerySchema,
  PatchDocumentRequestSchema,
  WireDocumentSchema,
} from "./_codecs/document.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  errCode,
  getCaller,
  hasScope,
  httpStatusForTrpcError,
  logger,
  resolveActorId,
  resolveActingContext,
  type HubHono,
} from "./_shared.js";
import { jsonGoverned } from "../proposal-response.js";
import { getConfinedWorkspace } from "../confine-workspace.js";
import { attachCreatedDocument } from "../attach-created-document.js";

const UpdateDocumentBodySchema = z.object({
  userId: z.string(),
  /**
   * Accepted by the schema ONLY so it can be refused: this route edits
   * content and never renames. A `title` returns 400 instead of being
   * silently dropped.
   */
  title: z.string().optional(),
  content: z.string().optional(),
  /** The revision you read (GET /documents/{id} → `revision`). */
  baseRevision: z.number().int().min(0).optional(),
  allowRemovingEmbeds: z.boolean().optional(),
  agentUserId: z.string().optional(),
  sourceMessageId: z.string().optional(),
  sessionId: z.string().optional(),
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
    summary: "Replace a document's content (alias of the patch door)",
    description:
      "A full replacement — one `replace_all` op through the document patch door (see POST /documents/{documentId}/patch). Governed: an agent's full replacement is always a proposal, and it may not change a person's section or drop an embed.",
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
      sessionId?: string;
      expectedLabel?: string;
      /** External https reference: creates a pointer document, no bytes. */
      url?: string;
      /** Attach the created document as this entity's body (governed). */
      entityId?: string;
      idempotencyKey?: string;
    };
    try {
      const acting = await resolveActingContext(c, {
        userId: body.userId,
        ...(typeof body.workspaceId === "string"
          ? { workspaceId: body.workspaceId }
          : {}),
      });
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);
      // Item 3 Part 3: positively pin a bound service key to its workspace.
      const workspaceId = getConfinedWorkspace(c, acting.workspaceId) ?? null;
      // Body wins, else the authenticated key's agent — an agent key that does
      // not echo its own id must not resolve as the human.
      const resolvedAgentUserId =
        body.agentUserId ?? (c.get("agentUserId") as string | undefined);
      const actorResolution = await resolveActorId(
        resolvedAgentUserId,
        acting.userId
      );
      if ("error" in actorResolution)
        return c.json({ error: actorResolution.error }, 400);
      // resolveActorId kept for its validation side-effect; return value unused.
      const sessionId = body.sessionId ?? c.get("sessionId") ?? null;
      const caller = await getCaller(c, {
        workspaceId,
        userId: acting.userId,
        sourceMessageId: body.sourceMessageId,
        sessionId,
      });
      const result = await caller.documents.createDocument({
        userId: acting.userId,
        workspaceId,
        title: body.title,
        content: body.content ?? "",
        type: body.type ?? "markdown",
        reasoning: body.reasoning,
        ...(resolvedAgentUserId ? { agentUserId: resolvedAgentUserId } : {}),
        ...(body.expectedLabel ? { expectedLabel: body.expectedLabel } : {}),
        ...(body.url ? { url: body.url } : {}),
        ...(body.idempotencyKey ? { idempotencyKey: body.idempotencyKey } : {}),
      });
      if (!body.entityId) return jsonGoverned(c, result);
      return jsonGoverned(
        c,
        await attachCreatedDocument({
          created: result,
          entityId: body.entityId,
          userId: acting.userId,
          scopes: c.get("scopes") as string[],
          // The confined, acting-resolved workspace — not the raw body id.
          workspaceId,
          sessionId,
          sourceMessageId: body.sourceMessageId ?? null,
          ...(resolvedAgentUserId ? { agentUserId: resolvedAgentUserId } : {}),
          keyType: c.get("keyType") as string | undefined,
          keyWorkspaceId: c.get("keyWorkspaceId") as string | null | undefined,
          reasoning: "Attach document created via Hub REST POST /documents",
        })
      );
    } catch (err) {
      // Item 3 Part 3: a bound service key targeting another workspace throws
      // FORBIDDEN — surface 403, not a blanket 500. Duck-typed on `.code`.
      if ((err as { code?: unknown })?.code === "FORBIDDEN")
        return c.json(
          { error: err instanceof Error ? err.message : "Forbidden" },
          403
        );
      logger.error({ err }, "createDocument failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        httpStatusForTrpcError(err)
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
    const userId = c.get("userId") as string | undefined;
    if (!userId) return c.json({ error: "Unauthenticated" }, 403);
    try {
      // A single-document fetch resolves visibility from the user floor —
      // verified below against the document's OWN workspace. No lens is threaded
      // in: documents.get ignores ctx.workspaceId, so the previous "first
      // accessible workspace" pick was dead and misleading.
      // Access is `documents.get`'s read floor (owner, workspace member,
      // project member). A second workspace-only check here would deny a
      // project member the floor admits.
      const format = c.req.query("format");
      if (format !== undefined && format !== "raw" && format !== "readable") {
        return c.json({ error: "format must be raw or readable" }, 400);
      }
      const caller = await getCaller(c, { userId });
      const result = await caller.documents.getDocument({
        documentId,
        userId,
        ...(format ? { format } : {}),
      });
      return jsonGoverned(c, result);
    } catch (err) {
      logger.error({ err, documentId }, "getDocument failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        httpStatusForTrpcError(err)
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
    const userId = c.get("userId") as string | undefined;
    if (!userId) return c.json({ error: "Unauthenticated" }, 403);

    try {
      const caller = await getCaller(c, { userId });
      const result = await caller.documents.getDocument({ documentId, userId });
      if (!result) return c.json({ error: "Document not found" }, 404);

      const mimeType = "text/plain";
      const filename = (result.document?.title ?? documentId)
        .replace(/[^a-z0-9_\-. ]/gi, "_")
        .slice(0, 80);

      return new Response(result.document.content ?? "", {
        headers: {
          "Content-Type": mimeType,
          "Content-Disposition": `inline; filename="${filename}"`,
          "X-Frame-Options": "SAMEORIGIN",
          "Cache-Control": "private, max-age=60",
        },
      });
    } catch (err) {
      logger.error({ err, documentId }, "rawDocument failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        httpStatusForTrpcError(err)
      );
    }
  });

  // ── PATCH /documents/:documentId ─────────────────────────────────────────
  registerOpenApi(app, {
    method: "patch",
    path: "/documents/{documentId}",
    tags: ["Documents"],
    summary: "Replace a document's content (alias of the patch door)",
    description:
      "Replaces a document's content with `content` — one `replace_all` op through the document patch door (prefer POST /documents/{documentId}/patch for section or text edits). Governed: an agent's full replacement is always a proposal for the document's editors; a person's is applied. It may not change a person's section or drop an embed (`allowRemovingEmbeds`). Pass `baseRevision` (GET → `revision`); without it the revision at filing is pinned. `content` is required; a `title` is refused with 400 (this route never renames).",
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
   * PATCH /documents/:documentId — full replacement, an ALIAS onto the patch
   * door (hub `createDocumentProposal` → `applyDocumentPatch` with one
   * `replace_all` op). `document.update` is not in `DEFAULT_AUTO_APPROVE` and
   * an agent's `replace_all` is forced to a proposal, so an agent's edit is
   * always reviewed; the accepted version carries the drafting agent as author.
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
    // Refused, never dropped: an edit that silently loses half its request
    // reads as a success it is not.
    if (title !== undefined) {
      return c.json(
        {
          error:
            "PATCH /documents/:documentId proposes content only and cannot rename a document. Remove `title`; to rename an entity's document, update the entity's title.",
        },
        400
      );
    }

    try {
      const acting = await resolveActingContext(c, { userId });
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);
      const ctxAgentUserId = c.get("agentUserId") as string | undefined;
      const resolvedAgentUserId = bodyAgentUserId ?? ctxAgentUserId;
      // Document ownership check in tRPC uses the caller's userId — pass the human.
      const actorResolution = await resolveActorId(
        resolvedAgentUserId,
        acting.userId
      );
      if ("error" in actorResolution)
        return c.json({ error: actorResolution.error }, 400);

      if (content === undefined) {
        return c.json({ error: "`content` is required." }, 400);
      }

      const sessionId = body.data.sessionId ?? c.get("sessionId") ?? null;
      const caller = await getCaller(c, {
        userId: acting.userId,
        sourceMessageId,
        sessionId,
      });
      const result = await caller.documents.createDocumentProposal({
        documentId,
        userId: acting.userId,
        ...(resolvedAgentUserId ? { agentUserId: resolvedAgentUserId } : {}),
        ...(sourceMessageId ? { sourceMessageId } : {}),
        proposedContent: content,
        ...(body.data.baseRevision !== undefined
          ? { baseRevision: body.data.baseRevision }
          : {}),
        ...(body.data.allowRemovingEmbeds !== undefined
          ? { allowRemovingEmbeds: body.data.allowRemovingEmbeds }
          : {}),
      });
      return jsonGoverned(c, result);
    } catch (err) {
      logger.error({ err, documentId }, "updateDocument failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        httpStatusForTrpcError(err)
      );
    }
  });

  /**
   * POST /documents/proposals — full replacement, an ALIAS onto the patch door
   * (same as PATCH). Legacy `changes` / `originalContent` / `proposalType` are
   * no longer read: the diff a reviewer sees is computed server-side.
   */
  app.post("/documents/proposals", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const parsed = CreateDocumentProposalRequestSchema.safeParse(
      await c.req.json()
    );
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }
    const body = parsed.data;
    try {
      const acting = await resolveActingContext(c, { userId: body.userId });
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);
      const ctxAgentUserId = c.get("agentUserId") as string | undefined;
      const resolvedAgentUserId = body.agentUserId ?? ctxAgentUserId;
      const actorResolution = await resolveActorId(
        resolvedAgentUserId,
        acting.userId
      );
      if ("error" in actorResolution)
        return c.json({ error: actorResolution.error }, 400);
      const sessionId = body.sessionId ?? c.get("sessionId") ?? null;
      const caller = await getCaller(c, {
        userId: acting.userId,
        sourceMessageId: body.sourceMessageId,
        sessionId,
      });
      const result = await caller.documents.createDocumentProposal({
        documentId: body.documentId,
        userId: acting.userId,
        ...(resolvedAgentUserId ? { agentUserId: resolvedAgentUserId } : {}),
        ...(body.sourceMessageId
          ? { sourceMessageId: body.sourceMessageId }
          : {}),
        proposedContent: body.proposedContent,
        ...(body.baseRevision !== undefined
          ? { baseRevision: body.baseRevision }
          : {}),
        ...(body.allowRemovingEmbeds !== undefined
          ? { allowRemovingEmbeds: body.allowRemovingEmbeds }
          : {}),
        ...(body.reasoning ? { reasoning: body.reasoning } : {}),
      });
      return jsonGoverned(c, result);
    } catch (err) {
      logger.error({ err }, "createDocumentProposal failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        httpStatusForTrpcError(err)
      );
    }
  });

  // ── POST /documents/:documentId/patch ─────────────────────────────────────
  registerOpenApi(app, {
    method: "post",
    path: "/documents/{documentId}/patch",
    tags: ["Documents"],
    summary: "Edit a document with ops",
    description:
      "THE document edit door. Ops, applied in order: `upsert_section {id,title,body}` (one `::::synap-section` block by id), `replace_text {old,new}` (`old` must match EXACTLY once — otherwise 400 with the count), `append {body}`, `replace_all {content}` (needs `baseRevision`). Pass `baseRevision` from GET /documents/{id} (`revision`); a document that moved answers 409. Refused (403): an agent changing a person's section (replace_all included); removing an embed without `allowRemovingEmbeds: true`. Governed: applies or files a proposal (202); an agent's replace_all is always a proposal. The response carries `preview` (per section, before/after) and `diagnostics` (advisory: what will not render — never a refusal; `null` + `diagnosticsError` when the check could not run).",
    request: {
      params: z.object({ documentId: z.string() }),
      body: PatchDocumentRequestSchema,
    },
    responses: {
      200: {
        description: "Applied (or proposed — 202)",
        schema: z.object({ status: z.string() }).passthrough(),
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Not found", schema: ErrorSchema },
      409: { description: "The document moved", schema: ErrorSchema },
      412: { description: "Sections cannot be located", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.post("/documents/:documentId/patch", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const documentId = c.req.param("documentId");
    const parsed = PatchDocumentRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }
    const body = parsed.data;
    try {
      const acting = await resolveActingContext(c, { userId: body.userId });
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);
      const resolvedAgentUserId =
        body.agentUserId ?? (c.get("agentUserId") as string | undefined);
      const actorResolution = await resolveActorId(
        resolvedAgentUserId,
        acting.userId
      );
      if ("error" in actorResolution)
        return c.json({ error: actorResolution.error }, 400);
      const sessionId = body.sessionId ?? c.get("sessionId") ?? null;
      const caller = await getCaller(c, {
        userId: acting.userId,
        sourceMessageId: body.sourceMessageId,
        sessionId,
      });
      const result = await caller.documents.patchDocument({
        documentId,
        ...(resolvedAgentUserId ? { agentUserId: resolvedAgentUserId } : {}),
        ...(body.baseRevision !== undefined
          ? { baseRevision: body.baseRevision }
          : {}),
        ops: body.ops,
        ...(body.allowRemovingEmbeds !== undefined
          ? { allowRemovingEmbeds: body.allowRemovingEmbeds }
          : {}),
        ...(body.reasoning ? { reasoning: body.reasoning } : {}),
        ...(body.sourceMessageId
          ? { sourceMessageId: body.sourceMessageId }
          : {}),
      });
      return jsonGoverned(c, result);
    } catch (err) {
      logger.error({ err, documentId }, "patchDocument failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        httpStatusForTrpcError(err)
      );
    }
  });

  /**
   * GET /focus-sessions/:sessionId/document — the session's designated
   * document, its current version and each section's owner + stamps.
   */
  app.get("/focus-sessions/:sessionId/document", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const sessionId = c.req.param("sessionId");
    try {
      const caller = await getCaller(c);
      return c.json(await caller.documents.getSessionDocument({ sessionId }));
    } catch (err) {
      logger.error({ err, sessionId }, "getSessionDocument failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        httpStatusForTrpcError(err)
      );
    }
  });

  /**
   * PUT /focus-sessions/:sessionId/document/sections/:sectionId — write ONE
   * section. The "own session" signal is ONLY the verified `X-Session-Id`
   * header (`c.get("sessionId")`), never a body field.
   */
  app.put(
    "/focus-sessions/:sessionId/document/sections/:sectionId",
    async (c) => {
      if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
        return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
      }
      const sessionId = c.req.param("sessionId");
      const sectionId = c.req.param("sectionId");
      const body = UpsertSessionSectionBodySchema.safeParse(await c.req.json());
      if (!body.success) {
        return c.json({ error: body.error.message }, 400);
      }
      try {
        const acting = await resolveActingContext(c, {
          userId: body.data.userId,
        });
        if (!acting.ok) return c.json({ error: acting.error }, acting.status);
        const agentUserId =
          body.data.agentUserId ?? (c.get("agentUserId") as string | undefined);
        const actorResolution = await resolveActorId(
          agentUserId,
          acting.userId
        );
        if ("error" in actorResolution)
          return c.json({ error: actorResolution.error }, 400);

        const caller = await getCaller(c, {
          sourceMessageId: body.data.sourceMessageId,
          sessionId: (c.get("sessionId") as string | undefined) ?? null,
        });
        const result = await caller.documents.upsertSessionSection({
          sessionId,
          sectionId,
          ...(agentUserId ? { agentUserId } : {}),
          title: body.data.title,
          body: body.data.body,
          baseVersion: body.data.baseVersion,
          ...(body.data.baseRevision !== undefined
            ? { baseRevision: body.data.baseRevision }
            : {}),
          reasoning: body.data.reasoning,
          sourceMessageId: body.data.sourceMessageId,
        });
        return jsonGoverned(c, result);
      } catch (err) {
        logger.error(
          { err, sessionId, sectionId },
          "upsertSessionSection failed"
        );
        // A stale base version and an unlocatable section are the writer's
        // cue to re-read, so they get their own statuses instead of a 500.
        const code = errCode(err);
        const status =
          code === "CONFLICT"
            ? 409
            : code === "PRECONDITION_FAILED"
              ? 412
              : httpStatusForTrpcError(err);
        return c.json(
          { error: err instanceof Error ? err.message : "Unknown error" },
          status
        );
      }
    }
  );
}

const UpsertSessionSectionBodySchema = z.object({
  userId: z.string().optional(),
  agentUserId: z.string().optional(),
  title: z.string(),
  body: z.string(),
  baseVersion: z.number().int().min(1).nullable(),
  /** The content revision read (GET …/document → `revision`); preferred over baseVersion. */
  baseRevision: z.number().int().min(0).optional(),
  reasoning: z.string().optional(),
  sourceMessageId: z.string().optional(),
});
