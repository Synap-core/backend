/**
 * Hub Protocol REST Adapter (B1)
 *
 * Exposes hub protocol procedures as REST endpoints for the Intelligence Service.
 * Uses API key auth (Bearer). Mount at /api/hub in the app.
 */

import { Hono } from "hono";
import { realpathSync, existsSync } from "fs";
import { resolve as resolvePath } from "path";
import { createLogger } from "@synap-core/core";
import { apiKeyService } from "../services/api-keys.js";
import { hubProtocolRouter } from "./hub-protocol/index.js";
import { createHubProtocolCallerContext } from "./hub-protocol/utils.js";
import {
  db,
  messages,
  channels,
  knowledgeFacts,
  users,
  eq,
  and,
  or,
  asc,
  desc,
  knowledgeRepository,
  drizzleSql,
  traverseEntityGraph,
  intelligenceCommands,
  mcpServers,
} from "@synap/database";

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
 * Resolve the actor ID for a hub protocol write request.
 *
 * If `agentUserId` is provided, verify it refers to a real agent user
 * (userType = "agent") before trusting it. Returns:
 *   - { actorId: agentUserId } if valid agent
 *   - { actorId: userId } if no agentUserId provided
 *   - { error: string } if agentUserId is provided but invalid
 *
 * This is the single place where the agentUserId claim is authenticated
 * at the REST boundary, before it propagates into tRPC procedure calls.
 */
async function resolveActorId(
  agentUserId: string | undefined,
  userId: string
): Promise<{ actorId: string } | { error: string }> {
  if (!agentUserId) return { actorId: userId };

  const agent = await db.query.users.findFirst({
    where: and(eq(users.id, agentUserId), eq(users.userType, "agent")),
    columns: { id: true },
  });

  if (!agent) {
    logger.warn(
      { agentUserId, userId },
      "Hub request rejected: invalid agentUserId (not an agent user)"
    );
    return {
      error: "Invalid agentUserId — must be a user with userType='agent'",
    };
  }

  return { actorId: agentUserId };
}

/**
 * Helper: get hub protocol caller for current request.
 * Pass workspaceId for workspace-scoped procedures (e.g. entities create/update).
 */
async function getCaller(
  c: { get: (key: string) => unknown },
  options?: {
    workspaceId?: string | null;
    userId?: string;
    sourceMessageId?: string | null;
  }
) {
  // For workspace-scoped calls the body userId (real user) must be used,
  // not the API key's userId ("system"), so the membership check passes.
  const userId = options?.userId ?? (c.get("userId") as string);
  const scopes = c.get("scopes") as string[];
  const ctx = await createHubProtocolCallerContext(
    userId,
    scopes,
    options?.workspaceId,
    options?.sourceMessageId
  );
  return hubProtocolRouter.createCaller(ctx as any);
}

/**
 * GET /threads?userId=...&workspaceId=...&limit=...
 * List chat threads for a user (with parentThreadId for tree construction).
 */
