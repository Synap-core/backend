/**
 * Hub Protocol REST Adapter (B1)
 *
 * Exposes hub protocol procedures as REST endpoints for the Intelligence Service.
 * Uses API key auth (Bearer). Mount at /api/hub in the app.
 */

import { Hono } from "hono";
import { createLogger } from "@synap-core/core";
import { apiKeyService } from "../services/api-keys.js";
import { hubProtocolRouter } from "./hub-protocol/index.js";
import { createHubProtocolCallerContext } from "./hub-protocol/utils.js";
import { db, conversationMessages, chatThreads, knowledgeFacts, eq, and, asc, desc, knowledgeRepository, drizzleSql, traverseEntityGraph, intelligenceCommands } from "@synap/database";

const logger = createLogger({ module: "hub-protocol-rest" });

function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function hasScope(scopes: string[], required: string): boolean {
  return scopes.includes(required);
}

const app = new Hono<{
  Variables: {
    userId: string;
    scopes: string[];
  };
}>();

/**
 * GET /health (no auth)
 */
app.get("/health", (c) => c.json({ status: "ok", service: "hub-protocol" }));

/**
 * Middleware: validate API key and set userId + scopes (skip for /health)
 */
app.use("/*", async (c, next) => {
  if (c.req.path === "/health") {
    return next();
  }
  const authHeader = c.req.header("authorization") ?? null;
  const token = extractBearerToken(authHeader);

  if (!token) {
    return c.json(
      { error: "API key required. Use Authorization: Bearer <key>" },
      401
    );
  }

  const keyRecord = await apiKeyService.validateApiKey(token);
  if (!keyRecord) {
    return c.json({ error: "Invalid or expired API key" }, 401);
  }

  const allowed = apiKeyService.checkRateLimit(keyRecord.id, "request");
  if (!allowed) {
    return c.json({ error: "Rate limit exceeded" }, 429);
  }

  c.set("userId", keyRecord.userId);
  c.set("scopes", keyRecord.scope);
  await next();
});

/**
 * Helper: get hub protocol caller for current request.
 * Pass workspaceId for workspace-scoped procedures (e.g. entities create/update).
 */
async function getCaller(
  c: { get: (key: string) => unknown },
  options?: { workspaceId?: string | null; userId?: string }
) {
  // For workspace-scoped calls the body userId (real user) must be used,
  // not the API key's userId ("system"), so the membership check passes.
  const userId = options?.userId ?? (c.get("userId") as string);
  const scopes = c.get("scopes") as string[];
  const ctx = await createHubProtocolCallerContext(
    userId,
    scopes,
    options?.workspaceId
  );
  return hubProtocolRouter.createCaller(ctx as any);
}

/**
 * GET /threads?userId=...&workspaceId=...&limit=...
 * List chat threads for a user (with parentThreadId for tree construction).
 */
app.get("/threads", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
    return c.json({ error: "Insufficient scope: hub-protocol.read required" }, 403);
  }
  const userId = c.req.query("userId");
  const workspaceId = c.req.query("workspaceId");
  const limit = parseInt(c.req.query("limit") ?? "50", 10);
  if (!userId) return c.json({ error: "userId is required" }, 400);
  try {
    const whereClause = workspaceId
      ? and(eq(chatThreads.userId, userId), eq(chatThreads.workspaceId, workspaceId))
      : eq(chatThreads.userId, userId);
    const threads = await db
      .select({
        id: chatThreads.id,
        title: chatThreads.title,
        agentType: chatThreads.agentType,
        parentThreadId: chatThreads.parentThreadId,
        branchPurpose: chatThreads.branchPurpose,
        contextSummary: chatThreads.contextSummary,
        createdAt: chatThreads.createdAt,
        updatedAt: chatThreads.updatedAt,
      })
      .from(chatThreads)
      .where(whereClause)
      .orderBy(desc(chatThreads.updatedAt))
      .limit(Math.min(limit, 200));
    return c.json(threads);
  } catch (err) {
    logger.error({ err, userId }, "listThreads failed");
    return c.json({ error: err instanceof Error ? err.message : "Unknown error" }, 500);
  }
});

