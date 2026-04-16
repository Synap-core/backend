/**
 * Hub Protocol REST Adapter (B1)
 *
 * Exposes hub protocol procedures as REST endpoints for the Intelligence Service.
 * Uses API key auth (Bearer). Mount at /api/hub in the app.
 */

import { Hono } from "hono";
import { realpathSync, existsSync, readFileSync } from "fs";
import { resolve as resolvePath } from "path";
import { createLogger, config } from "@synap-core/core";
import { TRPCError } from "@trpc/server";
import { apiKeyService } from "../services/api-keys.js";
import { getBoss } from "@synap/jobs";
import { NotificationService } from "../notifications/NotificationService.js";
import { hubProtocolRouter } from "./hub-protocol/index.js";
import { createHubProtocolCallerContext } from "./hub-protocol/utils.js";
import { captureRouter } from "./capture.js";
import { verifyCpJwt } from "../utils/jwks-client.js";
import type { MessageRole } from "@synap/database/schema";
import { ChannelType, ThreadKind } from "@synap/database/schema";
import type { ProactiveMessageType } from "../services/DeliveryService.js";
import { routeSignal } from "../utils/delivery-router.js";
import { randomUUID } from "crypto";
import jwt from "jsonwebtoken";
import { TrustedIssuerService } from "@synap/database";
import {
  db,
  getDb,
  messages,
  channels,
  knowledgeFacts,
  users,
  eq,
  and,
  or,
  asc,
  desc,
  gte,
  knowledgeRepository,
  drizzleSql,
  traverseEntityGraph,
  intelligenceCommands,
  mcpServers,
  inArray,
  workspaceMembers,
  workspaces,
  entities,
  profiles,
  isNull,
  EventRepository,
  eventRepository,
  ApiKeyRepository,
  WorkspaceRepository,
  createWorkspaceFromDefinition,
  sql,
} from "@synap/database";
import { z } from "zod";
import {
  integrationHubIdFromIssuerUrl,
  revokeActiveHubInboundKeysForUser,
  SETUP_AGENT_HUB_SCOPES,
} from "../services/hub-integration-registration.js";
import { createAndVerifyHubInboundKey } from "../services/external-registration.js";
import { toRegistrationTrace } from "../services/external-registration.js";

const logger = createLogger({ module: "hub-protocol-rest" });

function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function hasScope(scopes: string[], required: string): boolean {
  return scopes.includes(required);
}

const eveProviderIdSchema = z.enum([
  "ollama",
  "openrouter",
  "anthropic",
  "openai",
]);

const eveProviderRoutingPolicySchema = z.object({
  mode: z.enum(["local", "provider", "hybrid"]).optional(),
  defaultProvider: eveProviderIdSchema.optional(),
  fallbackProvider: eveProviderIdSchema.optional(),
  providers: z
    .array(
      z.object({
        id: eveProviderIdSchema,
        enabled: z.boolean().optional(),
        baseUrl: z.string().optional(),
        defaultModel: z.string().optional(),
      })
    )
    .optional(),
  syncToSynap: z.boolean().optional(),
});

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
 * Middleware: authenticate hub protocol requests.
 *
 * Accepts two credential types:
 *   1. `Authorization: Bearer <api-key>` — IS agents, OpenClaw, CLI (API key auth)
 *   2. `X-Session-Token: <kratos-token>` — browser extension, web clients (Kratos session auth)
 *
 * Session-token callers receive full hub-protocol.read + hub-protocol.write scopes.
 * Skip auth for endpoints listed in skipAuthPaths.
 */
app.use("/*", async (c, next) => {
  const reqPath = c.req.path;
  const skipAuthPaths = ["/health", "/entity-share/deliver", "/setup/agent"];
  if (skipAuthPaths.some((p) => reqPath === p || reqPath.endsWith(p))) {
    return next();
  }

  // ── 1. Try API key (agents / IS / OpenClaw) ─────────────────────────────
  const authHeader = c.req.header("authorization") ?? null;
  const token = extractBearerToken(authHeader);

  if (token) {
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
    return next();
  }

  // ── 2. Try Kratos session token (browser extension / web clients) ────────
  const sessionToken = c.req.header("x-session-token");
  if (sessionToken) {
    try {
      const { getSession } = await import("@synap/auth");
      const headers = new Headers({ "x-session-token": sessionToken });
      const session = await getSession(headers);
      if (session?.identity?.id) {
        c.set("userId", session.identity.id as string);
        // Authenticated pod users get full hub-protocol scopes
        c.set("scopes", ["hub-protocol.read", "hub-protocol.write"]);
        return next();
      }
    } catch (err) {
      logger.warn({ err }, "Session token validation failed");
    }
    return c.json({ error: "Invalid or expired session token" }, 401);
  }

  return c.json(
    {
      error:
        "Authentication required. Use Authorization: Bearer <key> or X-Session-Token: <token>",
    },
    401
  );
});

/**
 * GET /users/me — return the authenticated agent/user identity.
 * Used by OpenClaw, CLI, and external agents to verify their API key.
 */
app.get("/users/me", async (c) => {
  const userId = c.get("userId") as string | undefined;
  const scopes = c.get("scopes") as string[] | undefined;
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  return c.json({ id: userId, scopes: scopes ?? [] });
});

/**
 * GET /workspaces — list workspaces accessible to the authenticated user.
 * Used by IS agents and external clients to discover workspace context.
 */
app.get("/workspaces", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
    return c.json(
      { error: "Insufficient scope: hub-protocol.read required" },
      403
    );
  }
  const userId = c.get("userId") as string;
  try {
    const wsIds = await getUserAccessibleWorkspaceIds(userId);
    // Direct DB query — workspaces router is on the app router, not hub-protocol router
    const list =
      wsIds.length > 0
        ? await db
            .select({ id: workspaces.id, name: workspaces.name })
            .from(workspaces)
            .where(inArray(workspaces.id, wsIds))
        : [];
    return c.json({ workspaces: list });
  } catch (err) {
    logger.error({ err }, "GET /workspaces failed");
    return c.json({ error: "Failed to list workspaces" }, 500);
  }
});

/**
 * PATCH /workspaces/:workspaceId/eve-provider-routing
 * Explicitly sync Eve provider routing policy (non-secret) into workspace settings.
 *
 * This endpoint is intentionally separate from Synap intelligence-service routing.
 */
app.patch("/workspaces/:workspaceId/eve-provider-routing", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
    return c.json(
      { error: "Insufficient scope: hub-protocol.write required" },
      403
    );
  }

  const userId = c.get("userId") as string;
  const workspaceId = c.req.param("workspaceId");
  if (!workspaceId) return c.json({ error: "workspaceId is required" }, 400);

  const membership = await db.query.workspaceMembers.findFirst({
    where: and(
      eq(workspaceMembers.workspaceId, workspaceId),
      eq(workspaceMembers.userId, userId)
    ),
    columns: { role: true },
  });
  if (!membership) return c.json({ error: "Access denied" }, 403);
  if (membership.role !== "owner" && membership.role !== "admin") {
    return c.json(
      { error: "Owner/admin role required to sync provider routing" },
      403
    );
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = eveProviderRoutingPolicySchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        error: "Invalid provider routing payload",
        details: parsed.error.issues,
      },
      400
    );
  }

  try {
    const dbConn = await getDb();
    const eventRepo = new EventRepository(sql);
    const workspaceRepo = new WorkspaceRepository(dbConn, eventRepo);

    await workspaceRepo.mergeSettings(
      workspaceId,
      { eveProviderRouting: parsed.data },
      userId
    );

    return c.json({
      ok: true,
      workspaceId,
      eveProviderRouting: parsed.data,
    });
  } catch (err) {
    logger.error(
      { err, userId, workspaceId },
      "PATCH /workspaces/:workspaceId/eve-provider-routing failed"
    );
    return c.json({ error: "Failed to sync provider routing" }, 500);
  }
});

/**
 * GET /workspaces/:workspaceId/eve-provider-routing
 * Read synced Eve provider routing policy from workspace settings.
 */
app.get("/workspaces/:workspaceId/eve-provider-routing", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
    return c.json(
      { error: "Insufficient scope: hub-protocol.read required" },
      403
    );
  }

  const userId = c.get("userId") as string;
  const workspaceId = c.req.param("workspaceId");
  if (!workspaceId) return c.json({ error: "workspaceId is required" }, 400);

  const membership = await db.query.workspaceMembers.findFirst({
    where: and(
      eq(workspaceMembers.workspaceId, workspaceId),
      eq(workspaceMembers.userId, userId)
    ),
    columns: { role: true },
  });
  if (!membership) return c.json({ error: "Access denied" }, 403);

  try {
    const workspace = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
      columns: { settings: true },
    });
    if (!workspace) return c.json({ error: "Workspace not found" }, 404);
    const settings = (workspace.settings ?? {}) as Record<string, unknown>;
    return c.json({
      ok: true,
      workspaceId,
      eveProviderRouting:
        (settings.eveProviderRouting as Record<string, unknown> | undefined) ??
        null,
    });
  } catch (err) {
    logger.error(
      { err, userId, workspaceId },
      "GET /workspaces/:workspaceId/eve-provider-routing failed"
    );
    return c.json({ error: "Failed to read provider routing" }, 500);
  }
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

// ─── Workspace access helpers ─────────────────────────────────────────────────
// On shared pods (multiple users, each with their own workspace), these helpers
// enforce that read queries only return data from workspaces the user has access
// to. Write routes already go through workspaceProcedure which validates membership.
// User-scoped resources (memory, sessions, personal channels) are intentionally
// NOT workspace-gated — they belong to the user across all their workspaces.