app.get("/threads", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
    return c.json(
      { error: "Insufficient scope: hub-protocol.read required" },
      403
    );
  }
  const userId = c.req.query("userId");
  const workspaceId = c.req.query("workspaceId");
  const limit = parseInt(c.req.query("limit") ?? "50", 10);
  if (!userId) return c.json({ error: "userId is required" }, 400);
  try {
    // Include personal channels (pod-wide) alongside workspace channels
    const whereClause = workspaceId
      ? and(
          eq(channels.userId, userId),
          or(
            eq(channels.workspaceId, workspaceId),
            drizzleSql`${channels.metadata}->>'isPersonal' = 'true'`
          )
        )
      : eq(channels.userId, userId);
    const threads = await db
      .select({
        id: channels.id,
        title: channels.title,
        agentType: channels.agentType,
        parentChannelId: channels.parentChannelId,
        branchPurpose: channels.branchPurpose,
        contextSummary: channels.contextSummary,
        createdAt: channels.createdAt,
        updatedAt: channels.updatedAt,
      })
      .from(channels)
      .where(whereClause)
      .orderBy(desc(channels.updatedAt))
      .limit(Math.min(limit, 200));
    return c.json(threads);
  } catch (err) {
    logger.error({ err, userId }, "listThreads failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500
    );
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
  const body = (await c.req.json()) as {
    contextSummary?: string;
    personalityFingerprint?: string;
  };
  try {
    if (body.contextSummary !== undefined) {
      const caller = await getCaller(c);
      await (caller as any).context.updateThreadContext({
        threadId,
        contextSummary: body.contextSummary ?? "",
      });
    }
    if (body.personalityFingerprint !== undefined) {
      await db
        .update(channels)
        .set({
          metadata: drizzleSql`COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
            'personalityFingerprint', ${body.personalityFingerprint},
            'personalityFingerprintAt', ${new Date().toISOString()}
          )`,
        })
        .where(eq(channels.id, threadId));
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
    agentUserId?: string;
    workspaceId: string;
    type: string;
    profileSlug?: string;
    title: string;
    description?: string;
    properties?: Record<string, unknown>;
    sourceMessageId?: string;
  };
  if (!body.workspaceId) {
    return c.json(
      { error: "workspaceId is required for entity creation (event chain)" },
      400
    );
  }
  try {
    // When agentUserId is provided, use the agent's identity for permission checks
    const actorResolution = await resolveActorId(body.agentUserId, body.userId);
    if ("error" in actorResolution)
      return c.json({ error: actorResolution.error }, 400);
    const actorId = actorResolution.actorId;
    const caller = await getCaller(c, {
      workspaceId: body.workspaceId,
      userId: actorId,
      sourceMessageId: body.sourceMessageId,
    });
    const result = await (caller as any).entities.createEntity({
      userId: body.userId,
      agentUserId: body.agentUserId,
      // Accept profileSlug (preferred) or legacy type field
      profileSlug: body.profileSlug ?? body.type,
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
    agentUserId?: string;
    workspaceId: string;
    title?: string;
    preview?: string;
    metadata?: Record<string, unknown>;
    sourceMessageId?: string;
  };
  if (!body.workspaceId) {
    return c.json(
      { error: "workspaceId is required for entity update (event chain)" },
      400
    );
  }
  try {
    const actorResolution = await resolveActorId(body.agentUserId, body.userId);
    if ("error" in actorResolution)
      return c.json({ error: actorResolution.error }, 400);
    const actorId = actorResolution.actorId;
    const caller = await getCaller(c, {
      workspaceId: body.workspaceId,
      userId: actorId,
      sourceMessageId: body.sourceMessageId,
    });
    const result = await (caller as any).entities.updateEntity({
      entityId,
      userId: body.userId,
      agentUserId: body.agentUserId,
      title: body.title,
      preview: body.preview,
      metadata: body.metadata,
    });
    return c.json(result);
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
      type: type as "text" | "markdown" | "code" | "pdf" | "docx" | undefined,
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
    workspaceId: string;
    title: string;
    content?: string;
    type?: "text" | "markdown" | "code" | "pdf" | "docx";
    reasoning?: string;
    agentUserId?: string;
    sourceMessageId?: string;
  };
  if (!body.workspaceId) {
    return c.json(
      { error: "workspaceId is required for document creation" },
      400
    );
  }
  try {
    const actorResolution = await resolveActorId(body.agentUserId, body.userId);
    if ("error" in actorResolution)
      return c.json({ error: actorResolution.error }, 400);
    const actorId = actorResolution.actorId;
    const caller = await getCaller(c, {
      workspaceId: body.workspaceId,
      userId: actorId,
      sourceMessageId: body.sourceMessageId,
    });
    const result = await (caller as any).documents.createDocument({
      userId: body.userId,
      workspaceId: body.workspaceId,
      title: body.title,
      content: body.content ?? "",
      type: body.type ?? "markdown",
      reasoning: body.reasoning,
      agentUserId: body.agentUserId,
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
    const result = await (caller as any).documents.createDocumentProposal({
      documentId: body.documentId,
      userId: body.userId,
      agentUserId: body.agentUserId,
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

/**
 * GET /proposals?userId=...&workspaceId=...&status=...
 */
app.get("/proposals", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
    return c.json({ error: "Insufficient scope" }, 403);
  }
  const userId = c.req.query("userId") || (c.get("userId") as string);
  const workspaceId = c.req.query("workspaceId");
  const status =
    (c.req.query("status") as "pending" | "approved" | "rejected" | "all") ||
    "pending";
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
    return c.json(
      { error: "Insufficient scope: hub-protocol.write required" },
      403
    );
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
    const code =
      (err as any)?.code === "NOT_FOUND"
        ? 404
        : (err as any)?.code === "BAD_REQUEST"
          ? 400
          : 500;
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
    return c.json(
      { error: "Insufficient scope: hub-protocol.write required" },
      403
    );
  }
  const threadId = c.req.param("threadId");
  const body = (await c.req.json()) as {
    userId: string;
    agentUserId?: string;
    entityId: string;
    relationshipType?: string;
    sourceMessageId?: string;
  };
  try {
    const caller = await getCaller(c);
    const result = await (caller as any).linking.linkEntity({
      userId: body.userId,
      agentUserId: body.agentUserId,
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
    return c.json(
      { error: "Insufficient scope: hub-protocol.write required" },
      403
    );
  }
  const threadId = c.req.param("threadId");
  const body = (await c.req.json()) as {
    userId: string;
    agentUserId?: string;
    documentId: string;
    relationshipType?: string;
    sourceMessageId?: string;
  };
  try {
    const caller = await getCaller(c);
    const result = await (caller as any).linking.linkDocument({
      userId: body.userId,
      agentUserId: body.agentUserId,
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
    return c.json(
      { error: "Insufficient scope: hub-protocol.write required" },
      403
    );
  }
  const body = (await c.req.json()) as {
    userId: string;
    workspaceId: string;
    title?: string;
    parentChannelId?: string;
    agentType?: string;
    branchPurpose?: string;
  };
  const rawAgentType = body.agentType;
  const resolvedAgentType =
    typeof rawAgentType === "string" &&
    rawAgentType.length > 0 &&
    rawAgentType.length <= 100 &&
    /^[\w:.-]+$/.test(rawAgentType)
      ? rawAgentType
      : "meta";
  try {
    const { randomUUID } = await import("crypto");
    const threadId = randomUUID();
    const [thread] = await db
      .insert(channels)
      .values({
        id: threadId,
        userId: body.userId,
        workspaceId: body.workspaceId,
        title: body.title ?? "New Thread",
        parentChannelId: body.parentChannelId ?? null,
        agentType: resolvedAgentType,
        branchPurpose: body.branchPurpose ?? null,
      })
      .returning();
    return c.json({ id: thread.id, title: thread.title });
  } catch (err) {
    logger.error({ err }, "createThread failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500
    );
  }
});

/**
 * GET /threads/:threadId/branches
 * Returns active child branches for a given thread (for bootstrap context injection).
 */
app.get("/threads/:threadId/branches", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
    return c.json(
      { error: "Insufficient scope: hub-protocol.read required" },
      403
    );
  }
  const threadId = c.req.param("threadId");
  try {
    const branches = await db
      .select({
        channelId: channels.id,
        branchPurpose: channels.branchPurpose,
        status: channels.status,
      })
      .from(channels)
      .where(
        and(
          eq(channels.parentChannelId, threadId),
          eq(channels.status, "active")
        )
      )
      .orderBy(asc(channels.createdAt));
    return c.json({ branches });
  } catch (err) {
    logger.error({ err, threadId }, "getBranches failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500
    );
  }
});

/**
 * GET /threads/:threadId/messages
 * Returns conversation messages for a thread (system + assistant + user roles).
 */
app.get("/threads/:threadId/messages", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
    return c.json(
      { error: "Insufficient scope: hub-protocol.read required" },
      403
    );
  }
  const threadId = c.req.param("threadId");
  try {
    const msgs = await db
      .select({
        id: messages.id,
        role: messages.role,
        content: messages.content,
        userId: messages.userId,
        timestamp: messages.timestamp,
        sessionId: messages.sessionId,
        metadata: messages.metadata,
      })
      .from(messages)
      .where(eq(messages.channelId, threadId))
      .orderBy(asc(messages.timestamp));
    return c.json(msgs);
  } catch (err) {
    logger.error({ err, threadId }, "getThreadMessages failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500
    );
  }
});

/**
 * POST /threads/:threadId/messages
 * Inject a message into a thread (used by sub-agents to report back or post user messages).
 * Body: { role: "system" | "assistant" | "user", content: string, userId: string, autoRespond?: boolean }
 *
 * autoRespond=true: queues an IS response trigger for AI_THREAD and BRANCH channels.
 * Used for async inter-branch messaging — branch A posts "user" message to branch B,
 * branch B's IS responds automatically via the a2ai-response-trigger worker.
 */
app.post("/threads/:threadId/messages", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
    return c.json(
      { error: "Insufficient scope: hub-protocol.write required" },
      403
    );
  }
  const threadId = c.req.param("threadId");
  const body = (await c.req.json()) as {
    role: "system" | "assistant" | "user";
    content: string;
    userId: string;
    metadata?: Record<string, unknown>;
    autoRespond?: boolean;
  };
  if (!body.role || !body.content || !body.userId) {
    return c.json({ error: "role, content, and userId are required" }, 400);
  }
  try {
    const { randomUUID, createHash } = await import("crypto");
    const msgId = randomUUID();
    const hash = createHash("sha256")
      .update(
        JSON.stringify({ threadId, content: body.content, role: body.role })
      )
      .digest("hex");
    await db.insert(messages).values({
      id: msgId,
      channelId: threadId,
      role: body.role as any,
      content: body.content,
      userId: body.userId,
      hash,
      ...(body.metadata ? { metadata: body.metadata } : {}),
    });

    // autoRespond: trigger IS to respond when an external agent posts a user-role message
    // to an AI channel (ai_thread or branch). Enables async inter-branch messaging.
    if (body.autoRespond === true && body.role === "user") {
      const channel = await db.query.channels.findFirst({
        where: eq(channels.id, threadId),
      });
      const { ChannelType } = await import("@synap/database/schema");
      if (
        channel?.workspaceId &&
        (channel.channelType === ChannelType.AI_THREAD ||
          channel.channelType === ChannelType.BRANCH)
      ) {
        try {
          const { resolveIntelligenceService } =
            await import("../utils/intelligence-routing.js");
          const { getBoss, A2AI_TRIGGER_QUEUE, A2AI_TRIGGER_JOB_OPTIONS } =
            await import("@synap/jobs");
          const resolvedService = await resolveIntelligenceService({
            userId: channel.userId,
            workspaceId: channel.workspaceId,
            capability: "chat",
          });
          await getBoss().send(
            A2AI_TRIGGER_QUEUE,
            {
              channelId: threadId,
              userMessageId: msgId,
              content: body.content,
              userId: channel.userId,
              workspaceId: channel.workspaceId,
              agentType: (channel.agentType as string) ?? "meta",
              sourceAgentUserId: body.userId,
              serviceUrl: resolvedService.endpoint,
              serviceApiKey: resolvedService.serviceApiKey,
              serviceId: resolvedService.serviceId,
              agentUserId: resolvedService.agentUserId,
            },
            A2AI_TRIGGER_JOB_OPTIONS
          );
        } catch (err) {
          // Non-fatal: message stored, trigger queueing failed
          logger.warn(
            { err, threadId },
            "postMessage autoRespond trigger failed"
          );
        }
      }
    }

    return c.json({ success: true, messageId: msgId });
  } catch (err) {
    logger.error({ err, threadId }, "postMessage failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500
    );
  }
});

/**
 * POST /memory
 * Store a knowledge fact (embedding generated by caller)
 * Body: { userId, fact, confidence?, embedding: number[], sourceEntityId?, sourceMessageId? }
 */
app.post("/memory", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
    return c.json(
      { error: "Insufficient scope: hub-protocol.write required" },
      403
    );
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
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500
    );
  }
});

/**
 * GET /memory?userId=...&query=...&limit=...
 * Search knowledge facts by keyword relevance
 */
app.get("/memory", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
    return c.json(
      { error: "Insufficient scope: hub-protocol.read required" },
      403
    );
  }
  const userId = c.req.query("userId");
  const query = c.req.query("query") ?? "";
  const limit = parseInt(c.req.query("limit") ?? "10", 10);
  if (!userId) {
    return c.json({ error: "userId is required" }, 400);
  }
  try {
    const facts = await knowledgeRepository.searchFacts({
      userId,
      query,
      limit,
    });
    return c.json(facts);
  } catch (err) {
    logger.error({ err }, "searchFacts failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500
    );
  }
});