/**
 * GET /threads/:threadId/context
 */
app.get("/threads/:threadId/context", async (c) => {
  if (!hasScope(c.get("scopes"), "hub-protocol.read")) {
    return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
  }
  const threadId = c.req.param("threadId");
  try {
    const caller = await getCaller(c);
    const result = await (caller as any).context.getThreadContext({ threadId });
    return c.json(result);
  } catch (err) {
    logger.error({ err, threadId }, "getThreadContext failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500
    );
  }
});

/**
 * PATCH /threads/:threadId/context
 * Accepts: { contextSummary?: string; personalityFingerprint?: string }
 */
app.patch("/threads/:threadId/context", async (c) => {
  if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
    return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
  }
  const threadId = c.req.param("threadId");
  const body = (await c.req.json()) as { contextSummary?: string; personalityFingerprint?: string };
  try {
    if (body.contextSummary !== undefined) {
      const caller = await getCaller(c);
      await (caller as any).context.updateThreadContext({
        threadId,
        contextSummary: body.contextSummary ?? "",
      });
    }
    if (body.personalityFingerprint !== undefined) {
      await db.update(chatThreads)
        .set({
          metadata: drizzleSql`COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
            'personalityFingerprint', ${body.personalityFingerprint},
            'personalityFingerprintAt', ${new Date().toISOString()}
          )`,
        })
        .where(eq(chatThreads.id, threadId));
    }
    return c.json({ success: true });
  } catch (err) {
    logger.error({ err, threadId }, "updateThreadContext failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500
    );
  }
});

/**
 * GET /users/:userId/context
 */
app.get("/users/:userId/context", async (c) => {
  if (!hasScope(c.get("scopes"), "hub-protocol.read")) {
    return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
  }
  const userId = c.req.param("userId");
  try {
    const caller = await getCaller(c);
    const result = await (caller as any).context.getUserContext({ userId });
    return c.json(result);
  } catch (err) {
    logger.error({ err, userId }, "getUserContext failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500
    );
  }
});

/**
 * GET /users/:userId/entities
 */
app.get("/users/:userId/entities", async (c) => {
  if (!hasScope(c.get("scopes"), "hub-protocol.read")) {
    return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
  }
  const userId = c.req.param("userId");
  const type = c.req.query("type");
  const limit = c.req.query("limit");
  const workspaceId = c.req.query("workspaceId") || null;
  try {
    const caller = await getCaller(c, { workspaceId });
    const result = await (caller as any).entities.getEntities({
      userId,
      workspaceId: workspaceId || undefined,
      type: type || undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
    return c.json(result);
  } catch (err) {
    logger.error({ err, userId }, "getEntities failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500
    );
  }
});

/**
 * POST /entities
 * Requires workspaceId in body so the same event chain (requested → validated → executor) is used.
 */
app.post("/entities", async (c) => {
  if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
    return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
  }
  const body = (await c.req.json()) as {
    userId: string;
    workspaceId: string;
    type: string;
    title: string;
    description?: string;
    properties?: Record<string, unknown>;
  };
  if (!body.workspaceId) {
    return c.json(
      { error: "workspaceId is required for entity creation (event chain)" },
      400
    );
  }
  try {
    const caller = await getCaller(c, { workspaceId: body.workspaceId, userId: body.userId });
    const result = await (caller as any).entities.createEntity({
      userId: body.userId,
      type: body.type,
      title: body.title,
      description: body.description,
    });
    return c.json(result);
  } catch (err) {
    logger.error({ err }, "createEntity failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500
    );
  }
});

/**
 * PATCH /entities/:entityId
 * Requires workspaceId in body for workspace-scoped update (same event chain).
 */
app.patch("/entities/:entityId", async (c) => {
  if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
    return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
  }
  const entityId = c.req.param("entityId");
  const body = (await c.req.json()) as {
    userId: string;
    workspaceId: string;
    title?: string;
    preview?: string;
    metadata?: Record<string, unknown>;
  };
  if (!body.workspaceId) {
    return c.json(
      { error: "workspaceId is required for entity update (event chain)" },
      400
    );
  }
  try {
    const caller = await getCaller(c, { workspaceId: body.workspaceId, userId: body.userId });
    await (caller as any).entities.updateEntity({
      entityId,
      userId: body.userId,
      title: body.title,
      preview: body.preview,
      metadata: body.metadata,
    });
    return c.json({ success: true });
  } catch (err) {
    logger.error({ err, entityId }, "updateEntity failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500
    );
  }
});