/**
 * Get all workspace IDs a user is a member of.
 */
async function getUserAccessibleWorkspaceIds(
  userId: string
): Promise<string[]> {
  const rows = await db
    .select({ workspaceId: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId));
  return rows.map((r) => r.workspaceId);
}

/**
 * Verify a user has access to a specific workspace.
 */
async function verifyWorkspaceAccess(
  userId: string,
  workspaceId: string
): Promise<boolean> {
  const row = await db.query.workspaceMembers.findFirst({
    where: and(
      eq(workspaceMembers.workspaceId, workspaceId),
      eq(workspaceMembers.userId, userId)
    ),
    columns: { id: true },
  });
  return !!row;
}

/**
 * Typed caller — the return type of createCaller is fully inferred from
 * the hub protocol router definition. This single type alias eliminates
 * the need for `caller.sub.procedure()` throughout the file.
 */
type HubProtocolCaller = ReturnType<typeof hubProtocolRouter.createCaller>;

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
): Promise<HubProtocolCaller> {
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
  // Bridge cast: hub-protocol context extends tRPC's base context with extra
  // fields (scopes, apiKeyId, source). This is the ONLY `as any` needed —
  // all downstream caller usage inherits proper types from HubProtocolCaller.
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
    // Scope to user's accessible workspaces + pod-wide channels.
    // When workspaceId is explicit, return that workspace + pod-wide.
    // When omitted, return ALL accessible workspaces + pod-wide.
    let whereClause;
    // Pod-wide channels: personal thread + proactive feed.
    const podWideFilter = or(
      and(
        eq(channels.channelType, ChannelType.THREAD),
        eq(channels.threadKind, ThreadKind.PERSONAL)
      ),
      eq(channels.channelType, ChannelType.FEED)
    );

    if (workspaceId) {
      whereClause = and(
        eq(channels.userId, userId),
        or(eq(channels.workspaceId, workspaceId), podWideFilter)
      );
    } else {
      const accessibleWsIds = await getUserAccessibleWorkspaceIds(userId);
      whereClause = and(
        eq(channels.userId, userId),
        or(
          ...(accessibleWsIds.length > 0
            ? [inArray(channels.workspaceId, accessibleWsIds)]
            : []),
          podWideFilter
        )
      );
    }
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
 * GET /events
 * Query the event log for IS agents (query_recent_events tool).
 * Supports: userId, workspaceId, type, subjectType, subjectId, fromDate, limit.
 */
app.get("/events", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
    return c.json(
      { error: "Insufficient scope: hub-protocol.read required" },
      403
    );
  }
  const userId = c.req.query("userId");
  const type = c.req.query("type");
  const subjectType = c.req.query("subjectType");
  const subjectId = c.req.query("subjectId");
  const fromDateStr = c.req.query("fromDate");
  const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10), 200);

  if (!userId) return c.json({ error: "userId is required" }, 400);

  try {
    const events = await eventRepository.searchEvents({
      userId,
      eventType: type,
      subjectType: subjectType as any,
      subjectId,
      fromDate: fromDateStr
        ? new Date(fromDateStr)
        : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      limit,
    });
    return c.json({ events });
  } catch (err) {
    logger.error({ err, userId }, "listEvents failed");
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
    const result = await caller.context.getThreadContext({ threadId });
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
      await caller.context.updateThreadContext({
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
    const result = await caller.context.getUserContext({ userId });
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
  const profileSlug =
    c.req.query("profileSlug") || c.req.query("type") || undefined;
  const limit = c.req.query("limit");
  const workspaceId = c.req.query("workspaceId") || null;
  try {
    // When no workspaceId is specified, query across all accessible workspaces.
    // The tRPC caller still needs at least one workspaceId for context.
    const effectiveWsIds = workspaceId
      ? [workspaceId]
      : await getUserAccessibleWorkspaceIds(userId);
    if (effectiveWsIds.length === 0) return c.json([]);

    // Use the first accessible workspace for caller context
    const caller = await getCaller(c, {
      workspaceId: effectiveWsIds[0],
      userId,
    });
    const result = await caller.entities.getEntities({
      userId,
      workspaceId: workspaceId || undefined,
      profileSlug: profileSlug || undefined,
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
 * GET /entities?q=...&profileSlug=...&workspaceId=...&limit=...&sort=...
 *
 * Canonical list/search endpoint for @synap/hub-rest-client (Raycast, CLI, etc.).
 * When `q` is empty, lists entities (optionally filtered by profileSlug).
 * When `q` is non-empty, runs unified Typesense search on the entities collection.
 *
 * Must be registered before GET /entities/:id so `/entities` is not captured as an id.
 */
app.get("/entities", async (c) => {
  if (!hasScope(c.get("scopes"), "hub-protocol.read")) {
    return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
  }

  // User-bound Hub keys (Raycast, CLI): never honor ?userId= — prevents IDOR where a
  // caller replays another user's id. Intelligence Service should use GET /users/:userId/entities.
  const userId = c.get("userId") as string;
  if (!userId) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const q = (c.req.query("q") ?? "").trim();
  const profileSlug = c.req.query("profileSlug") || undefined;
  const workspaceIdParam = c.req.query("workspaceId") || null;
  const limitRaw = c.req.query("limit");
  const limit = Math.min(
    Math.max(parseInt(limitRaw ?? "20", 10) || 20, 1),
    100
  );
  const sortParam = (c.req.query("sort") ?? "").trim();

  try {
    const effectiveWsIds = workspaceIdParam
      ? [workspaceIdParam]
      : await getUserAccessibleWorkspaceIds(userId);
    if (effectiveWsIds.length === 0) {
      return c.json([]);
    }

    if (workspaceIdParam) {
      const ok = await verifyWorkspaceAccess(userId, workspaceIdParam);
      if (!ok) {
        return c.json({ error: "Access denied to workspace" }, 403);
      }
    }

    const workspaceId = workspaceIdParam ?? effectiveWsIds[0];

    const caller = await getCaller(c, {
      workspaceId,
      userId,
    });

    const normalizeHubEntity = (e: unknown): unknown => {
      if (!e || typeof e !== "object") return e;
      const row = e as Record<string, unknown>;
      const slug =
        (typeof row.profileSlug === "string" && row.profileSlug) ||
        (typeof row.type === "string" && row.type) ||
        (typeof row.entityType === "string" && row.entityType) ||
        "note";
      return { ...row, profileSlug: slug };
    };

    if (q.length > 0) {
      const searchResp = await caller.search.search({
        userId,
        query: q,
        workspaceId,
        collections: ["entities"],
        limit,
        page: 1,
      });

      let docs = searchResp.results
        .filter((r) => r.collection === "entities")
        .map((r) => r.document as Record<string, unknown>);

      if (profileSlug) {
        docs = docs.filter(
          (d) =>
            (d.entityType as string | undefined) === profileSlug ||
            (d.type as string | undefined) === profileSlug
        );
      }

      return c.json(docs.map((d) => normalizeHubEntity(d)));
    }

    const listed = await caller.entities.getEntities({
      userId,
      workspaceId: workspaceIdParam || undefined,
      profileSlug: profileSlug || undefined,
      limit,
    });

    let rows = (listed as unknown[]).map((e) => normalizeHubEntity(e)) as Array<
      Record<string, unknown>
    >;

    // @synap/hub-rest-client getRecentEntities sends sort=updatedAt:desc (list defaults to createdAt).
    if (
      sortParam.includes("updatedAt") &&
      sortParam.toLowerCase().includes("desc")
    ) {
      rows = [...rows].sort((a, b) => {
        const tb = new Date(String(b.updatedAt ?? 0)).getTime();
        const ta = new Date(String(a.updatedAt ?? 0)).getTime();
        return tb - ta;
      });
    }

    return c.json(rows);
  } catch (err) {
    logger.error({ err, userId }, "GET /entities failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500
    );
  }
});

/**
 * GET /entities/:id?workspaceId=...&userId=...
 * Fetch a single entity by ID. Used by skill trigger executor to get entity context.
 * On shared pods, verifies the entity belongs to a workspace the user can access.
 */
app.get("/entities/:id", async (c) => {
  if (!hasScope(c.get("scopes"), "hub-protocol.read")) {
    return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
  }
  const entityId = c.req.param("id");
  // Use explicit userId from query, or fall back to API key's userId
  const userId = c.req.query("userId") || (c.get("userId") as string);
  try {
    // Direct DB query — no tRPC procedure exists for single-entity get in hub protocol
    const result = await db.query.entities.findFirst({
      where: and(eq(entities.id, entityId), isNull(entities.deletedAt)),
    });
    if (!result) return c.json(null, 404);
    // Verify the entity's workspace is accessible to the requesting user.
    if (result.workspaceId) {
      const hasAccess = await verifyWorkspaceAccess(userId, result.workspaceId);
      if (!hasAccess) {
        return c.json({ error: "Access denied to entity's workspace" }, 403);
      }
    }
    return c.json(result);
  } catch (err) {
    logger.error({ err, entityId }, "entities.get failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Internal error" },
      500
    );
  }
});

/**
 * POST /entities
 *
 * Creates an entity on behalf of a user. Auth via API key or session token.
 *
 * `userId` is optional when authenticating via session token — falls back to the
 * authenticated user. For API-key callers (IS/OpenClaw) `userId` must be provided.
 *
 * `workspaceId` is optional:
 *   - Pod-wide profiles (entityScope='pod'): workspace always null, no resolution needed.
 *   - Workspace-scoped profiles: falls back to the user's first accessible workspace.
 */
app.post("/entities", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
    return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
  }

  const body = (await c.req.json()) as {
    userId?: string; // Optional when using session token auth
    agentUserId?: string;
    workspaceId?: string;
    type?: string;
    profileSlug?: string;
    title: string;
    description?: string;
    properties?: Record<string, unknown>;
    source?: string;
    sourceMessageId?: string;
  };

  // userId: explicit body value takes precedence (IS/OpenClaw flow);
  // falls back to session-authenticated user (extension flow).
  const authUserId = c.get("userId") as string;
  const userId = body.userId ?? authUserId;
  if (!userId) {
    return c.json({ error: "userId required" }, 400);
  }

  const profileSlug = body.profileSlug ?? body.type ?? "bookmark";

  // ── Resolve workspace context ────────────────────────────────────────────
  // Explicit workspaceId always wins. When omitted, check the profile's entityScope:
  //   entityScope='pod'       → workspaceId=null (pod-wide entity, no workspace needed)
  //   entityScope='workspace' → fall back to user's first accessible workspace
  let effectiveWorkspaceId: string | null;

  if (body.workspaceId) {
    effectiveWorkspaceId = body.workspaceId;
  } else {
    // Look up the profile's entityScope
    const profile = await db.query.profiles.findFirst({
      where: eq(profiles.slug, profileSlug),
      columns: { entityScope: true },
    });

    if (!profile || profile.entityScope === "pod") {
      // Pod-wide profile (or unknown profile — default to pod-wide for safety)
      effectiveWorkspaceId = null;
    } else {
      // Workspace-scoped: resolve user's first accessible workspace
      const wsIds = await getUserAccessibleWorkspaceIds(userId);
      effectiveWorkspaceId = wsIds[0] ?? null;
      if (!effectiveWorkspaceId) {
        return c.json(
          { error: "No accessible workspace found for this user" },
          400
        );
      }
    }
  }

  try {
    const actorResolution = await resolveActorId(body.agentUserId, userId);
    if ("error" in actorResolution)
      return c.json({ error: actorResolution.error }, 400);
    const actorId = actorResolution.actorId;

    const caller = await getCaller(c, {
      workspaceId: effectiveWorkspaceId,
      userId: actorId,
      sourceMessageId: body.sourceMessageId,
    });
    const result = await caller.entities.createEntity({
      userId,
      ...(body.agentUserId ? { agentUserId: body.agentUserId } : {}),
      profileSlug,
      title: body.title,
      description: body.description,
      properties: body.properties,
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
 * POST /capture/cluster-tabs
 *
 * AI-powered tab clustering. Proxies the request to the Intelligence Service
 * `/api/tools/cluster-tabs` and returns semantically grouped tab clusters.
 *
 * Falls back with 503 if the IS is unavailable — the extension uses local
 * domain-based clustering as its fallback.
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
    // Send url + title only to IS (LLM doesn't need tabId/windowId/favIconUrl)
    const simplifiedTabs = body.tabs.map(({ url, title }) => ({ url, title }));

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

    // Map simple {url, title} tabs back to full tab objects using the original input
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
 *
 * Multi-entity extraction + dedup search (AI pipeline step 1).
 * Mirrors capture.structure tRPC procedure for external clients
 * (Raycast, browser extension) that cannot reach tRPC directly.
 *
 * Requires: hub-protocol.read OR mcp.read scope
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

  // Resolve workspaceId — capture.structure uses workspaceProcedure (non-null required)
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
 *
 * Batch-create entities and relations from confirmed proposals (AI pipeline step 2).
 * Mirrors capture.execute tRPC procedure for external clients
 * (Raycast, browser extension) that cannot reach tRPC directly.
 *
 * Requires: hub-protocol.write OR mcp.write scope
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

  // Resolve workspaceId — capture.execute uses workspaceProcedure (non-null required)
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
    workspaceId?: string | null;
    title?: string;
    preview?: string;
    metadata?: Record<string, unknown>;
    sourceMessageId?: string;
  };
  try {
    const actorResolution = await resolveActorId(body.agentUserId, body.userId);
    if ("error" in actorResolution)
      return c.json({ error: actorResolution.error }, 400);
    const actorId = actorResolution.actorId;
    const caller = await getCaller(c, {
      workspaceId: body.workspaceId ?? null,
      userId: actorId,
      sourceMessageId: body.sourceMessageId,
    });
    const result = await caller.entities.updateEntity({
      entityId,
      userId: body.userId,
      ...(body.agentUserId ? { agentUserId: body.agentUserId } : {}),
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
    const result = await caller.search.searchCollection({
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
    const effectiveWsId = workspaceId || undefined;
    const caller = await getCaller(c, { workspaceId: effectiveWsId ?? null });
    const result = await caller.search.search({
      userId,
      query,
      workspaceId: effectiveWsId,
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
    const result = await caller.search.searchDocuments({
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
  const workspaceId = c.req.query("workspaceId");
  if (!userId || !query) {
    return c.json({ error: "userId and query are required" }, 400);
  }
  try {
    const effectiveWsId = workspaceId || undefined;
    const caller = await getCaller(c, { workspaceId: effectiveWsId || null });
    const result = await caller.search.vectorSearch({
      userId,
      query,
      types: types ? types.split(",") : undefined,
      limit: limit ? parseInt(limit, 10) : 10,
      workspaceId: effectiveWsId,
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
    workspaceId?: string | null;
    title: string;
    content?: string;
    type?: "text" | "markdown" | "code" | "pdf" | "docx";
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
    // Set workspace context for the caller using user's first accessible workspace
    const effectiveWsId =
      (await getUserAccessibleWorkspaceIds(userId))[0] || undefined;
    const caller = await getCaller(c, { workspaceId: effectiveWsId, userId });
    const result = await caller.documents.getDocument({
      documentId,
      userId,
    });
    // Verify document belongs to an accessible workspace
    const docWsId = (result as Record<string, unknown> | null)?.workspaceId as
      | string
      | undefined;
    if (docWsId) {
      const hasAccess = await verifyWorkspaceAccess(userId, docWsId);
      if (!hasAccess) {
        return c.json({ error: "Access denied to document's workspace" }, 403);
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
    // Scope to user's accessible workspaces when no explicit workspaceId
    const effectiveWsId =
      workspaceId ||
      (await getUserAccessibleWorkspaceIds(userId))[0] ||
      undefined;
    const caller = await getCaller(c, { workspaceId: effectiveWsId });
    const result = await caller.proposals.listProposals({
      userId,
      workspaceId: effectiveWsId,
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
    const result = await caller.proposals.updateProposal({
      proposalId,
      data: body.data,
      summary: body.summary,
    });
    return c.json(result);
  } catch (err) {
    logger.error({ err, proposalId }, "updateProposal failed");
    const code =
      err instanceof TRPCError && err.code === "NOT_FOUND"
        ? 404
        : err instanceof TRPCError && err.code === "BAD_REQUEST"
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
    const result = await caller.skills.getSkills({
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
    const result = await caller.skills.getSkill({ userId, skillId });
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
    const result = await caller.skills.createSkill(body);
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
    const result = await caller.linking.linkEntity({
      userId: body.userId,
      ...(body.agentUserId ? { agentUserId: body.agentUserId } : {}),
      threadId,
      entityId: body.entityId,
      relationshipType: (body.relationshipType ?? "referenced") as
        | "created"
        | "updated"
        | "used_as_context"
        | "referenced"
        | "inherited_from_parent",
      sourceMessageId: body.sourceMessageId,
    });
    return c.json(result);
  } catch (err) {
    logger.error({ err, threadId }, "linkEntity failed");
    const code =
      err instanceof TRPCError && err.code === "NOT_FOUND" ? 404 : 500;
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
    const result = await caller.linking.linkDocument({
      userId: body.userId,
      ...(body.agentUserId ? { agentUserId: body.agentUserId } : {}),
      threadId,
      documentId: body.documentId,
      relationshipType: (body.relationshipType ?? "referenced") as
        | "created"
        | "updated"
        | "used_as_context"
        | "referenced"
        | "inherited_from_parent",
      sourceMessageId: body.sourceMessageId,
    });
    return c.json(result);
  } catch (err) {
    logger.error({ err, threadId }, "linkDocument failed");
    const code =
      err instanceof TRPCError && err.code === "NOT_FOUND" ? 404 : 500;
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
    contextObjectType?: string;
    contextObjectId?: string;
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
        contextObjectType: body.contextObjectType ?? null,
        contextObjectId: body.contextObjectId ?? null,
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
 * autoRespond=true: queues an IS response trigger for AI-active THREAD and AGENT_COLLAB channels.
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
      role: body.role as MessageRole,
      content: body.content,
      userId: body.userId,
      hash,
      ...(body.metadata ? { metadata: body.metadata } : {}),
    });

    // autoRespond: trigger IS to respond when an external agent posts a user-role message
    // to an AI channel (thread or agent_collab). Enables async inter-agent messaging.
    if (body.autoRespond === true && body.role === "user") {
      const channel = await db.query.channels.findFirst({
        where: eq(channels.id, threadId),
      });
      if (
        channel?.workspaceId &&
        (channel.channelType === ChannelType.THREAD ||
          channel.channelType === ChannelType.AGENT_COLLAB)
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
    embedding?: number[];
    sourceEntityId?: string;
    sourceMessageId?: string;
  };
  if (!body.userId || !body.fact) {
    return c.json({ error: "userId and fact are required" }, 400);
  }
  try {
    // Embedding is optional — if not provided, use a zero vector.
    // Keyword search (GET /memory) still works; semantic search ranks these low.
    const embedding = Array.isArray(body.embedding)
      ? body.embedding
      : new Array(1536).fill(0);
    const record = await knowledgeRepository.saveFact({
      userId: body.userId,
      fact: body.fact,
      confidence: body.confidence ?? 0.8,
      embedding,
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
  const authUserId = c.get("userId") as string;
  const userId = c.req.query("userId") || authUserId;
  if (!userId) {
    return c.json({ error: "userId is required" }, 400);
  }
  // Accept `q` (hub-rest-client) or `query` (IS / docs).
  const query = c.req.query("query") ?? c.req.query("q") ?? "";
  const limit = parseInt(c.req.query("limit") ?? "10", 10);
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
    // Scope traversal to user's accessible workspaces (shared-pod safety).
    // If user has no workspaces, return empty (no unscoped traversal).
    const accessibleWsIds = await getUserAccessibleWorkspaceIds(userId);
    if (accessibleWsIds.length === 0) return c.json([]);
    const results = await traverseEntityGraph({
      userId,
      startEntityId,
      maxDepth: Math.min(maxDepth, 3),
      relationshipTypes,
      workspaceIds: accessibleWsIds,
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
  const userId = c.get("userId") as string;
  try {
    let whereClause;
    if (workspaceId) {
      whereClause = eq(intelligenceCommands.workspaceId, workspaceId);
    } else {
      const wsIds = await getUserAccessibleWorkspaceIds(userId);
      if (wsIds.length === 0) {
        return c.json([]);
      }
      whereClause = inArray(intelligenceCommands.workspaceId, wsIds);
    }
    const commands = await db.query.intelligenceCommands.findMany({
      where: whereClause,
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
  const userId = c.get("userId") as string;
  try {
    const { users, workspaceMembers } = await import("@synap/database/schema");
    const accessibleWsIds = workspaceId
      ? [workspaceId]
      : await getUserAccessibleWorkspaceIds(userId);
    if (accessibleWsIds.length === 0) return c.json([]);
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
          inArray(workspaceMembers.workspaceId, accessibleWsIds)
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
  if (!userId) {
    return c.json({ error: "userId is required" }, 400);
  }
  try {
    const caller = await getCaller(c, {
      userId,
      workspaceId: workspaceId ?? null,
    });
    const result = await caller.views.listViews({
      userId,
      workspaceId: workspaceId ?? null,
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
    workspaceId?: string | null;
    name: string;
    type: string;
    profileId?: string;
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
      workspaceId: body.workspaceId ?? null,
      sourceMessageId: body.sourceMessageId,
    });
    const result = await caller.views.createView({
      userId: body.userId,
      workspaceId: body.workspaceId ?? null,
      name: body.name,
      type: body.type,
      profileId: body.profileId,
      config: body.config,
      metadata: body.metadata,
      ...(body.agentUserId ? { agentUserId: body.agentUserId } : {}),
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
    const result = await caller.views.updateView({
      userId: body.userId,
      viewId,
      workspaceId: body.workspaceId,
      name: body.name,
      config: body.config,
      metadata: body.metadata,
      ...(body.agentUserId ? { agentUserId: body.agentUserId } : {}),
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
    const result = await caller.views.arrangeBento({
      userId: body.userId,
      workspaceId: body.workspaceId,
      viewId,
      widgets: body.widgets,
      ...(body.agentUserId ? { agentUserId: body.agentUserId } : {}),
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
    const result = await caller.profiles.listProfiles({
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
    const result = await caller.profiles.createProfile({
      userId: body.userId,
      workspaceId: body.workspaceId,
      slug: body.slug,
      displayName: body.displayName,
      description: body.description,
      defaultValues: body.defaultValues,
      parentProfileId: body.parentProfileId,
      uiHints: body.uiHints,
      reasoning: body.reasoning,
      ...(body.agentUserId ? { agentUserId: body.agentUserId } : {}),
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
    const result = await caller.profiles.listPropertyDefs({
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
    /**
     * When true, create a workspace-scoped overlay def (invisible to other
     * workspaces using the same profile). Default false = base def.
     */
    overlay?: boolean;
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
    const result = await caller.profiles.createPropertyDef({
      userId: body.userId,
      profileId: body.profileId,
      slug: body.slug,
      valueType: body.valueType,
      constraints: body.constraints,
      uiHints: body.uiHints,
      ...(body.agentUserId ? { agentUserId: body.agentUserId } : {}),
      ...(body.overlay ? { overlay: true, workspaceId: body.workspaceId } : {}),
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
    const result = await caller.relations.listRelations({
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
    const result = await caller.relations.createRelation({
      userId: body.userId,
      workspaceId: body.workspaceId,
      sourceEntityId: body.sourceEntityId,
      targetEntityId: body.targetEntityId,
      type: body.type,
      metadata: body.metadata,
      ...(body.agentUserId ? { agentUserId: body.agentUserId } : {}),
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
    const result = await caller.sessions.getOrCreate({
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
    const result = await caller.sessions.getActive({ channelId });
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
    const result = await caller.sessions.get({ sessionId });
    return c.json(result);
  } catch (err) {
    logger.error({ err, sessionId }, "sessions.get failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      err instanceof TRPCError && err.code === "NOT_FOUND" ? 404 : 500
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
    const result = await caller.sessions.list({ channelId, limit });
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
    const result = await caller.sessions.update({
      sessionId,
      ...body,
    });
    return c.json(result);
  } catch (err) {
    logger.error({ err, sessionId }, "sessions.update failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      err instanceof TRPCError && err.code === "NOT_FOUND" ? 404 : 500
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
    const result = await caller.sessions.close({
      sessionId,
      producedStateId: body.producedStateId,
    });
    return c.json(result);
  } catch (err) {
    logger.error({ err, sessionId }, "sessions.close failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      err instanceof TRPCError && err.code === "NOT_FOUND" ? 404 : 500
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
    const result = await caller.compactedStates.create(
      body as Parameters<typeof caller.compactedStates.create>[0]
    );
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
    const result = await caller.compactedStates.getLatest({
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
    const result = await caller.compactedStates.get({ stateId });
    return c.json(result);
  } catch (err) {
    logger.error({ err, stateId }, "compactedStates.get failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      err instanceof TRPCError && err.code === "NOT_FOUND" ? 404 : 500
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
    const result = await caller.compactedStates.list({
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
    const result = await caller.relations.deleteRelation({
      userId,
      workspaceId: body.workspaceId,
      relationId,
      ...(body.agentUserId ? { agentUserId: body.agentUserId } : {}),
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
  try {
    const caller = await getCaller(c, { workspaceId: workspaceId ?? null });
    const result = await caller.widgetDefinitions.listWidgetDefs({
      workspaceId: workspaceId ?? null,
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
  try {
    const rows = await db.query.mcpServers.findMany({
      where: and(
        workspaceId
          ? or(
              eq(mcpServers.workspaceId, workspaceId),
              isNull(mcpServers.workspaceId)
            )
          : isNull(mcpServers.workspaceId),
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
  const workspaceId = (body.workspaceId as string | null | undefined) ?? null;
  try {
    const caller = await getCaller(c, {
      userId,
      workspaceId,
      sourceMessageId: (body.sourceMessageId as string) ?? null,
    });
    const result = await caller.widgetDefinitions.upsertWidgetDef({
      ...body,
      userId,
    } as Parameters<typeof caller.widgetDefinitions.upsertWidgetDef>[0]);
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
  const workspaceId = (body.workspaceId as string | null | undefined) ?? null;
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
    const result = await caller.automations.createAutomation({
      userId,
      agentUserId: body.agentUserId as string | undefined,
      workspaceId,
      sourceMessageId: body.sourceMessageId as string | undefined,
      name: body.name as string,
      description: body.description as string | undefined,
      triggerType: body.triggerType as "event" | "cron" | "webhook" | "manual",
      triggerConfig: (body.triggerConfig as Record<string, unknown>) ?? {},
      flowDefinition: body.flowDefinition as {
        nodes: Record<string, unknown>[];
        edges: Record<string, unknown>[];
      },
      status: ((body.status as string) ?? "draft") as
        | "draft"
        | "active"
        | "paused"
        | "error",
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

  try {
    const caller = await getCaller(c, {
      userId,
      workspaceId: workspaceId ?? null,
    });
    const result = await caller.automations.listAutomations({
      userId,
      workspaceId: workspaceId ?? null,
      status: (c.req.query("status") || undefined) as
        | "draft"
        | "active"
        | "paused"
        | "error"
        | undefined,
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

  try {
    const caller = await getCaller(c, {
      userId,
      workspaceId: workspaceId ?? null,
    });
    const result = await caller.automations.getAutomation({
      userId,
      workspaceId: workspaceId ?? null,
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
  const workspaceId = (body.workspaceId as string | null | undefined) ?? null;
  if (!userId) {
    return c.json({ error: "userId is required" }, 400);
  }

  try {
    const caller = await getCaller(c, { userId, workspaceId });
    const result = await caller.automations.triggerAutomation({
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
    const result = await caller.automations.updateAutomation({
      userId,
      workspaceId,
      id: c.req.param("automationId"),
      name: body.name as string | undefined,
      description: body.description as string | undefined,
      triggerType: body.triggerType as
        | "event"
        | "cron"
        | "webhook"
        | "manual"
        | undefined,
      triggerConfig: body.triggerConfig as Record<string, unknown> | undefined,
      flowDefinition: body.flowDefinition as
        | { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] }
        | undefined,
      status: body.status as
        | "draft"
        | "active"
        | "paused"
        | "error"
        | undefined,
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
    const result = await caller.automations.activateAutomation({
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
    const result = await caller.automations.pauseAutomation({
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

// ── Rate limiter for terminal commands ─────────────────────────────────────
const _commandRateLimiter = new Map<
  string,
  { count: number; resetAt: number }
>();

function checkCommandRateLimit(workspaceId: string): boolean {
  const now = Date.now();
  const key = `cmd:${workspaceId}`;
  const entry = _commandRateLimiter.get(key);

  if (!entry || entry.resetAt < now) {
    _commandRateLimiter.set(key, { count: 1, resetAt: now + 60_000 });
    return true; // allowed
  }

  if (entry.count >= 10) {
    return false; // rate limited
  }

  entry.count++;
  return true;
}

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

  // Rate limit: 10 commands per workspace per minute
  const workspaceId = body.workspaceId as string | undefined;
  if (workspaceId && !checkCommandRateLimit(workspaceId)) {
    return c.json(
      {
        error:
          "Rate limit exceeded: maximum 10 commands per minute per workspace",
        retryAfter: 60,
      },
      429
    );
  }

  const command = body.command as string;
  const workingDir = (body.workingDir as string) || undefined;
  const timeoutMs = Math.min(Number(body.timeoutMs) || 30_000, 300_000);
  const userId = (body.userId as string) ?? (c.get("userId") as string);
  const agentUserId = body.agentUserId as string | undefined;
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
      stdout = String(result ?? "");
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

// =============================================================================
// Vault (secret request)
// =============================================================================

/**
 * POST /vault/request
 * AI requests access to a vault secret — creates a proposal for user approval.
 * Body: { workspaceId?, agentUserId?, channelId?, secretType, service, purpose, accessLevel, ttl }
 */
app.post("/vault/request", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
    return c.json(
      { error: "Insufficient scope: hub-protocol.write required" },
      403
    );
  }
  const body = (await c.req.json()) as {
    workspaceId?: string;
    agentUserId?: string;
    channelId?: string;
    sourceMessageId?: string;
    secretType: string;
    service: string;
    purpose: string;
    accessLevel?: string;
    ttl?: number;
  };

  if (!body.secretType || !body.service || !body.purpose) {
    return c.json(
      { error: "secretType, service, and purpose are required" },
      400
    );
  }

  const userId = (body.agentUserId as string) ?? (c.get("userId") as string);
  const workspaceId =
    (body.workspaceId as string | null | undefined) ??
    c.req.header("x-workspace-id") ??
    null;

  const accessLevel = body.accessLevel ?? "read";
  const ttl = body.ttl ?? 60;

  try {
    const { proposals, ProposalStatus } =
      await import("@synap/database/schema");
    const { randomUUID } = await import("crypto");
    const id = randomUUID();
    const [row] = await db
      .insert(proposals)
      .values({
        id,
        workspaceId,
        targetType: "vault",
        targetId: `${body.service}:${body.secretType}`,
        proposalType: "vault.request",
        data: {
          secretType: body.secretType,
          service: body.service,
          purpose: body.purpose,
          accessLevel,
          ttl,
          requestedBy: "ai",
          _summary: `AI requests ${body.secretType} for ${body.service}: ${body.purpose}`,
        },
        status: ProposalStatus.PENDING,
        agentUserId: userId ?? null,
        threadId: body.channelId ?? null,
        sourceMessageId: body.sourceMessageId ?? null,
        createdBy: userId ?? null,
      })
      .returning({ id: proposals.id });

    // Emit urgent notification — shows as banner (not toast) in the UI
    NotificationService.create({
      workspaceId: workspaceId ?? null,
      userId,
      type: "ai_request.vault_access",
      sourceType: "proposal",
      sourceId: row.id,
      data: {
        secretType: body.secretType,
        service: body.service,
        purpose: body.purpose,
        proposalId: row.id,
      },
    }).catch(() => {});

    return c.json({
      status: "pending",
      proposalId: row.id,
      message: `Vault secret request created. Awaiting user approval.`,
    });
  } catch (err) {
    logger.error({ err, workspaceId }, "vault.request failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500
    );
  }
});

/**
 * POST /channels/by-context
 * Find or create a channel scoped to a specific entity (contextObjectId + contextObjectType).
 * Used by route_to_channel tool to resolve the target channel for entity-scoped routing.
 * Body: { userId, workspaceId?, contextObjectId, contextObjectType }
 */
app.post("/channels/by-context", async (c) => {
  if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
    return c.json(
      { error: "Insufficient scope: hub-protocol.write required" },
      403
    );
  }
  const body = (await c.req.json()) as {
    userId: string;
    workspaceId?: string;
    contextObjectId: string;
    contextObjectType: "entity" | "document" | "view";
  };
  if (!body.userId || !body.contextObjectId || !body.contextObjectType) {
    return c.json(
      { error: "userId, contextObjectId, and contextObjectType are required" },
      400
    );
  }
  try {
    const caller = await getCaller(c, {
      workspaceId: body.workspaceId,
      userId: body.userId,
    });
    const result = await caller.channels.resolveAiChannel({
      userId: body.userId,
      workspaceId: body.workspaceId,
      family: "context",
      contextObjectId: body.contextObjectId,
      contextObjectType: body.contextObjectType,
    });
    return c.json({
      channelId: result.channel.id,
      title: result.channel.title,
      created: true,
      channel: result.channel,
    });
  } catch (err) {
    logger.error({ err, body }, "channels/by-context failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500
    );
  }
});

/**
 * GET /channels/personal?userId=...&workspaceId=...
 * Get or create the user's personal AI thread.
 * Used by skill triggers to resolve a channelId before posting.
 */
app.get("/channels/personal", async (c) => {
  if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
    return c.json(
      { error: "Insufficient scope: hub-protocol.write required" },
      403
    );
  }
  const userId = c.req.query("userId");
  const workspaceId = c.req.query("workspaceId");
  if (!userId || !workspaceId) {
    return c.json({ error: "userId and workspaceId are required" }, 400);
  }
  try {
    const caller = await getCaller(c, { workspaceId, userId });
    const result = await caller.channels.resolveAiChannel({
      userId,
      workspaceId,
      family: "personal",
    });
    return c.json(result?.channel);
  } catch (err) {
    logger.error(
      { err, userId, workspaceId },
      "channels.ensurePersonal failed"
    );
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      500
    );
  }
});

/**
 * GET /terminal/logs?service=...&lines=...&since=...&filter=...
 * Read pod service logs. Auto-approved (read-only).
 * Allowed services: api, intelligence, realtime, postgres, typesense
 */
app.get("/terminal/logs", async (c) => {
  if (!hasScope(c.get("scopes"), "hub-protocol.read")) {
    return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
  }

  const service = c.req.query("service") ?? "";
  const lines = Math.min(parseInt(c.req.query("lines") ?? "50", 10), 500);
  const since = c.req.query("since"); // e.g. "1h", "30m"
  const filter = c.req.query("filter"); // grep pattern

  // Allowlist of services AI can read logs from
  const ALLOWED_SERVICES: Record<string, string> = {
    api: "synap-api",
    intelligence: "synap-intelligence",
    realtime: "synap-realtime",
    postgres: "synap-postgres",
    typesense: "synap-typesense",
  };

  if (!service || !ALLOWED_SERVICES[service]) {
    return c.json(
      {
        error: `Unknown service "${service}". Allowed: ${Object.keys(ALLOWED_SERVICES).join(", ")}`,
      },
      400
    );
  }

  const containerName = ALLOWED_SERVICES[service];

  try {
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);

    // Build docker logs command
    let cmd = `docker logs --tail=${lines}`;
    if (since) cmd += ` --since=${since}`;
    cmd += ` ${containerName} 2>&1`;
    if (filter) cmd += ` | grep -i ${JSON.stringify(filter)}`;

    let output: string;
    try {
      const { stdout } = await execAsync(cmd, {
        timeout: 10_000,
        maxBuffer: 100 * 1024,
      });
      output = stdout;
    } catch (_dockerErr) {
      // Fallback: journalctl
      let jCmd = `journalctl -u synap-${service} -n ${lines} --no-pager`;
      if (since) jCmd += ` --since="${since} ago"`;
      if (filter) jCmd += ` | grep -i ${JSON.stringify(filter)}`;
      try {
        const { stdout } = await execAsync(jCmd, {
          timeout: 10_000,
          maxBuffer: 100 * 1024,
        });
        output = stdout;
      } catch {
        output = `[No logs available for service "${service}". Docker and journalctl both unavailable.]`;
      }
    }

    // Truncate if over 100KB
    const MAX_OUTPUT = 100 * 1024;
    const truncated = Buffer.byteLength(output) > MAX_OUTPUT;
    if (truncated) {
      output =
        output.slice(-MAX_OUTPUT) + "\n[... truncated to last 100KB ...]";
    }

    return c.json({
      service,
      lines,
      truncated,
      output,
    });
  } catch (err) {
    logger.error({ err, service }, "terminal.logs failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500
    );
  }
});

/**
 * POST /channels/trigger-ai
 * Trigger an AI response in a channel with a skill prompt.
 * Used by skill triggers (entity_event / cron) to fire a skill into a user's channel.
 */
app.post("/channels/trigger-ai", async (c) => {
  if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
    return c.json(
      { error: "Insufficient scope: hub-protocol.write required" },
      403
    );
  }
  const body = (await c.req.json()) as {
    channelId: string;
    userId: string;
    workspaceId: string;
    systemPromptOverride: string;
    skillId?: string;
    entityId?: string;
  };

  if (
    !body.channelId ||
    !body.systemPromptOverride ||
    !body.userId ||
    !body.workspaceId
  ) {
    return c.json(
      {
        error:
          "channelId, userId, workspaceId, and systemPromptOverride are required",
      },
      400
    );
  }

  try {
    const caller = await getCaller(c, {
      workspaceId: body.workspaceId,
      userId: body.userId,
    });
    const result = await caller.channels.triggerAI({
      channelId: body.channelId,
      userId: body.userId,
      workspaceId: body.workspaceId,
      systemPromptOverride: body.systemPromptOverride,
      skillId: body.skillId,
      entityId: body.entityId,
    });
    return c.json(result);
  } catch (err) {
    logger.error(
      { err, channelId: body.channelId },
      "channels.triggerAI failed"
    );
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      500
    );
  }
});

// ── Proactive Intelligence (IS → Backend) ───────────────────────────────────

/**
 * POST /proactive/post
 * Allows the Intelligence Service to proactively post a message into a
 * user's proactive FEED channel (morning briefings, insights, nudges, etc.).
 *
 * Rate-limited: max 3 messages/hour and 10 messages/24h per user+workspace.
 * Delegates to routeSignal() from delivery-router which uses DeliveryService.
 */
app.post("/proactive/post", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
    return c.json(
      { error: "Insufficient scope: hub-protocol.write required" },
      403
    );
  }

  const body = (await c.req.json()) as {
    userId?: string;
    workspaceId?: string;
    content?: string;
    proactiveType?: string;
    reasoning?: string;
    metadata?: Record<string, unknown>;
  };

  // ── Input validation ────────────────────────────────────────────────────
  if (
    !body.userId ||
    !body.workspaceId ||
    !body.content ||
    !body.proactiveType
  ) {
    return c.json(
      { error: "userId, workspaceId, content, and proactiveType are required" },
      400
    );
  }

  const VALID_PROACTIVE_TYPES = [
    "insight",
    "suggestion",
    "alert",
    "nudge",
    "morning_briefing",
    "weekly_digest",
    "health_check",
  ] as const;

  if (
    !(VALID_PROACTIVE_TYPES as readonly string[]).includes(body.proactiveType)
  ) {
    return c.json(
      {
        error: `Invalid proactiveType "${body.proactiveType}". Must be one of: ${VALID_PROACTIVE_TYPES.join(", ")}`,
      },
      400
    );
  }

  if (body.content.length > 10000) {
    return c.json({ error: "content must be at most 10000 characters" }, 400);
  }

  try {
    // ── Rate limiting (DB-backed) ───────────────────────────────────────────
    // Count proactive messages for this user+workspace in the last hour and 24h.
    // We query the proactive feed channel's system messages with proactiveAi metadata.
    const { ensureProactiveFeedChannel } =
      await import("../utils/personal-channel.js");
    const channel = await ensureProactiveFeedChannel(
      body.userId,
      body.workspaceId
    );

    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const recentMessages = await db.query.messages.findMany({
      where: and(
        eq(messages.channelId, channel.id),
        eq(messages.role, "system"),
        gte(messages.timestamp, twentyFourHoursAgo)
      ),
      columns: { metadata: true, timestamp: true },
    });

    // Filter to proactive messages only
    const proactiveMessages = recentMessages.filter((m) => {
      const meta = m.metadata as Record<string, unknown> | null;
      return meta?.proactiveAi === true;
    });

    const lastHourCount = proactiveMessages.filter(
      (m) => m.timestamp >= oneHourAgo
    ).length;
    const last24hCount = proactiveMessages.length;

    if (lastHourCount >= 3) {
      return c.json({
        posted: false,
        reason: "rate_limited",
        detail: "Maximum 3 proactive messages per hour exceeded",
      });
    }

    if (last24hCount >= 10) {
      return c.json({
        posted: false,
        reason: "rate_limited",
        detail: "Maximum 10 proactive messages per 24 hours exceeded",
      });
    }

    // ── Route the signal via delivery router ───────────────────────────────
    // routeSignal respects workspace.settings.deliveryPreferences — the user
    // can configure whether IS insights go to feed, chat, notification, or all.
    const result = await routeSignal({
      domain: "ai_insight",
      content: body.content,
      userId: body.userId,
      workspaceId: body.workspaceId,
      proactiveType: body.proactiveType as ProactiveMessageType,
      metadata: {
        ...body.metadata,
        ...(body.reasoning ? { reasoning: body.reasoning } : {}),
      },
    });

    return c.json({ posted: result.delivered, ...result });
  } catch (err) {
    logger.error(
      { err, userId: body.userId, workspaceId: body.workspaceId },
      "proactive/post failed"
    );
    return c.json(
      {
        posted: false,
        reason: err instanceof Error ? err.message : "unknown_error",
      },
      500
    );
  }
});

// ── Notifications (IS → Backend) ────────────────────────────────────────────

/**
 * POST /notifications
 * IS calls this to persist a notification (e.g. skill.triggered) and emit
 * notification:new to the frontend. Backend-originated notifications (vault,
 * proposals) use NotificationService directly — this endpoint is for IS-side events.
 */
app.post("/notifications", async (c) => {
  if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
    return c.json(
      { error: "Insufficient scope: hub-protocol.write required" },
      403
    );
  }

  const body = (await c.req.json()) as {
    userId: string;
    workspaceId: string;
    type: string;
    sourceType?: string;
    sourceId?: string;
    workspaceUrl?: string;
    groupKey?: string;
    data?: Record<string, unknown>;
  };

  if (!body.userId || !body.workspaceId || !body.type) {
    return c.json({ error: "userId, workspaceId, and type are required" }, 400);
  }

  try {
    const id = await NotificationService.create({
      workspaceId: body.workspaceId,
      userId: body.userId,
      type: body.type,
      sourceType: (body.sourceType ?? "system") as
        | "proposal"
        | "connector"
        | "agent"
        | "system"
        | "inbox_item",
      sourceId: body.sourceId,
      workspaceUrl: body.workspaceUrl,
      groupKey: body.groupKey,
      data: body.data ?? {},
    });

    return c.json({ id });
  } catch (err) {
    logger.error({ err }, "notifications.create failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500
    );
  }
});

/**
 * POST /entity-share/deliver
 *
 * Called by the Control Plane (using its ES256 CP JWT) to deliver a shared
 * entity snapshot into the recipient's first active workspace on this pod.
 *
 * Auth: CP JWT (Bearer) — verified via JWKS, NOT the regular API key auth.
 * The standard API-key middleware above already ran, but this route validates
 * its own CP JWT on top of that so the regular IS API-key gate does not apply.
 *
 * This is a STATIC route — must stay above any /:id dynamic patterns.
 */
app.post("/entity-share/deliver", async (c) => {
  // Verify CP JWT — this call originates from the Control Plane, not from IS.
  const authHeader = c.req.header("authorization") ?? null;
  const rawToken = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!rawToken) {
    return c.json({ error: "Authorization header required" }, 401);
  }

  const cpUrl = config.server.controlPlaneUrl;
  const payload = await verifyCpJwt<{
    sub: string;
    email: string;
    type: string;
    aud: string;
  }>(rawToken, cpUrl);

  if (!payload || payload.type !== "entity-share-deliver") {
    return c.json({ error: "Invalid or expired CP token" }, 401);
  }

  const body = (await c.req.json()) as {
    entitySnapshot: Record<string, unknown>;
    fromPodId: string;
    shareId: string;
  };

  if (!body.entitySnapshot || !body.shareId) {
    return c.json({ error: "entitySnapshot and shareId are required" }, 400);
  }

  const snapshot = body.entitySnapshot;

  // Resolve the recipient user on this pod by email (from CP JWT)
  const { users, workspaceMembers } = await import("@synap/database/schema");
  const podUser = await db.query.users.findFirst({
    where: eq(users.email, payload.email),
    columns: { id: true },
  });

  if (!podUser) {
    logger.warn(
      { email: payload.email, shareId: body.shareId },
      "entity-share/deliver: no pod account found for recipient email"
    );
    return c.json(
      {
        error:
          "No pod account found for this email — please sign in to this pod first",
      },
      422
    );
  }

  // Find the recipient's first active workspace on this pod
  const membership = await db.query.workspaceMembers.findFirst({
    where: eq(workspaceMembers.userId, podUser.id),
    with: { workspace: { columns: { id: true } } },
    orderBy: (m, { asc }) => [asc(m.joinedAt)],
  });

  if (!membership?.workspace?.id) {
    logger.warn(
      { userId: podUser.id, shareId: body.shareId },
      "entity-share/deliver: recipient has no workspace on this pod"
    );
    return c.json({ error: "Recipient has no workspace on this pod" }, 422);
  }

  const workspaceId = membership.workspace.id;
  const profileSlug =
    (snapshot.profileSlug as string | undefined) ??
    (snapshot.type as string | undefined) ??
    "note";

  try {
    // Build caller context directly — getCaller reads scopes from the API key
    // middleware context which is bypassed for CP JWT auth on this route.
    const callerCtx = await createHubProtocolCallerContext(
      podUser.id,
      ["hub-protocol.read", "hub-protocol.write"],
      workspaceId
    );
    const caller = hubProtocolRouter.createCaller(callerCtx as any);

    const result = await caller.entities.createEntity({
      userId: podUser.id,
      profileSlug,
      title: (snapshot.title as string | undefined) ?? "Shared Entity",
      description: (snapshot.preview as string | undefined) ?? undefined,
      properties:
        (snapshot.properties as Record<string, unknown> | undefined) ?? {},
    });

    logger.info(
      { shareId: body.shareId, userId: podUser.id, workspaceId, profileSlug },
      "entity-share/deliver: entity created from share"
    );

    return c.json({ status: "ok", entityId: result?.id ?? null });
  } catch (err) {
    logger.error(
      { err, shareId: body.shareId },
      "entity-share/deliver: entity creation failed"
    );
    return c.json(
      { error: err instanceof Error ? err.message : "Entity creation failed" },
      500
    );
  }
});

// ─── POST /setup/agent ───────────────────────────────────────────────────────
//
// Agent setup endpoint. Creates an agent user + Hub Protocol API key
// for external services (e.g. OpenClaw).
//
// Auth (dual mode):
//   1. CP-signed JWT (type: "agent_setup" | "addon_activate") — managed pods
//   2. Bearer <PROVISIONING_TOKEN> — self-hosted pods (fallback)
//
// Body: { agentType: string, workspaceId?: string }
//
// Steps:
//   1. Find or create a pod-wide agent user (agentMetadata.writesRequireProposal: true)
//   2. Grant the agent editor membership in the target workspace (idempotent)
//   3. Create a Hub Protocol API key with hub-protocol.read/write + mcp.read/write scopes
//
// Idempotent: if an agent user with the given agentType already exists, it is
// reused. Any previously active Hub key for that user is revoked before creating
// a new one (the plaintext key is returned once only).
//
// Returns: { agentUserId, workspaceId, hubApiKey, keyId }
//

app.post("/setup/agent", async (c) => {
  const flowId = randomUUID();
  // ── Auth: CP JWT (preferred) or PROVISIONING_TOKEN (self-hosted fallback) ──
  const authHeader = c.req.header("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : null;

  if (!token) {
    return c.json({ error: "Missing Authorization header" }, 401);
  }

  let authenticated = false;
  let authMethod: "jwt" | "provisioning_token" | "api_key" =
    "provisioning_token";
  let jwtEmail: string | null = null;
  let jwtName: string | null = null;
  let jwtIssuerUrl: string | null = null;

  // Try 1: CP-signed JWT verified against Trusted Issuers registry
  const adminUrl = `${process.env.PUBLIC_URL ?? ""}/admin/trusted-issuers`;
  try {
    const decoded = jwt.decode(token);
    if (decoded && typeof decoded === "object") {
      const iss = (decoded as Record<string, unknown>).iss;
      if (typeof iss === "string" && iss.startsWith("https://")) {
        const issuerSvc = new TrustedIssuerService();
        let issuer = await issuerSvc.getByUrl(iss);

        if (!issuer) {
          // Unknown issuer — register as pending and ask admin to approve
          const derivedDisplayName = new URL(iss).hostname;
          issuer = await issuerSvc.registerPending(
            iss,
            derivedDisplayName,
            decoded
          );
          try {
            const podAdminWorkspace = await db.query.workspaces.findFirst({
              where: drizzleSql`${workspaces.settings}->>'systemSlug' = 'pod-admin'`,
              columns: { id: true },
            });
            if (podAdminWorkspace) {
              const admins = await db.query.workspaceMembers.findMany({
                where: and(
                  eq(workspaceMembers.workspaceId, podAdminWorkspace.id),
                  inArray(workspaceMembers.role, ["admin", "owner"])
                ),
                columns: { userId: true },
              });
              for (const admin of admins) {
                await NotificationService.create({
                  type: "system.issuer_pending_approval",
                  workspaceId: podAdminWorkspace.id,
                  userId: admin.userId,
                  sourceType: "system",
                  sourceId: issuer.id,
                  data: {
                    issuerUrl: iss,
                    displayName: derivedDisplayName,
                  },
                });
              }
            }
          } catch (notifyErr) {
            logger.warn(
              { err: notifyErr, issuerUrl: iss },
              "setup/agent: failed to notify admins about pending issuer"
            );
          }
          logger.warn(
            { issuerUrl: iss, adminUrl },
            "setup/agent: unknown JWT issuer registered as pending — admin approval required"
          );
          return c.json(
            { code: "ISSUER_PENDING_APPROVAL", adminUrl, issuerUrl: iss },
            202
          );
        }

        if (issuer.status === "pending") {
          return c.json(
            { code: "ISSUER_PENDING_APPROVAL", adminUrl, issuerUrl: iss },
            202
          );
        }

        if (issuer.status === "rejected" || issuer.status === "revoked") {
          return c.json(
            { error: "This issuer is not authorized on this pod." },
            403
          );
        }

        if (issuer.status === "approved") {
          if (!issuer.allowedScopes.includes("setup.agent")) {
            return c.json(
              { error: "This issuer is not authorized on this pod." },
              403
            );
          }

          try {
            const payload = await verifyCpJwt<{
              type: string;
              email?: string;
              name?: string;
            }>(token, iss);
            if (
              payload &&
              (payload.type === "agent_setup" ||
                payload.type === "addon_activate")
            ) {
              authenticated = true;
              authMethod = "jwt";
              jwtIssuerUrl = iss;
              jwtEmail =
                typeof payload.email === "string" ? payload.email : null;
              jwtName = typeof payload.name === "string" ? payload.name : null;
            }
          } catch {
            // JWT verification failed — fall through to other auth methods
          }
        }
      }
    }
  } catch {
    // Not a valid JWT or issuer lookup failed — fall through
  }

  // Try 2: PROVISIONING_TOKEN (self-hosted pods — env var known only to operator)
  if (!authenticated) {
    const provisioningToken = process.env.PROVISIONING_TOKEN;
    if (provisioningToken && token === provisioningToken) {
      authenticated = true;
      authMethod = "provisioning_token";
    }
  }

  // Try 3: Hub Protocol API key with `setup.agent` scope.
  //
  // This allows any trusted service — automation providers (n8n, Zapier,
  // custom scripts), third-party orchestrators — to provision agents on this
  // pod WITHOUT going through Synap CP or exposing PROVISIONING_TOKEN.
  //
  // Usage: pod admin creates a key with `setup.agent` scope from the admin UI
  // (pod-url/admin → API Keys → create with setup.agent scope), then hands
  // the key to the external service. The service calls POST /setup/agent with
  // that key as Bearer token like any other Hub Protocol call.
  if (!authenticated) {
    const keyRecord = await apiKeyService.validateApiKey(token);
    if (keyRecord?.isActive && keyRecord.scope.includes("setup.agent")) {
      authenticated = true;
      authMethod = "api_key";
      // Resolve key owner identity so the owner-creation logic below can
      // find/create the human user correctly (same as JWT email/name path).
      const keyOwner = await db.query.users.findFirst({
        where: (u, { eq }) => eq(u.id, keyRecord.userId),
        columns: { email: true, name: true },
      });
      jwtEmail = keyOwner?.email ?? null;
      jwtName = keyOwner?.name ?? null;
    }
  }

  if (!authenticated) {
    return c.json(
      {
        error:
          "Invalid credentials. Accepted: CP-signed JWT, PROVISIONING_TOKEN, or a Hub API key with `setup.agent` scope.",
      },
      401
    );
  }

  logger.info({ authMethod }, "setup/agent: authenticated");

  // ── Parse body ──────────────────────────────────────────────────────────────
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ error: "Invalid request body" }, 400);
  }

  const agentType: string =
    typeof body.agentType === "string" ? body.agentType : "openclaw";
  const requestedWorkspaceId: string | undefined =
    typeof body.workspaceId === "string" ? body.workspaceId : undefined;
  /** Optional workspace template definition sent by the CLI. Takes priority over
   *  the pod's bundled agent-os.json. */
  const bodyDefinition: Record<string, unknown> | null =
    body.definition &&
    typeof body.definition === "object" &&
    !Array.isArray(body.definition)
      ? (body.definition as Record<string, unknown>)
      : null;

  const agentLabel = agentType.charAt(0).toUpperCase() + agentType.slice(1);

  try {
    // ── Find target workspace ───────────────────────────────────────────────
    // Prefer a workspace that was previously seeded as Agent OS.
    // If none exists yet (no workspace at all, or only generic workspaces),
    // create a fresh Agent OS workspace from the bundled template.
    let ws = requestedWorkspaceId
      ? await db.query.workspaces.findFirst({
          where: (w, { eq }) => eq(w.id, requestedWorkspaceId),
        })
      : await db.query.workspaces.findFirst({
          where: drizzleSql`${workspaces.settings}->>'packageSlug' = 'agent-os'`,
          orderBy: (w) => asc(w.createdAt),
        });

    // If no Agent OS workspace exists (pod is fresh or only has generic workspaces),
    // auto-seed one from the bundled template.
    if (!ws && !requestedWorkspaceId) {
      let ownerCandidate = await db.query.users.findFirst({
        where: (u, { eq }) => eq(u.userType, "human"),
        columns: { id: true, name: true },
      });

      // No human user on pod yet — create one so we can seed the workspace.
      //
      // Two sources for the owner identity (tried in order):
      //   1. CP JWT payload (managed pods — email + name from CP account)
      //   2. ADMIN_EMAIL env var (self-hosted pods using PROVISIONING_TOKEN)
      //
      // kratosIdentityId is null in both cases; it will be linked later when the
      // user first logs in via Browser or Relay (Kratos webhook fires → user updated).
      if (!ownerCandidate) {
        const ownerEmail = jwtEmail ?? process.env.ADMIN_EMAIL ?? null;
        const ownerName =
          jwtName ?? (ownerEmail ? ownerEmail.split("@")[0] : null);

        if (ownerEmail) {
          // Check if a user with this email already exists (e.g. created by Kratos but
          // userType was set to something unexpected).
          const existingByEmail = await db.query.users.findFirst({
            where: (u, { eq }) => eq(u.email, ownerEmail),
            columns: { id: true, name: true },
          });

          if (existingByEmail) {
            ownerCandidate = existingByEmail;
            logger.info(
              { userId: existingByEmail.id, email: ownerEmail },
              "setup/agent: found existing user by email"
            );
          } else {
            const newUserId = randomUUID();
            await db.insert(users).values({
              id: newUserId,
              email: ownerEmail,
              name: ownerName,
              userType: "human",
              emailVerified: true,
              kratosIdentityId: null,
              timezone: "UTC",
              locale: "en",
            });
            ownerCandidate = { id: newUserId, name: ownerName };
            logger.info(
              {
                userId: newUserId,
                email: ownerEmail,
                source: jwtEmail ? "cp-jwt" : "admin-email-env",
              },
              "setup/agent: created human user (Kratos webhook not yet fired)"
            );
          }
        }
      }

      if (ownerCandidate) {
        // 1) definition from CLI body  2) bundled file fallback (dist/ → ../../../ = repo root)
        let agentOsDefinition: Record<string, unknown> | null = bodyDefinition;
        if (!agentOsDefinition) {
          try {
            const templatePath = resolvePath(
              new URL(".", import.meta.url).pathname,
              "../../../templates/agent-os.json"
            );
            agentOsDefinition = JSON.parse(readFileSync(templatePath, "utf-8"));
          } catch {
            // Template not available — fall back to blank workspace below
          }
        }

        let newWsId: string;
        if (agentOsDefinition) {
          const result = await createWorkspaceFromDefinition({
            definition: agentOsDefinition as Parameters<
              typeof createWorkspaceFromDefinition
            >[0]["definition"],
            userId: ownerCandidate.id,
            packageSlug: "agent-os",
            workspaceName: "OpenClaw Agent OS",
            // "personal" keeps the human as owner — the OpenClaw agent user gets editor access
            workspaceType: "personal",
            createdBy: "provisioning",
          });
          newWsId = result.workspaceId;
          logger.info(
            { workspaceId: newWsId, ownerId: ownerCandidate.id },
            "setup/agent: auto-seeded Agent OS workspace from template"
          );
        } else {
          // Fallback: plain blank workspace
          const [newWs] = await db
            .insert(workspaces)
            .values({
              name: ownerCandidate.name
                ? `${ownerCandidate.name}'s Space`
                : "My Space",
              type: "personal",
              ownerId: ownerCandidate.id,
              settings: {},
            })
            .returning();
          await db.insert(workspaceMembers).values({
            id: randomUUID(),
            workspaceId: newWs.id,
            userId: ownerCandidate.id,
            role: "owner",
          });
          newWsId = newWs.id;
          logger.info(
            { workspaceId: newWsId, ownerId: ownerCandidate.id },
            "setup/agent: auto-created blank workspace (template unavailable)"
          );
        }

        // Enqueue workspace-init to seed whiteboard, commands, relation defs, etc.
        try {
          const boss = getBoss();
          await boss.send("workspace-init", {
            workspaceId: newWsId,
            userId: ownerCandidate.id,
            packageSlug: "agent-os",
          });
        } catch (err) {
          logger.warn(
            { err, workspaceId: newWsId },
            "setup/agent: could not enqueue workspace-init (non-fatal)"
          );
        }

        ws = await db.query.workspaces.findFirst({
          where: (w, { eq }) => eq(w.id, newWsId),
        });
      }
    }

    if (!ws) {
      return c.json(
        {
          error: requestedWorkspaceId
            ? `Workspace ${requestedWorkspaceId} not found`
            : "No workspace found and could not auto-create one. Set ADMIN_EMAIL in your pod .env and retry.",
        },
        404
      );
    }

    // ── Find workspace owner, repair if missing ─────────────────────────────
    const ownerMember = await db.query.workspaceMembers.findFirst({
      where: and(
        eq(workspaceMembers.workspaceId, ws.id),
        eq(workspaceMembers.role, "owner")
      ),
      columns: { userId: true },
    });

    let ownerUserId = ownerMember?.userId ?? null;

    // If no owner member exists (stale/broken workspace), find the first human user
    // and make them the owner — self-healing for workspaces created by interrupted runs
    if (!ownerUserId) {
      const humanUser = await db.query.users.findFirst({
        where: (u, { eq }) => eq(u.userType, "human"),
        columns: { id: true },
      });
      if (humanUser) {
        // Check if they're already a member with a different role
        const existingMembership = await db.query.workspaceMembers.findFirst({
          where: and(
            eq(workspaceMembers.userId, humanUser.id),
            eq(workspaceMembers.workspaceId, ws.id)
          ),
          columns: { id: true, role: true },
        });
        if (!existingMembership) {
          await db.insert(workspaceMembers).values({
            id: randomUUID(),
            workspaceId: ws.id,
            userId: humanUser.id,
            role: "owner",
          });
          logger.info(
            { workspaceId: ws.id, userId: humanUser.id },
            "setup/agent: assigned human user as workspace owner (self-repair)"
          );
        }
        ownerUserId = humanUser.id;
      }
    }

    // ── 1. Find or create the agent user (pod-wide singleton per agentType) ─
    const existingAgent = await db.query.users.findFirst({
      where: and(
        eq(users.userType, "agent"),
        drizzleSql`${users.agentMetadata}->>'agentType' = ${agentType}`
      ),
      columns: { id: true },
    });

    let agentUserId: string;

    if (existingAgent) {
      agentUserId = existingAgent.id;
      logger.info(
        { agentUserId, agentType },
        "setup/agent: reusing existing agent user"
      );
    } else {
      agentUserId = randomUUID();
      const shortId = agentUserId.slice(0, 8);
      await db.insert(users).values({
        id: agentUserId,
        email: `agent-${agentType}-${shortId}@synap.agent`,
        name: agentLabel,
        emailVerified: true,
        userType: "agent",
        kratosIdentityId: null,
        agentMetadata: {
          agentType,
          description: `${agentLabel} — external agent (${authMethod === "jwt" ? "CP-managed" : "self-hosted"} setup)`,
          createdByUserId: ownerUserId ?? agentUserId,
          isPersonalAgent: false,
          writesRequireProposal: true,
          capabilities: [],
        },
        timezone: "UTC",
        locale: "en",
      });
      logger.info(
        { agentUserId, agentType },
        "setup/agent: created agent user"
      );
    }

    // ── 2. Grant workspace membership (idempotent) ──────────────────────────
    const existingMembership = await db.query.workspaceMembers.findFirst({
      where: and(
        eq(workspaceMembers.userId, agentUserId),
        eq(workspaceMembers.workspaceId, ws.id)
      ),
      columns: { id: true },
    });

    if (!existingMembership) {
      await db.insert(workspaceMembers).values({
        id: randomUUID(),
        workspaceId: ws.id,
        userId: agentUserId,
        role: "editor",
        invitedBy: ownerUserId ?? undefined,
      });
      logger.info(
        { agentUserId, workspaceId: ws.id },
        "setup/agent: workspace membership granted"
      );
    }

    // ── 3. Create Hub Protocol API key ──────────────────────────────────────
    await revokeActiveHubInboundKeysForUser(db, {
      userId: agentUserId,
      revokedBy: agentUserId,
      revokedReason: "Re-provisioning — replaced by new key via setup/agent",
    });

    const eventRepo = new EventRepository(sql);
    const apiKeyRepo = new ApiKeyRepository(db, eventRepo);
    const registration = await createAndVerifyHubInboundKey(
      apiKeyRepo,
      {
        keyName: `${agentLabel} Hub Key`,
        hubId: jwtIssuerUrl
          ? integrationHubIdFromIssuerUrl(jwtIssuerUrl)
          : undefined,
        scope: [...SETUP_AGENT_HUB_SCOPES],
        userId: agentUserId,
        keyType: "hub_inbound",
        description: `Hub Protocol auth token for ${agentLabel} agent — created via ${authMethod === "jwt" ? "CP-managed" : "self-hosted"} setup`,
      },
      agentUserId,
      agentUserId
    );
    const registrationTrace = toRegistrationTrace(flowId, registration);
    const { apiKey, plainKey } = registration;
    if (registration.outcome !== "CONNECTED_VERIFIED") {
      logger.error(
        {
          flowId,
          agentUserId,
          agentType,
          authMethod,
          verificationError: registration.verificationError,
        },
        "setup/agent: key minted but verification failed"
      );
      return c.json(
        {
          error: "Key minted but verification failed",
          code: "KEY_MINTED_BUT_VERIFICATION_FAILED",
          registration: registrationTrace,
        },
        500
      );
    }

    logger.info(
      {
        agentUserId,
        keyId: apiKey.id,
        workspaceId: ws.id,
        agentType,
        authMethod,
        registration: registrationTrace,
      },
      "setup/agent: Hub API key created"
    );

    return c.json({
      agentUserId,
      workspaceId: ws.id,
      hubApiKey: plainKey,
      keyId: apiKey.id,
      registration: registrationTrace,
    });
  } catch (err) {
    logger.error({ err, agentType, flowId }, "setup/agent: failed");
    return c.json({ error: "Internal server error", flowId }, 500);
  }
});

export const hubProtocolRestApp = app;