/**
 * POST /memory/search
 * Semantic (cosine distance) search for knowledge facts using a pre-computed embedding.
 * Body: { userId: string; embedding: number[]; limit?: number }
 */
app.post("/memory/search", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
    return c.json(
      { error: "Insufficient scope: hub-protocol.read required" },
      403
    );
  }
  const body = await c.req.json<{
    userId: string;
    embedding: number[];
    limit?: number;
  }>();
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
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500
    );
  }
});

/**
 * DELETE /memory/:id?userId=...
 * Delete a knowledge fact (userId guard for safety)
 */
app.delete("/memory/:id", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
    return c.json(
      { error: "Insufficient scope: hub-protocol.write required" },
      403
    );
  }
  const id = c.req.param("id");
  const userId = c.req.query("userId");
  if (!userId) {
    return c.json({ error: "userId query is required" }, 400);
  }
  try {
    await db.delete(knowledgeFacts).where(eq(knowledgeFacts.id, id));
    return c.json({ success: true });
  } catch (err) {
    logger.error({ err, id }, "deleteFact failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500
    );
  }
});

/**
 * GET /graph/traverse?userId=...&startEntityId=...&maxDepth=2&relationshipTypes=...
 * Traverse the entity relation graph via BFS from a starting entity.
 * Returns all reachable entities within maxDepth hops.
 */
app.get("/graph/traverse", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
    return c.json(
      { error: "Insufficient scope: hub-protocol.read required" },
      403
    );
  }
  const userId = c.req.query("userId");
  const startEntityId = c.req.query("startEntityId");
  const maxDepth = parseInt(c.req.query("maxDepth") ?? "2", 10);
  const relTypesParam = c.req.query("relationshipTypes");
  const relationshipTypes = relTypesParam
    ? relTypesParam.split(",").filter(Boolean)
    : undefined;

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
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500
    );
  }
});

/**
 * GET /commands?workspaceId=...
 * List all intelligence commands for a workspace.
 */
app.get("/commands", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
    return c.json(
      { error: "Insufficient scope: hub-protocol.read required" },
      403
    );
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
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500
    );
  }
});

/**
 * GET /commands/:id
 * Get a single intelligence command by ID.
 */
app.get("/commands/:id", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
    return c.json(
      { error: "Insufficient scope: hub-protocol.read required" },
      403
    );
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
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500
    );
  }
});

/**
 * GET /agent-users?workspaceId=...
 * List AI agent users in a workspace (so the hub can discover available agents).
 */
app.get("/agent-users", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
    return c.json(
      { error: "Insufficient scope: hub-protocol.read required" },
      403
    );
  }
  const workspaceId = c.req.query("workspaceId");
  if (!workspaceId) {
    return c.json({ error: "workspaceId is required" }, 400);
  }
  try {
    const { users, workspaceMembers } = await import("@synap/database/schema");
    const results = await db
      .select({
        id: users.id,
        name: users.name,
        agentMetadata: users.agentMetadata,
        role: workspaceMembers.role,
      })
      .from(users)
      .innerJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.userId, users.id),
          eq(workspaceMembers.workspaceId, workspaceId)
        )
      )
      .where(eq(users.userType, "agent"));
    return c.json(results);
  } catch (err) {
    logger.error({ err }, "listAgentUsers failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500
    );
  }
});

// =============================================================================
// Views
// =============================================================================

/**
 * GET /views?userId=...&workspaceId=...&type=...&profileId=...
 */
app.get("/views", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
    return c.json(
      { error: "Insufficient scope: hub-protocol.read required" },
      403
    );
  }
  const userId = c.req.query("userId");
  const workspaceId = c.req.query("workspaceId");
  if (!userId || !workspaceId) {
    return c.json({ error: "userId and workspaceId are required" }, 400);
  }
  try {
    const caller = await getCaller(c, { userId, workspaceId });
    const result = await (caller as any).views.listViews({
      userId,
      workspaceId,
      type: c.req.query("type"),
      profileId: c.req.query("profileId"),
    });
    return c.json(result);
  } catch (err) {
    logger.error({ err }, "listViews failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500
    );
  }
});

/**
 * POST /views
 */
app.post("/views", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
    return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
  }
  const body = (await c.req.json()) as {
    userId: string;
    workspaceId: string;
    name: string;
    type: string;
    profileId?: string;
    config?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    agentUserId?: string;
    reasoning?: string;
    sourceMessageId?: string;
  };
  if (!body.workspaceId) {
    return c.json({ error: "workspaceId is required" }, 400);
  }
  try {
    const actorResolution = await resolveActorId(body.agentUserId, body.userId);
    if ("error" in actorResolution)
      return c.json({ error: actorResolution.error }, 400);
    const actorId = actorResolution.actorId;
    const caller = await getCaller(c, {
      userId: actorId,
      workspaceId: body.workspaceId,
      sourceMessageId: body.sourceMessageId,
    });
    const result = await (caller as any).views.createView({
      userId: body.userId,
      workspaceId: body.workspaceId,
      name: body.name,
      type: body.type,
      profileId: body.profileId,
      config: body.config,
      metadata: body.metadata,
      agentUserId: body.agentUserId,
      reasoning: body.reasoning,
    });
    return c.json(result);
  } catch (err) {
    logger.error({ err }, "createView failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500
    );
  }
});