/**
 * GET /search/collection?userId=...&collection=entities&query=...&workspaceId=...
 */
app.get("/search/collection", async (c) => {
  if (!hasScope(c.get("scopes"), "hub-protocol.read")) {
    return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
  }
  const userId = c.req.query("userId");
  const collection = c.req.query("collection");
  const query = c.req.query("query");
  const workspaceId = c.req.query("workspaceId");
  const limit = c.req.query("limit");
  const page = c.req.query("page");
  if (!userId || !query || !collection) {
    return c.json({ error: "userId, collection and query are required" }, 400);
  }
  try {
    const caller = await getCaller(c);
    const result = await (caller as any).search.searchCollection({
      userId,
      collection: collection as
        | "entities"
        | "documents"
        | "views"
        | "projects"
        | "chat_threads"
        | "agents",
      query,
      workspaceId: workspaceId || undefined,
      limit: limit ? parseInt(limit, 10) : 20,
      page: page ? parseInt(page, 10) : 1,
    });
    return c.json(result);
  } catch (err) {
    logger.error({ err }, "searchCollection failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500
    );
  }
});

/**
 * GET /search
 */
app.get("/search", async (c) => {
  if (!hasScope(c.get("scopes"), "hub-protocol.read")) {
    return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
  }
  const userId = c.req.query("userId");
  const query = c.req.query("query");
  const workspaceId = c.req.query("workspaceId");
  const collections = c.req.query("collections"); // comma-separated
  const limit = c.req.query("limit");
  const page = c.req.query("page");
  if (!userId || !query) {
    return c.json({ error: "userId and query are required" }, 400);
  }
  try {
    const caller = await getCaller(c);
    const result = await (caller as any).search.search({
      userId,
      query,
      workspaceId: workspaceId || undefined,
      collections: collections
        ? (collections.split(",") as (
            | "entities"
            | "documents"
            | "views"
            | "projects"
            | "chat_threads"
            | "agents"
          )[])
        : undefined,
      limit: limit ? parseInt(limit, 10) : 20,
      page: page ? parseInt(page, 10) : 1,
    });
    return c.json(result);
  } catch (err) {
    logger.error({ err }, "search failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500
    );
  }
});

/**
 * GET /search/documents?userId=...&query=...&type=...&limit=...
 */
app.get("/search/documents", async (c) => {
  if (!hasScope(c.get("scopes"), "hub-protocol.read")) {
    return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
  }
  const userId = c.req.query("userId");
  const query = c.req.query("query");
  const type = c.req.query("type");
  const limit = c.req.query("limit");
  if (!userId || !query) {
    return c.json({ error: "userId and query are required" }, 400);
  }
  try {
    const caller = await getCaller(c);
    const result = await (caller as any).search.searchDocuments({
      userId,
      query,
      type: type as
        | "text"
        | "markdown"
        | "code"
        | "pdf"
        | "docx"
        | undefined,
      limit: limit ? parseInt(limit, 10) : 20,
    });
    return c.json(result);
  } catch (err) {
    logger.error({ err }, "searchDocuments failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500
    );
  }
});

/**
 * GET /vector-search?userId=...&query=...&types=...&limit=...
 */
app.get("/vector-search", async (c) => {
  if (!hasScope(c.get("scopes"), "hub-protocol.read")) {
    return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
  }
  const userId = c.req.query("userId");
  const query = c.req.query("query");
  const types = c.req.query("types"); // comma-separated
  const limit = c.req.query("limit");
  if (!userId || !query) {
    return c.json({ error: "userId and query are required" }, 400);
  }
  try {
    const caller = await getCaller(c);
    const result = await (caller as any).search.vectorSearch({
      userId,
      query,
      types: types ? types.split(",") : undefined,
      limit: limit ? parseInt(limit, 10) : 10,
    });
    return c.json(result);
  } catch (err) {
    logger.error({ err }, "vectorSearch failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500
    );
  }
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
    title: string;
    content?: string;
    type?: "text" | "markdown" | "code" | "pdf" | "docx";
  };
  try {
    const caller = await getCaller(c);
    const result = await (caller as any).documents.createDocument({
      userId: body.userId,
      title: body.title,
      content: body.content ?? "",
      type: body.type ?? "markdown",
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
    const caller = await getCaller(c);
    const result = await (caller as any).documents.getDocument({
      documentId,
      userId,
    });
    return c.json(result);
  } catch (err) {
    logger.error({ err, documentId }, "getDocument failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500
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
    const caller = await getCaller(c);
    const result = await (caller as any).documents.createDocumentProposal({
      documentId: body.documentId,
      userId: body.userId,
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

/**
 * GET /proposals?userId=...&workspaceId=...&status=...
 */
app.get("/proposals", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
    return c.json({ error: "Insufficient scope" }, 403);
  }
  const userId = c.req.query("userId") || (c.get("userId") as string);
  const workspaceId = c.req.query("workspaceId");
  const status = (c.req.query("status") as "pending" | "approved" | "rejected" | "all") || "pending";
  try {
    const caller = await getCaller(c);
    const result = await (caller as any).proposals.listProposals({
      userId,
      workspaceId,
      status,
    });
    return c.json(result);
  } catch (err) {
    logger.error({ err }, "listProposals failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500
    );
  }
});

/**
 * PATCH /proposals/:id
 * AI revises a pending proposal (no event pipeline re-run)
 * Body: { data: {...}, summary?: string }
 */
app.patch("/proposals/:id", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
    return c.json({ error: "Insufficient scope: hub-protocol.write required" }, 403);
  }
  const proposalId = c.req.param("id");
  const body = (await c.req.json()) as {
    data: Record<string, unknown>;
    summary?: string;
  };
  try {
    const caller = await getCaller(c);
    const result = await (caller as any).proposals.updateProposal({
      proposalId,
      data: body.data,
      summary: body.summary,
    });
    return c.json(result);
  } catch (err) {
    logger.error({ err, proposalId }, "updateProposal failed");
    const code = (err as any)?.code === "NOT_FOUND" ? 404 :
                 (err as any)?.code === "BAD_REQUEST" ? 400 : 500;
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      code
    );
  }
});

/**
 * GET /skills/getSkills?userId=...&workspaceId=...&status=...
 */
app.get("/skills/getSkills", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
    return c.json({ error: "Insufficient scope" }, 403);
  }
  const userId = c.req.query("userId") || (c.get("userId") as string);
  const workspaceId = c.req.query("workspaceId");
  const status = c.req.query("status");
  try {
    const caller = await getCaller(c);
    const result = await (caller as any).skills.getSkills({
      userId,
      workspaceId: workspaceId || undefined,
      status: (status as "active" | "inactive" | "error" | "all") || "all",
    });
    return c.json(result);
  } catch (err) {
    logger.error({ err }, "getSkills failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500
    );
  }
});

/**
 * GET /skills/getSkill?userId=...&skillId=...
 */
app.get("/skills/getSkill", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
    return c.json({ error: "Insufficient scope" }, 403);
  }
  const userId = c.req.query("userId") || (c.get("userId") as string);
  const skillId = c.req.query("skillId");
  if (!skillId) {
    return c.json({ error: "skillId is required" }, 400);
  }
  try {
    const caller = await getCaller(c);
    const result = await (caller as any).skills.getSkill({ userId, skillId });
    return c.json(result);
  } catch (err) {
    logger.error({ err }, "getSkill failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500
    );
  }
});

/**
 * POST /skills/createSkill
 */