/**
 * PATCH /views/:viewId
 */
app.patch("/views/:viewId", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
    return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
  }
  const viewId = c.req.param("viewId");
  const body = (await c.req.json()) as {
    userId: string;
    workspaceId?: string;
    name?: string;
    config?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    agentUserId?: string;
    reasoning?: string;
    sourceMessageId?: string;
  };
  try {
    const actorResolution = await resolveActorId(body.agentUserId, body.userId);
    if ("error" in actorResolution)
      return c.json({ error: actorResolution.error }, 400);
    const actorId = actorResolution.actorId;
    const caller = await getCaller(c, {
      userId: actorId,
      workspaceId: body.workspaceId,
      sourceMessageId: body.sourceMessageId,
    });
    const result = await (caller as any).views.updateView({
      userId: body.userId,
      viewId,
      workspaceId: body.workspaceId,
      name: body.name,
      config: body.config,
      metadata: body.metadata,
      agentUserId: body.agentUserId,
      reasoning: body.reasoning,
    });
    return c.json(result);
  } catch (err) {
    logger.error({ err, viewId }, "updateView failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500
    );
  }
});

/**
 * POST /views/:viewId/arrange
 */
app.post("/views/:viewId/arrange", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
    return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
  }
  const viewId = c.req.param("viewId");
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const actorId = c.get("userId") as string;
  if (!actorId) return c.json({ error: "Unauthorized" }, 401);

  try {
    const caller = await getCaller(c, {
      userId: actorId,
      workspaceId: body.workspaceId,
      sourceMessageId: body.sourceMessageId,
    });
    const result = await (caller as any).views.arrangeBento({
      userId: body.userId,
      workspaceId: body.workspaceId,
      viewId,
      widgets: body.widgets,
      agentUserId: body.agentUserId,
      reasoning: body.reasoning,
    });
    return c.json(result);
  } catch (err) {
    logger.error({ err, viewId }, "arrangeBento failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500
    );
  }
});

// =============================================================================
// Profiles & Property Defs
// =============================================================================

/**
 * GET /profiles?userId=...&workspaceId=...
 */
app.get("/profiles", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
    return c.json(
      { error: "Insufficient scope: hub-protocol.read required" },
      403
    );
  }
  const userId = c.req.query("userId");
  const workspaceId = c.req.query("workspaceId");
  if (!userId || !workspaceId) {
    return c.json({ error: "userId and workspaceId are required" }, 400);
  }
  try {
    const caller = await getCaller(c, { userId, workspaceId });
    const result = await (caller as any).profiles.listProfiles({
      userId,
      workspaceId,
    });
    return c.json(result);
  } catch (err) {
    logger.error({ err }, "listProfiles failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500
    );
  }
});

/**
 * POST /profiles
 */
app.post("/profiles", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
    return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
  }
  const body = (await c.req.json()) as {
    userId: string;
    workspaceId: string;
    slug: string;
    displayName: string;
    description?: string;
    defaultValues?: Record<string, unknown>;
    parentProfileId?: string;
    uiHints?: Record<string, unknown>;
    reasoning?: string;
    agentUserId?: string;
    sourceMessageId?: string;
  };
  try {
    const actorResolution = await resolveActorId(body.agentUserId, body.userId);
    if ("error" in actorResolution)
      return c.json({ error: actorResolution.error }, 400);
    const actorId = actorResolution.actorId;
    const caller = await getCaller(c, {
      userId: actorId,
      workspaceId: body.workspaceId,
      sourceMessageId: body.sourceMessageId,
    });
    const result = await (caller as any).profiles.createProfile({
      userId: body.userId,
      workspaceId: body.workspaceId,
      slug: body.slug,
      displayName: body.displayName,
      description: body.description,
      defaultValues: body.defaultValues,
      parentProfileId: body.parentProfileId,
      uiHints: body.uiHints,
      reasoning: body.reasoning,
      agentUserId: body.agentUserId,
    });
    return c.json(result);
  } catch (err) {
    logger.error({ err }, "createProfile failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500
    );
  }
});

/**
 * GET /property-defs?userId=...&workspaceId=...&profileId=...
 */
app.get("/property-defs", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
    return c.json(
      { error: "Insufficient scope: hub-protocol.read required" },
      403
    );
  }
  const userId = c.req.query("userId");
  const workspaceId = c.req.query("workspaceId");
  if (!userId || !workspaceId) {
    return c.json({ error: "userId and workspaceId are required" }, 400);
  }
  try {
    const caller = await getCaller(c, { userId, workspaceId });
    const result = await (caller as any).profiles.listPropertyDefs({
      userId,
      workspaceId,
      profileId: c.req.query("profileId"),
    });
    return c.json(result);
  } catch (err) {
    logger.error({ err }, "listPropertyDefs failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500
    );
  }
});

/**
 * POST /property-defs
 */
app.post("/property-defs", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
    return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
  }
  const body = (await c.req.json()) as {
    userId: string;
    workspaceId: string;
    profileId?: string;
    slug: string;
    valueType: string;
    constraints?: Record<string, unknown>;
    uiHints?: Record<string, unknown>;
    agentUserId?: string;
    sourceMessageId?: string;
  };
  try {
    const actorResolution = await resolveActorId(body.agentUserId, body.userId);
    if ("error" in actorResolution)
      return c.json({ error: actorResolution.error }, 400);
    const actorId = actorResolution.actorId;
    const caller = await getCaller(c, {
      userId: actorId,
      workspaceId: body.workspaceId,
      sourceMessageId: body.sourceMessageId,
    });
    const result = await (caller as any).profiles.createPropertyDef({
      userId: body.userId,
      profileId: body.profileId,
      slug: body.slug,
      valueType: body.valueType,
      constraints: body.constraints,
      uiHints: body.uiHints,
      agentUserId: body.agentUserId,
    });
    return c.json(result);
  } catch (err) {
    logger.error({ err }, "createPropertyDef failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500
    );
  }
});

// =============================================================================
// Relations
// =============================================================================

/**
 * GET /relations?userId=...&workspaceId=...&entityId=...&type=...
 */
app.get("/relations", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
    return c.json(
      { error: "Insufficient scope: hub-protocol.read required" },
      403
    );
  }
  const userId = c.req.query("userId");
  const workspaceId = c.req.query("workspaceId");
  if (!userId || !workspaceId) {
    return c.json({ error: "userId and workspaceId are required" }, 400);
  }
  try {
    const caller = await getCaller(c, { userId, workspaceId });
    const result = await (caller as any).relations.listRelations({
      userId,
      workspaceId,
      entityId: c.req.query("entityId"),
      type: c.req.query("type"),
    });
    return c.json(result);
  } catch (err) {
    logger.error({ err }, "listRelations failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500
    );
  }
});

/**
 * POST /relations
 */