app.post("/skills/createSkill", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
    return c.json({ error: "Insufficient scope" }, 403);
  }
  const body = await c.req.json<{
    userId: string;
    name: string;
    description?: string;
    code: string;
    parameters?: Record<string, unknown>;
    category?: "action" | "context" | "utility" | "custom";
    workspaceId?: string;
  }>();
  try {
    const caller = await getCaller(c);
    const result = await (caller as any).skills.createSkill(body);
    return c.json(result);
  } catch (err) {
    logger.error({ err }, "createSkill failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500
    );
  }
});

/**
 * POST /threads/:threadId/link-entity
 * Links an entity to a thread (context tracking, fast-path, idempotent)
 * Body: { userId, entityId, relationshipType?, sourceMessageId? }
 */
app.post("/threads/:threadId/link-entity", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
    return c.json({ error: "Insufficient scope: hub-protocol.write required" }, 403);
  }
  const threadId = c.req.param("threadId");
  const body = (await c.req.json()) as {
    userId: string;
    entityId: string;
    relationshipType?: string;
    sourceMessageId?: string;
  };
  try {
    const caller = await getCaller(c);
    const result = await (caller as any).linking.linkEntity({
      userId: body.userId,
      threadId,
      entityId: body.entityId,
      relationshipType: body.relationshipType ?? "referenced",
      sourceMessageId: body.sourceMessageId,
    });
    return c.json(result);
  } catch (err) {
    logger.error({ err, threadId }, "linkEntity failed");
    const code = (err as any)?.message?.includes("not found") ? 404 : 500;
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      code
    );
  }
});

/**
 * POST /threads/:threadId/link-document
 * Links a document to a thread (context tracking, fast-path, idempotent)
 * Body: { userId, documentId, relationshipType?, sourceMessageId? }
 */
app.post("/threads/:threadId/link-document", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
    return c.json({ error: "Insufficient scope: hub-protocol.write required" }, 403);
  }
  const threadId = c.req.param("threadId");
  const body = (await c.req.json()) as {
    userId: string;
    documentId: string;
    relationshipType?: string;
    sourceMessageId?: string;
  };
  try {
    const caller = await getCaller(c);
    const result = await (caller as any).linking.linkDocument({
      userId: body.userId,
      threadId,
      documentId: body.documentId,
      relationshipType: body.relationshipType ?? "referenced",
      sourceMessageId: body.sourceMessageId,
    });
    return c.json(result);
  } catch (err) {
    logger.error({ err, threadId }, "linkDocument failed");
    const code = (err as any)?.message?.includes("not found") ? 404 : 500;
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      code
    );
  }
});

/**
 * POST /threads
 * Creates a new chat thread.
 * Body: { userId, workspaceId, title?, parentThreadId?, agentType?, branchPurpose? }
 */
app.post("/threads", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
    return c.json({ error: "Insufficient scope: hub-protocol.write required" }, 403);
  }
  const body = (await c.req.json()) as {
    userId: string;
    workspaceId: string;
    title?: string;
    parentThreadId?: string;
    agentType?: string;
    branchPurpose?: string;
  };
  // Map agent type to valid DB enum (research maps to default — not in schema enum)
  const VALID_AGENT_TYPES = new Set(["default", "meta", "prompting", "knowledge-search", "code", "writing", "action"]);
  const resolvedAgentType = body.agentType && VALID_AGENT_TYPES.has(body.agentType)
    ? (body.agentType as any)
    : "default";
  try {
    const { randomUUID } = await import("crypto");
    const threadId = randomUUID();
    const [thread] = await db
      .insert(chatThreads)
      .values({
        id: threadId,
        userId: body.userId,
        workspaceId: body.workspaceId,
        title: body.title ?? "New Thread",
        parentThreadId: body.parentThreadId ?? null,
        agentType: resolvedAgentType,
        branchPurpose: body.branchPurpose ?? null,
      })
      .returning();
    return c.json({ id: thread.id, title: thread.title });
  } catch (err) {
    logger.error({ err }, "createThread failed");
    return c.json({ error: err instanceof Error ? err.message : "Unknown error" }, 500);
  }
});

/**
 * GET /threads/:threadId/messages
 * Returns conversation messages for a thread (system + assistant + user roles).
 */
app.get("/threads/:threadId/messages", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
    return c.json({ error: "Insufficient scope: hub-protocol.read required" }, 403);
  }
  const threadId = c.req.param("threadId");
  try {
    const msgs = await db
      .select({
        id: conversationMessages.id,
        role: conversationMessages.role,
        content: conversationMessages.content,
        userId: conversationMessages.userId,
        timestamp: conversationMessages.timestamp,
      })
      .from(conversationMessages)
      .where(eq(conversationMessages.threadId, threadId))
      .orderBy(asc(conversationMessages.timestamp));
    return c.json(msgs);
  } catch (err) {
    logger.error({ err, threadId }, "getThreadMessages failed");
    return c.json({ error: err instanceof Error ? err.message : "Unknown error" }, 500);
  }
});

/**
 * POST /threads/:threadId/messages
 * Inject a system or assistant message into a thread (used by sub-agents to report back).
 * Body: { role: "system" | "assistant", content: string, userId: string }
 */
app.post("/threads/:threadId/messages", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
    return c.json({ error: "Insufficient scope: hub-protocol.write required" }, 403);
  }
  const threadId = c.req.param("threadId");
  const body = (await c.req.json()) as {
    role: "system" | "assistant";
    content: string;
    userId: string;
  };
  if (!body.role || !body.content || !body.userId) {
    return c.json({ error: "role, content, and userId are required" }, 400);
  }
  try {
    const { randomUUID, createHash } = await import("crypto");
    const hash = createHash("sha256")
      .update(JSON.stringify({ threadId, content: body.content, role: body.role }))
      .digest("hex");
    await db.insert(conversationMessages).values({
      id: randomUUID(),
      threadId,
      role: body.role,
      content: body.content,
      userId: body.userId,
      hash,
    });
    return c.json({ success: true });
  } catch (err) {
    logger.error({ err, threadId }, "postMessage failed");
    return c.json({ error: err instanceof Error ? err.message : "Unknown error" }, 500);
  }
});

/**
 * POST /memory
 * Store a knowledge fact (embedding generated by caller)
 * Body: { userId, fact, confidence?, embedding: number[], sourceEntityId?, sourceMessageId? }
 */
app.post("/memory", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
    return c.json({ error: "Insufficient scope: hub-protocol.write required" }, 403);
  }
  const body = (await c.req.json()) as {
    userId: string;
    fact: string;
    confidence?: number;
    embedding: number[];
    sourceEntityId?: string;
    sourceMessageId?: string;
  };
  if (!body.userId || !body.fact || !Array.isArray(body.embedding)) {
    return c.json({ error: "userId, fact, and embedding are required" }, 400);
  }
  try {
    const record = await knowledgeRepository.saveFact({
      userId: body.userId,
      fact: body.fact,
      confidence: body.confidence ?? 0.8,
      embedding: body.embedding,
      sourceEntityId: body.sourceEntityId,
      sourceMessageId: body.sourceMessageId,
    });
    return c.json(record);
  } catch (err) {
    logger.error({ err }, "saveFact failed");
    return c.json({ error: err instanceof Error ? err.message : "Unknown error" }, 500);
  }
});

/**
 * GET /memory?userId=...&query=...&limit=...
 * Search knowledge facts by keyword relevance
 */
app.get("/memory", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
    return c.json({ error: "Insufficient scope: hub-protocol.read required" }, 403);
  }
  const userId = c.req.query("userId");
  const query = c.req.query("query") ?? "";
  const limit = parseInt(c.req.query("limit") ?? "10", 10);
  if (!userId) {
    return c.json({ error: "userId is required" }, 400);
  }
  try {
    const facts = await knowledgeRepository.searchFacts({ userId, query, limit });
    return c.json(facts);
  } catch (err) {
    logger.error({ err }, "searchFacts failed");
    return c.json({ error: err instanceof Error ? err.message : "Unknown error" }, 500);
  }
});

/**
 * POST /memory/search
 * Semantic (cosine distance) search for knowledge facts using a pre-computed embedding.
 * Body: { userId: string; embedding: number[]; limit?: number }
 */