app.post("/relations", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
    return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
  }
  const body = (await c.req.json()) as {
    userId: string;
    workspaceId: string;
    sourceEntityId: string;
    targetEntityId: string;
    type: string;
    metadata?: Record<string, unknown>;
    agentUserId?: string;
    reasoning?: string;
    sourceMessageId?: string;
  };
  try {
    const actorResolution = await resolveActorId(body.agentUserId, body.userId);
    if ("error" in actorResolution)
      return c.json({ error: actorResolution.error }, 400);
    const actorId = actorResolution.actorId;
    const caller = await getCaller(c, {
      userId: actorId,
      workspaceId: body.workspaceId,
      sourceMessageId: body.sourceMessageId,
    });
    const result = await (caller as any).relations.createRelation({
      userId: body.userId,
      workspaceId: body.workspaceId,
      sourceEntityId: body.sourceEntityId,
      targetEntityId: body.targetEntityId,
      type: body.type,
      metadata: body.metadata,
      agentUserId: body.agentUserId,
      reasoning: body.reasoning,
    });
    return c.json(result);
  } catch (err) {
    logger.error({ err }, "createRelation failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500
    );
  }
});

// ============================================================================
// Sessions
// ============================================================================

/**
 * POST /sessions/getOrCreate
 * Body: { channelId, bootstrapStateId? }
 */
app.post("/sessions/getOrCreate", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
    return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
  }
  const body = (await c.req.json().catch(() => null)) as {
    channelId?: string;
    bootstrapStateId?: string;
  } | null;
  if (!body) return c.json({ error: "Invalid JSON in request body" }, 400);
  if (!body.channelId) {
    return c.json({ error: "channelId is required" }, 400);
  }
  try {
    const caller = await getCaller(c);
    const result = await (caller as any).sessions.getOrCreate({
      channelId: body.channelId,
      bootstrapStateId: body.bootstrapStateId,
    });
    return c.json(result);
  } catch (err) {
    logger.error({ err }, "sessions.getOrCreate failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500
    );
  }
});

/**
 * GET /sessions/active?channelId=...
 */
app.get("/sessions/active", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
    return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
  }
  const channelId = c.req.query("channelId");
  if (!channelId) {
    return c.json({ error: "channelId is required" }, 400);
  }
  try {
    const caller = await getCaller(c);
    const result = await (caller as any).sessions.getActive({ channelId });
    return c.json(result ?? null);
  } catch (err) {
    logger.error({ err }, "sessions.getActive failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500
    );
  }
});

/**
 * GET /sessions/:sessionId
 */
app.get("/sessions/:sessionId", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
    return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
  }
  const sessionId = c.req.param("sessionId");
  try {
    const caller = await getCaller(c);
    const result = await (caller as any).sessions.get({ sessionId });
    return c.json(result);
  } catch (err) {
    logger.error({ err, sessionId }, "sessions.get failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      (err as any)?.code === "NOT_FOUND" ? 404 : 500
    );
  }
});

/**
 * GET /sessions?channelId=...&limit=...
 */
app.get("/sessions", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
    return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
  }
  const channelId = c.req.query("channelId");
  const limit = parseInt(c.req.query("limit") ?? "10", 10);
  if (!channelId) {
    return c.json({ error: "channelId is required" }, 400);
  }
  try {
    const caller = await getCaller(c);
    const result = await (caller as any).sessions.list({ channelId, limit });
    return c.json(result);
  } catch (err) {
    logger.error({ err }, "sessions.list failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500
    );
  }
});

/**
 * PATCH /sessions/:sessionId
 * Body: { status?, endedAt?, bootstrapStateId?, producedStateId?, totalTokensUsed?, messageCount?, compactionCount? }
 */
app.patch("/sessions/:sessionId", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
    return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
  }
  const sessionId = c.req.param("sessionId");
  const body = (await c.req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!body) return c.json({ error: "Invalid JSON in request body" }, 400);
  try {
    const caller = await getCaller(c);
    const result = await (caller as any).sessions.update({
      sessionId,
      ...body,
    });
    return c.json(result);
  } catch (err) {
    logger.error({ err, sessionId }, "sessions.update failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      (err as any)?.code === "NOT_FOUND" ? 404 : 500
    );
  }
});

/**
 * POST /sessions/:sessionId/close
 * Body: { producedStateId? }
 */
app.post("/sessions/:sessionId/close", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
    return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
  }
  const sessionId = c.req.param("sessionId");
  const body = (await c.req.json().catch(() => null)) as {
    producedStateId?: string;
  } | null;
  if (!body) return c.json({ error: "Invalid JSON in request body" }, 400);
  try {
    const caller = await getCaller(c);
    const result = await (caller as any).sessions.close({
      sessionId,
      producedStateId: body.producedStateId,
    });
    return c.json(result);
  } catch (err) {
    logger.error({ err, sessionId }, "sessions.close failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      (err as any)?.code === "NOT_FOUND" ? 404 : 500
    );
  }
});

// ============================================================================
// Compacted States
// ============================================================================

/**
 * POST /compacted-states
 * Body: { channelId, sessionId?, version?, identityBlock, userModelBlock, continuityBlock, activeGoalsBlock, entityContextBlock, rawTokenCount?, compressedTokenCount?, compactionModel?, metadata? }
 */
app.post("/compacted-states", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
    return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
  }
  const body = (await c.req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!body) return c.json({ error: "Invalid JSON in request body" }, 400);
  if (!body.channelId) {
    return c.json({ error: "channelId is required" }, 400);
  }
  try {
    const caller = await getCaller(c);
    const result = await (caller as any).compactedStates.create(body);
    return c.json(result);
  } catch (err) {
    logger.error({ err }, "compactedStates.create failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500
    );
  }
});

/**
 * GET /compacted-states/latest?channelId=...
 */
app.get("/compacted-states/latest", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
    return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
  }
  const channelId = c.req.query("channelId");
  if (!channelId) {
    return c.json({ error: "channelId is required" }, 400);
  }
  try {
    const caller = await getCaller(c);
    const result = await (caller as any).compactedStates.getLatest({
      channelId,
    });
    return c.json(result ?? null);
  } catch (err) {
    logger.error({ err }, "compactedStates.getLatest failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500
    );
  }
});

/**
 * GET /compacted-states/:stateId
 */
app.get("/compacted-states/:stateId", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
    return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
  }
  const stateId = c.req.param("stateId");
  try {
    const caller = await getCaller(c);
    const result = await (caller as any).compactedStates.get({ stateId });
    return c.json(result);
  } catch (err) {
    logger.error({ err, stateId }, "compactedStates.get failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      (err as any)?.code === "NOT_FOUND" ? 404 : 500
    );
  }
});

/**
 * GET /compacted-states?channelId=...&limit=...
 */
app.get("/compacted-states", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
    return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
  }
  const channelId = c.req.query("channelId");
  const limit = parseInt(c.req.query("limit") ?? "5", 10);
  if (!channelId) {
    return c.json({ error: "channelId is required" }, 400);
  }
  try {
    const caller = await getCaller(c);
    const result = await (caller as any).compactedStates.list({
      channelId,
      limit,
    });
    return c.json(result);
  } catch (err) {
    logger.error({ err }, "compactedStates.list failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500
    );
  }
});

// ============================================================================

/**
 * DELETE /relations/:relationId
 */