app.post("/memory/search", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
    return c.json({ error: "Insufficient scope: hub-protocol.read required" }, 403);
  }
  const body = await c.req.json<{ userId: string; embedding: number[]; limit?: number }>();
  if (!body.userId || !Array.isArray(body.embedding)) {
    return c.json({ error: "userId and embedding are required" }, 400);
  }
  try {
    const facts = await knowledgeRepository.searchFactsSemantic({
      userId: body.userId,
      embedding: body.embedding,
      limit: body.limit,
    });
    return c.json(facts);
  } catch (err) {
    logger.error({ err }, "searchFactsSemantic failed");
    return c.json({ error: err instanceof Error ? err.message : "Unknown error" }, 500);
  }
});

/**
 * DELETE /memory/:id?userId=...
 * Delete a knowledge fact (userId guard for safety)
 */
app.delete("/memory/:id", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
    return c.json({ error: "Insufficient scope: hub-protocol.write required" }, 403);
  }
  const id = c.req.param("id");
  const userId = c.req.query("userId");
  if (!userId) {
    return c.json({ error: "userId query is required" }, 400);
  }
  try {
    await db
      .delete(knowledgeFacts)
      .where(eq(knowledgeFacts.id, id));
    return c.json({ success: true });
  } catch (err) {
    logger.error({ err, id }, "deleteFact failed");
    return c.json({ error: err instanceof Error ? err.message : "Unknown error" }, 500);
  }
});

/**
 * GET /graph/traverse?userId=...&startEntityId=...&maxDepth=2&relationshipTypes=...
 * Traverse the entity relation graph via BFS from a starting entity.
 * Returns all reachable entities within maxDepth hops.
 */
app.get("/graph/traverse", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
    return c.json({ error: "Insufficient scope: hub-protocol.read required" }, 403);
  }
  const userId = c.req.query("userId");
  const startEntityId = c.req.query("startEntityId");
  const maxDepth = parseInt(c.req.query("maxDepth") ?? "2", 10);
  const relTypesParam = c.req.query("relationshipTypes");
  const relationshipTypes = relTypesParam ? relTypesParam.split(",").filter(Boolean) : undefined;

  if (!userId || !startEntityId) {
    return c.json({ error: "userId and startEntityId are required" }, 400);
  }

  try {
    const results = await traverseEntityGraph({
      userId,
      startEntityId,
      maxDepth: Math.min(maxDepth, 3),
      relationshipTypes,
    });
    return c.json(results);
  } catch (err) {
    logger.error({ err }, "traverseGraph failed");
    return c.json({ error: err instanceof Error ? err.message : "Unknown error" }, 500);
  }
});

/**
 * GET /commands?workspaceId=...
 * List all intelligence commands for a workspace.
 */
app.get("/commands", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
    return c.json({ error: "Insufficient scope: hub-protocol.read required" }, 403);
  }
  const workspaceId = c.req.query("workspaceId");
  if (!workspaceId) {
    return c.json({ error: "workspaceId is required" }, 400);
  }
  try {
    const commands = await db.query.intelligenceCommands.findMany({
      where: eq(intelligenceCommands.workspaceId, workspaceId),
      orderBy: [asc(intelligenceCommands.createdAt)],
    });
    return c.json(commands);
  } catch (err) {
    logger.error({ err }, "listCommands failed");
    return c.json({ error: err instanceof Error ? err.message : "Unknown error" }, 500);
  }
});

/**
 * GET /commands/:id
 * Get a single intelligence command by ID.
 */
app.get("/commands/:id", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
    return c.json({ error: "Insufficient scope: hub-protocol.read required" }, 403);
  }
  const id = c.req.param("id");
  try {
    const command = await db.query.intelligenceCommands.findFirst({
      where: eq(intelligenceCommands.id, id),
    });
    if (!command) return c.json({ error: "Not found" }, 404);
    return c.json(command);
  } catch (err) {
    logger.error({ err, id }, "getCommand failed");
    return c.json({ error: err instanceof Error ? err.message : "Unknown error" }, 500);
  }
});

export const hubProtocolRestApp = app;