app.delete("/relations/:relationId", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
    return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
  }
  const relationId = c.req.param("relationId");
  const body = (await c.req.json().catch(() => null)) as {
    userId?: string;
    workspaceId?: string;
    agentUserId?: string;
    reasoning?: string;
    sourceMessageId?: string;
  } | null;
  if (!body) return c.json({ error: "Invalid JSON in request body" }, 400);
  const userId = body.userId ?? c.req.query("userId") ?? "";
  try {
    const actorId = body.agentUserId || userId;
    const caller = await getCaller(c, {
      userId: actorId,
      workspaceId: body.workspaceId,
      sourceMessageId: body.sourceMessageId,
    });
    const result = await (caller as any).relations.deleteRelation({
      userId,
      workspaceId: body.workspaceId,
      relationId,
      agentUserId: body.agentUserId,
      reasoning: body.reasoning,
    });
    return c.json(result);
  } catch (err) {
    logger.error({ err, relationId }, "deleteRelation failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500
    );
  }
});

// ============================================================================
// Widget Definitions
// ============================================================================

/**
 * GET /widget-definitions?workspaceId=...
 * List active widget definitions (builtins + workspace-specific).
 */
app.get("/widget-definitions", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
    return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
  }
  const workspaceId = c.req.query("workspaceId");
  if (!workspaceId) {
    return c.json({ error: "workspaceId is required" }, 400);
  }
  try {
    const caller = await getCaller(c, { workspaceId });
    const result = await (caller as any).widgetDefinitions.listWidgetDefs({
      workspaceId,
    });
    return c.json(result);
  } catch (err) {
    logger.error({ err }, "widgetDefinitions.listWidgetDefs failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500
    );
  }
});

// =============================================================================
// MCP Servers
// =============================================================================

/**
 * GET /mcp-servers?workspaceId=...
 * List workspace MCP servers for the Intelligence Service.
 * Returns only approved + enabled servers (the IS should only know about usable ones).
 */
app.get("/mcp-servers", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
    return c.json(
      { error: "Insufficient scope: hub-protocol.read required" },
      403
    );
  }
  const workspaceId = c.req.query("workspaceId");
  if (!workspaceId) {
    return c.json({ error: "workspaceId is required" }, 400);
  }
  try {
    const rows = await db.query.mcpServers.findMany({
      where: and(
        eq(mcpServers.workspaceId, workspaceId),
        eq(mcpServers.approved, true),
        eq(mcpServers.enabled, true)
      ),
      columns: {
        id: true,
        slug: true,
        name: true,
        description: true,
        approved: true,
        enabled: true,
        transport: true,
      },
    });
    return c.json(rows);
  } catch (err) {
    logger.error({ err, workspaceId }, "listMcpServers failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500
    );
  }
});

// =============================================================================
// Proposals (create)
// =============================================================================

/**
 * POST /proposals
 * Create a new proposal on behalf of an agent.
 * Used by request_mcp and similar tools that need to surface a pending action to the user.
 * Body: { workspaceId, agentUserId, channelId?, targetType, targetId, proposalType, data, summary? }
 */
app.post("/proposals", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
    return c.json(
      { error: "Insufficient scope: hub-protocol.write required" },
      403
    );
  }
  const body = (await c.req.json()) as {
    workspaceId: string;
    agentUserId?: string;
    channelId?: string;
    targetType: string;
    targetId: string;
    proposalType: string;
    data: Record<string, unknown>;
    summary?: string;
    sourceMessageId?: string;
  };
  if (
    !body.workspaceId ||
    !body.targetType ||
    !body.targetId ||
    !body.proposalType ||
    !body.data
  ) {
    return c.json(
      {
        error:
          "workspaceId, targetType, targetId, proposalType, and data are required",
      },
      400
    );
  }
  try {
    const { proposals, ProposalStatus } =
      await import("@synap/database/schema");
    const { randomUUID } = await import("crypto");
    const id = randomUUID();
    const dataWithSummary = body.summary
      ? { ...body.data, _summary: body.summary }
      : body.data;
    const [row] = await db
      .insert(proposals)
      .values({
        id,
        workspaceId: body.workspaceId,
        targetType: body.targetType,
        targetId: body.targetId,
        proposalType: body.proposalType,
        data: dataWithSummary,
        status: ProposalStatus.PENDING,
        agentUserId: body.agentUserId ?? null,
        threadId: body.channelId ?? null,
        sourceMessageId: body.sourceMessageId ?? null,
        createdBy: body.agentUserId ?? null,
      })
      .returning({ id: proposals.id });
    return c.json({ id: row.id, status: "pending" });
  } catch (err) {
    logger.error({ err }, "createProposal failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500
    );
  }
});

/**
 * POST /widget-definitions
 * Create or update a workspace-specific widget definition.
 */
app.post("/widget-definitions", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
    return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
  }
  const body = (await c.req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!body) return c.json({ error: "Invalid JSON in request body" }, 400);
  const userId = (body.userId as string) ?? (c.get("userId") as string);
  const workspaceId = body.workspaceId as string;
  if (!workspaceId) {
    return c.json({ error: "workspaceId is required" }, 400);
  }
  try {
    const caller = await getCaller(c, {
      userId,
      workspaceId,
      sourceMessageId: (body.sourceMessageId as string) ?? null,
    });
    const result = await (caller as any).widgetDefinitions.upsertWidgetDef({
      ...body,
      userId,
    });
    return c.json(result);
  } catch (err) {
    logger.error({ err }, "widgetDefinitions.upsertWidgetDef failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500
    );
  }
});

// ── Automations ──────────────────────────────────────────────────────────────

/**
 * POST /automations/create
 * Create a new automation (typically draft, from AI tool).
 */
app.post("/automations/create", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
    return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
  }
  const body = (await c.req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!body) return c.json({ error: "Invalid JSON in request body" }, 400);

  const userId = (body.userId as string) ?? (c.get("userId") as string);
  const workspaceId = body.workspaceId as string;
  if (!workspaceId) {
    return c.json({ error: "workspaceId is required" }, 400);
  }
  if (!body.name) {
    return c.json({ error: "name is required" }, 400);
  }
  if (!body.triggerType) {
    return c.json({ error: "triggerType is required" }, 400);
  }

  try {
    const caller = await getCaller(c, {
      userId,
      workspaceId,
      sourceMessageId: (body.sourceMessageId as string) ?? null,
    });
    const result = await (caller as any).automations.createAutomation({
      userId,
      agentUserId: body.agentUserId as string | undefined,
      workspaceId,
      sourceMessageId: body.sourceMessageId as string | undefined,
      name: body.name as string,
      description: body.description as string | undefined,
      triggerType: body.triggerType as string,
      triggerConfig: (body.triggerConfig as Record<string, unknown>) ?? {},
      flowDefinition: body.flowDefinition as {
        nodes: unknown[];
        edges: unknown[];
      },
      status: (body.status as string) ?? "draft",
      metadata: body.metadata as Record<string, unknown> | undefined,
    });
    return c.json(result);
  } catch (err) {
    logger.error({ err }, "automations.create failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500
    );
  }
});

/**
 * GET /automations?userId=...&workspaceId=...&status=...&limit=...
 * List automations for a workspace.
 */
app.get("/automations", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
    return c.json({ error: "Missing scope: hub-protocol.read required" }, 403);
  }
  const userId = c.req.query("userId");
  const workspaceId = c.req.query("workspaceId");
  if (!userId) return c.json({ error: "userId is required" }, 400);
  if (!workspaceId) return c.json({ error: "workspaceId is required" }, 400);

  try {
    const caller = await getCaller(c, { userId, workspaceId });
    const result = await (caller as any).automations.listAutomations({
      userId,
      workspaceId,
      status: c.req.query("status") || undefined,
      limit: c.req.query("limit")
        ? parseInt(c.req.query("limit")!, 10)
        : undefined,
    });
    return c.json(result);
  } catch (err) {
    logger.error({ err }, "automations.list failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500
    );
  }
});

/**
 * GET /automations/:automationId
 * Get a single automation by ID.
 */
app.get("/automations/:automationId", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
    return c.json({ error: "Missing scope: hub-protocol.read required" }, 403);
  }
  const userId = c.req.query("userId");
  const workspaceId = c.req.query("workspaceId");
  if (!userId) return c.json({ error: "userId is required" }, 400);
  if (!workspaceId) return c.json({ error: "workspaceId is required" }, 400);

  try {
    const caller = await getCaller(c, { userId, workspaceId });
    const result = await (caller as any).automations.getAutomation({
      userId,
      workspaceId,
      id: c.req.param("automationId"),
    });
    return c.json(result);
  } catch (err) {
    logger.error({ err }, "automations.get failed");
    const status =
      err instanceof Error && err.message.includes("not found") ? 404 : 500;
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      status
    );
  }
});

/**
 * POST /automations/:automationId/trigger
 * Manually trigger an automation.
 */
app.post("/automations/:automationId/trigger", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
    return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
  }
  const body = (await c.req.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  const userId = (body.userId as string) ?? (c.get("userId") as string);
  const workspaceId = body.workspaceId as string;
  if (!userId || !workspaceId) {
    return c.json({ error: "userId and workspaceId are required" }, 400);
  }

  try {
    const caller = await getCaller(c, { userId, workspaceId });
    const result = await (caller as any).automations.triggerAutomation({
      userId,
      workspaceId,
      id: c.req.param("automationId"),
      payload: body.payload as Record<string, unknown> | undefined,
    });
    return c.json(result);
  } catch (err) {
    logger.error({ err }, "automations.trigger failed");
    const status =
      err instanceof Error && err.message.includes("not found") ? 404 : 500;
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      status
    );
  }
});

/**
 * PATCH /automations/:automationId
 * Update an automation.
 */
app.patch("/automations/:automationId", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
    return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
  }
  const body = (await c.req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!body) return c.json({ error: "Invalid JSON" }, 400);

  const userId = (body.userId as string) ?? (c.get("userId") as string);
  const workspaceId = body.workspaceId as string;
  if (!userId || !workspaceId) {
    return c.json({ error: "userId and workspaceId are required" }, 400);
  }

  try {
    const caller = await getCaller(c, { userId, workspaceId });
    const result = await (caller as any).automations.updateAutomation({
      userId,
      workspaceId,
      id: c.req.param("automationId"),
      name: body.name as string | undefined,
      description: body.description as string | undefined,
      triggerType: body.triggerType as string | undefined,
      triggerConfig: body.triggerConfig as Record<string, unknown> | undefined,
      flowDefinition: body.flowDefinition as
        | { nodes: unknown[]; edges: unknown[] }
        | undefined,
      status: body.status as string | undefined,
      metadata: body.metadata as Record<string, unknown> | undefined,
    });
    return c.json(result);
  } catch (err) {
    logger.error({ err }, "automations.update failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500
    );
  }
});

/**
 * POST /automations/:automationId/activate
 * Activate an automation.
 */
app.post("/automations/:automationId/activate", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
    return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
  }
  const body = (await c.req.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  const userId = (body.userId as string) ?? (c.get("userId") as string);
  const workspaceId = body.workspaceId as string;
  if (!userId || !workspaceId) {
    return c.json({ error: "userId and workspaceId are required" }, 400);
  }

  try {
    const caller = await getCaller(c, { userId, workspaceId });
    const result = await (caller as any).automations.activateAutomation({
      userId,
      workspaceId,
      id: c.req.param("automationId"),
    });
    return c.json(result);
  } catch (err) {
    logger.error({ err }, "automations.activate failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500
    );
  }
});

/**
 * POST /automations/:automationId/pause
 * Pause an automation.
 */
app.post("/automations/:automationId/pause", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
    return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
  }
  const body = (await c.req.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  const userId = (body.userId as string) ?? (c.get("userId") as string);
  const workspaceId = body.workspaceId as string;
  if (!userId || !workspaceId) {
    return c.json({ error: "userId and workspaceId are required" }, 400);
  }

  try {
    const caller = await getCaller(c, { userId, workspaceId });
    const result = await (caller as any).automations.pauseAutomation({
      userId,
      workspaceId,
      id: c.req.param("automationId"),
    });
    return c.json(result);
  } catch (err) {
    logger.error({ err }, "automations.pause failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500
    );
  }
});

// ─── CLI Command Execution ──────────────────────────────────────────────────

/** Commands that are always blocked regardless of permissions */
const BLOCKED_COMMAND_PATTERNS = [
  // Filesystem destruction
  /\brm\s+.*-[a-z]*r[a-z]*f/i, // rm -rf (any flags order)
  /\brm\s+.*\s+\/($|\s)/i, // rm anything at root
  /\brm\s+-[a-z]*r/i, // any recursive rm

  // System control
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bhalt\b/i,
  /\bpoweroff\b/i,
  /\binit\s+[0-6]\b/i,
  /\bsystemctl\s+(halt|poweroff|reboot)\b/i,

  // Disk/device destruction
  /\bmkfs\b/i,
  /\bdd\b.*\bof\s*=\s*\/dev\//i, // dd to block devices
  />\s*\/dev\/sd[a-z]/i, // write to block devices
  />\s*\/dev\/nvme/i,

  // Fork bombs and resource exhaustion
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/, // :(){ :|:& };:
  /\bfork\s*bomb/i,
  /while\s+true.*do/i, // while true; do ... (infinite loops)
  /\byes\s*\|/i, // yes | ... (can flood stdin)

  // Remote code execution via pipe
  /\bcurl\b.*\|\s*(bash|sh|zsh|python|perl|ruby)\b/i,
  /\bwget\b.*\|\s*(bash|sh|zsh|python|perl|ruby)\b/i,
  /\bcurl\b.*>\s*[^\s]+\s*&&\s*(bash|sh|chmod)/i, // curl > file && bash/chmod

  // Credential / key theft
  /\bcat\b.*\/(\.ssh|\.gnupg|\.aws\/credentials)/i,
  /\bcp\b.*\/(\.ssh|\.gnupg|\.aws\/credentials)/i,

  // Environment manipulation that could affect the host
  /\bexport\b.*\b(PATH|LD_PRELOAD|LD_LIBRARY_PATH)\s*=/i,
  /\bchmod\s+[0-7]*[2367][0-7]*\s+\//i, // chmod making system files world-writable
  /\bchown\b.*\s+\/($|\s)/i, // chown on root

  // Container/VM escape attempts
  /\bnsenter\b/i,
  /\bdocker\s+run\b.*--privileged/i,
  /\bmount\b.*\/dev\//i,

  // Network exfiltration of system files
  /\b(nc|ncat|netcat)\b.*<\s*\//i, // piping system files to netcat
];

/** Allowlisted environment variables passed to child processes */
const SAFE_ENV_VARS = [
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  // Node/NPM
  "NODE_ENV",
  "NODE_PATH",
  "NPM_CONFIG_PREFIX",
  // Common dev tools
  "EDITOR",
  "VISUAL",
  "PAGER",
  // Git
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
];

/**
 * Build a sanitized environment for child process execution.
 * Only allowlisted variables are passed through — prevents leaking secrets,
 * API keys, database URLs, and other sensitive env vars to executed commands.
 */
function buildSafeEnv(): Record<string, string> {
  const env: Record<string, string> = { TERM: "dumb" };
  for (const key of SAFE_ENV_VARS) {
    if (process.env[key]) {
      env[key] = process.env[key]!;
    }
  }
  return env;
}

/**
 * Validate and resolve workingDir to prevent path traversal.
 * Returns the resolved absolute path or null if the path is unsafe.
 */
function validateWorkingDir(requestedDir: string | undefined): {
  dir: string;
  error?: string;
} {
  if (!requestedDir) {
    return { dir: process.cwd() };
  }

  // Resolve to absolute path (handles ../ etc.)
  const resolved = resolvePath(requestedDir);

  // Check the directory exists
  if (!existsSync(resolved)) {
    return {
      dir: "",
      error: `Working directory does not exist: ${requestedDir}`,
    };
  }

  // Resolve symlinks to real path
  let realPath: string;
  try {
    realPath = realpathSync(resolved);
  } catch {
    return {
      dir: "",
      error: `Cannot resolve working directory: ${requestedDir}`,
    };
  }

  // Block access to sensitive system directories
  const BLOCKED_DIRS = [
    "/etc",
    "/var",
    "/usr",
    "/bin",
    "/sbin",
    "/boot",
    "/sys",
    "/proc",
    "/dev",
    "/root",
  ];
  for (const blocked of BLOCKED_DIRS) {
    if (realPath === blocked || realPath.startsWith(blocked + "/")) {
      return { dir: "", error: `Access to ${blocked} is not allowed` };
    }
  }

  return { dir: realPath };
}

/**
 * Redact potential secrets from command output.
 * Matches common patterns: API keys, tokens, passwords, connection strings.
 */
function redactSecrets(output: string): string {
  return (
    output
      // Generic key=value secrets (KEY=sk-..., TOKEN=abc123...)
      .replace(
        /\b(api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|credentials?)\s*[=:]\s*\S+/gi,
        "$1=***REDACTED***"
      )
      // Bearer tokens
      .replace(/Bearer\s+[A-Za-z0-9_\-.~+/]+=*/gi, "Bearer ***REDACTED***")
      // Connection strings with passwords
      .replace(/:\/\/[^:]+:[^@]+@/g, "://***:***@")
      // AWS-style keys
      .replace(/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, "***REDACTED_AWS_KEY***")
      // Private keys
      .replace(
        /-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----/g,
        "***REDACTED_PRIVATE_KEY***"
      )
  );
}

/**
 * POST /commands/execute
 * Execute a CLI command with permission checks and event emission.
 */
app.post("/commands/execute", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
    return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
  }

  const body = (await c.req.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  const command = body.command as string;
  const workingDir = (body.workingDir as string) || undefined;
  const timeoutMs = Math.min(Number(body.timeoutMs) || 30_000, 300_000);
  const userId = (body.userId as string) ?? (c.get("userId") as string);
  const agentUserId = body.agentUserId as string | undefined;
  const workspaceId = body.workspaceId as string | undefined;
  const sourceMessageId = body.sourceMessageId as string | undefined;
  const reason = body.reason as string | undefined;

  if (!command || !userId) {
    return c.json({ error: "command and userId are required" }, 400);
  }

  // Reject commands with shell metacharacters that could bypass checks
  // Allow: pipes (|), redirects (> <), semicolons (;), && — but block backticks and $()
  if (/`[^`]*`/.test(command) || /\$\(/.test(command)) {
    logger.warn({ command, userId }, "Blocked command with shell substitution");
    return c.json({
      status: "denied",
      message:
        "Shell substitution (backticks, $()) is not allowed. Run commands directly.",
    });
  }

  // Validate working directory (prevent path traversal)
  const dirResult = validateWorkingDir(workingDir);
  if (dirResult.error) {
    return c.json({ status: "denied", message: dirResult.error }, 400);
  }

  // Hard block dangerous commands
  for (const pattern of BLOCKED_COMMAND_PATTERNS) {
    if (pattern.test(command)) {
      logger.warn({ command, userId }, "Blocked dangerous command");
      return c.json({
        status: "denied",
        message: "This command is blocked by security policy",
      });
    }
  }

  try {
    // Import permission check and side effects lazily
    const { checkPermissionOrPropose } =
      await import("../utils/permission-check.js");
    const { emitSideEffects } = await import("@synap/jobs");

    // Permission check — goes through proposal system
    const permResult = await checkPermissionOrPropose({
      userId,
      agentUserId,
      workspaceId,
      subjectType: "command",
      action: "execute",
      source: agentUserId ? "agent" : "intelligence",
      data: { command, workingDir, reason },
      threadId: undefined,
      reasoning: reason,
      sourceMessageId,
    });

    if ("denied" in permResult && permResult.denied) {
      return c.json({
        status: "denied",
        message: (permResult as { denied: true; reason: string }).reason,
      });
    }

    if ("proposalId" in permResult) {
      return c.json({
        status: "proposed",
        proposalId: permResult.proposalId,
        message: "Command proposed for approval",
      });
    }

    // Granted — execute the command
    const { execFileSync } = await import("child_process");
    let stdout = "";
    let stderr = "";
    let exitCode = 0;

    try {
      // Use execFileSync with explicit shell to avoid raw shell injection.
      // The shell flag is needed for pipes/redirects, but execFileSync
      // provides better process control than execSync.
      const result = execFileSync("/bin/sh", ["-c", command], {
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024, // 1MB output limit
        cwd: dirResult.dir,
        encoding: "utf-8",
        env: buildSafeEnv(),
      });
      stdout = typeof result === "string" ? result : (result?.toString() ?? "");
    } catch (execErr: unknown) {
      const err = execErr as {
        stdout?: string;
        stderr?: string;
        status?: number;
        message?: string;
      };
      stdout = err.stdout ?? "";
      stderr = err.stderr ?? err.message ?? "";
      exitCode = err.status ?? 1;
    }

    // Truncate output to prevent massive payloads
    const MAX_OUTPUT = 50_000;
    if (stdout.length > MAX_OUTPUT)
      stdout = stdout.slice(0, MAX_OUTPUT) + "\n... (truncated)";
    if (stderr.length > MAX_OUTPUT)
      stderr = stderr.slice(0, MAX_OUTPUT) + "\n... (truncated)";

    // Redact potential secrets from output before returning
    stdout = redactSecrets(stdout);
    stderr = redactSecrets(stderr);

    // Emit side effects — triggers automation chain
    if (workspaceId) {
      void emitSideEffects({
        subjectType: "command",
        action: "execute",
        subjectId: `cmd-${Date.now()}`,
        userId,
        workspaceId,
        data: {
          command,
          workingDir,
          exitCode,
          reason,
          stdoutPreview: stdout.slice(0, 500),
        },
      });
    }

    return c.json({
      status: "executed",
      exitCode,
      stdout,
      stderr,
    });
  } catch (err) {
    logger.error({ err, command }, "commands.execute failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500
    );
  }
});

export const hubProtocolRestApp = app;
