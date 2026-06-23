/**
 * Channel Gateway REST Handler
 *
 * Exposes REST endpoints consumed by the thin channel gateway service.
 * Auth: X-Channel-Key header (shared secret, set via CHANNEL_GATEWAY_KEY env var).
 *
 * Routes:
 *   POST /verify    — verify a link token and create a channel_connection
 *   POST /inbound   — receive a message, call IS, save messages, return AI response
 */

import { Hono } from "hono";
import { z } from "zod";
import { randomUUID, createHash } from "crypto";
import { createLogger } from "@synap-core/core";
import { db, eq, and, drizzleSql } from "@synap/database";
import {
  channelConnections,
  channelLinkTokens,
  messages,
  sessions,
} from "@synap/database/schema";
import {
  MessageRole,
  MessageAuthorType,
  SessionStatus,
} from "@synap/database/schema";
import {
  resolveIntelligenceService,
  ensureAgentThread,
  getAgentIdBySlug,
  getPodCallback,
} from "@synap/api";

const logger = createLogger({ module: "channel-gateway-rest" });

// Simple in-memory rate limiter for token verification attempts
// (prevents brute-force of the link token space)
const verifyAttempts = new Map<string, { count: number; resetAt: number }>();
function checkVerifyRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = verifyAttempts.get(ip);
  if (!entry || entry.resetAt < now) {
    verifyAttempts.set(ip, { count: 1, resetAt: now + 60_000 });
    return true; // allowed
  }
  if (entry.count >= 5) return false; // blocked
  entry.count++;
  return true;
}
// Cleanup old entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of verifyAttempts) {
    if (entry.resetAt < now) verifyAttempts.delete(ip);
  }
}, 300_000).unref();

// In-memory dedup cache for inbound messages (keyed by idempotencyKey)
// TTL: 10 minutes. Prevents double-processing on webhook retries.
const processedKeys = new Map<string, { reply: string; cachedUntil: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of processedKeys) {
    if (v.cachedUntil < now) processedKeys.delete(k);
  }
}, 600_000).unref();

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

export const channelGatewayApp = new Hono();

channelGatewayApp.use("/*", async (c, next) => {
  const key = c.req.header("x-channel-key");
  const expected = process.env.CHANNEL_GATEWAY_KEY;

  if (!expected) {
    logger.error("CHANNEL_GATEWAY_KEY not configured");
    return c.json({ error: "Service not configured" }, 503);
  }

  if (!key || key !== expected) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  return next();
});

// ---------------------------------------------------------------------------
// POST /verify — consume a link token and create a connection
// ---------------------------------------------------------------------------

const verifySchema = z.object({
  token: z.string().min(1),
  channel: z.string().min(1),
  channelUserId: z.string().min(1),
  externalUsername: z.string().optional(),
});

channelGatewayApp.post("/verify", async (c) => {
  const parsed = verifySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid request body" }, 400);
  const { token, channel, channelUserId, externalUsername } = parsed.data;

  const clientIp =
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (!checkVerifyRateLimit(clientIp)) {
    return c.json({ error: "Too many attempts. Try again in a minute." }, 429);
  }

  const now = new Date();

  // Look up the token
  const linkToken = await db.query.channelLinkTokens.findFirst({
    where: eq(channelLinkTokens.token, token),
  });

  if (!linkToken) {
    return c.json({ error: "Invalid or expired token" }, 404);
  }

  if (linkToken.usedAt) {
    // Idempotency: if same channel user re-submits an already-used token,
    // check if they're already connected
    const existing = await db.query.channelConnections.findFirst({
      where: and(
        eq(channelConnections.channel, channel),
        eq(channelConnections.channelUserId, channelUserId),
        eq(channelConnections.userId, linkToken.userId)
      ),
    });
    if (existing) {
      return c.json({ ok: true, alreadyLinked: true });
    }
    return c.json({ error: "Token already used" }, 410);
  }

  if (linkToken.expiresAt <= now) {
    return c.json({ error: "Token expired" }, 410);
  }

  if (linkToken.channel !== channel) {
    return c.json({ error: "Token is for a different channel" }, 400);
  }

  // Mark token as used + create (or update) the connection in a transaction
  await db.transaction(async (tx) => {
    // Mark token used
    await tx
      .update(channelLinkTokens)
      .set({ usedAt: now })
      .where(eq(channelLinkTokens.id, linkToken.id));

    // Upsert connection
    await tx
      .insert(channelConnections)
      .values({
        channel,
        channelUserId,
        userId: linkToken.userId,
        workspaceId: linkToken.workspaceId,
        defaultChannelId: linkToken.defaultChannelId,
        externalUsername: externalUsername ?? null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [channelConnections.channel, channelConnections.channelUserId],
        set: {
          userId: linkToken.userId,
          workspaceId: linkToken.workspaceId,
          defaultChannelId: linkToken.defaultChannelId,
          externalUsername: externalUsername ?? null,
          updatedAt: now,
        },
      });
  });

  logger.info(
    { channel, channelUserId, userId: linkToken.userId },
    "Channel connection created via link token"
  );

  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /inbound — receive external message, call IS, return AI reply
// ---------------------------------------------------------------------------

const inboundSchema = z.object({
  channel: z.string().min(1),
  channelUserId: z.string().min(1),
  message: z.string().min(1).max(8000),
  externalChatId: z.string().optional(),
  /** Unique ID for this message (e.g. Telegram update_id) — prevents duplicate processing */
  idempotencyKey: z.string().max(64).optional(),
});

channelGatewayApp.post("/inbound", async (c) => {
  const parsed = inboundSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid request body" }, 400);
  const { channel, channelUserId, message, idempotencyKey } = parsed.data;

  // Deduplication: return cached reply on retry
  if (idempotencyKey) {
    const cached = processedKeys.get(`${channel}:${idempotencyKey}`);
    if (cached && cached.cachedUntil > Date.now()) {
      return c.json({ ok: true, reply: cached.reply, deduplicated: true });
    }
  }

  // 1. Look up the connection
  const connection = await db.query.channelConnections.findFirst({
    where: and(
      eq(channelConnections.channel, channel),
      eq(channelConnections.channelUserId, channelUserId)
    ),
  });

  if (!connection) {
    return c.json({ error: "not_linked", message: "Account not linked" }, 404);
  }

  const { userId, workspaceId, defaultChannelId } = connection;

  // 2. Resolve channel: use configured default or get/create the user's personal channel
  let threadId: string = defaultChannelId ?? "";

  if (!threadId) {
    const orchestratorId = await getAgentIdBySlug("orchestrator");
    if (!orchestratorId) throw new Error("Orchestrator agent not found");
    const defaultAgentChannel = await ensureAgentThread(userId, orchestratorId);
    threadId = defaultAgentChannel.id;
  }

  // 3. Resolve intelligence service
  let resolvedService: Awaited<ReturnType<typeof resolveIntelligenceService>>;
  try {
    resolvedService = await resolveIntelligenceService({
      userId,
      workspaceId: workspaceId ?? undefined,
      capability: "chat",
    });
  } catch (err) {
    logger.error({ err }, "Failed to resolve intelligence service");
    return c.json(
      {
        error: "is_unavailable",
        message: "Intelligence service unavailable",
      },
      503
    );
  }

  // 4. Get or create active session for this channel (session-scoped memory)
  let activeSessionId: string | undefined;
  try {
    const existingSession = await db.query.sessions.findFirst({
      where: and(
        eq(sessions.channelId, threadId),
        eq(sessions.status, SessionStatus.ACTIVE)
      ),
      columns: { id: true },
    });

    if (existingSession) {
      activeSessionId = existingSession.id;
    } else {
      const newSessionId = randomUUID();
      await db
        .insert(sessions)
        .values({
          id: newSessionId,
          channelId: threadId,
          status: SessionStatus.ACTIVE,
        })
        .onConflictDoNothing();
      // Re-query to handle race
      const canonical = await db.query.sessions.findFirst({
        where: and(
          eq(sessions.channelId, threadId),
          eq(sessions.status, SessionStatus.ACTIVE)
        ),
        columns: { id: true },
      });
      activeSessionId = canonical?.id ?? newSessionId;
    }
  } catch (err) {
    logger.warn({ err, threadId }, "Session creation failed (non-blocking)");
  }

  // 5. Save the user's inbound message to the DB
  const userMessageId = randomUUID();
  const userMessageHash = createHash("sha256")
    .update(`${userMessageId}:${message}`)
    .digest("hex");

  try {
    await db.insert(messages).values({
      id: userMessageId,
      channelId: threadId,
      role: MessageRole.USER,
      authorType: MessageAuthorType.EXTERNAL,
      externalSource: channel,
      content: message,
      userId,
      previousHash: "",
      hash: userMessageHash,
      ...(activeSessionId ? { sessionId: activeSessionId } : {}),
      metadata: {
        externalChannel: channel,
        externalUserId: channelUserId,
      } as any,
    });
  } catch (err) {
    logger.error({ err, threadId }, "Failed to save inbound message");
    // Don't fail the request — still try to get AI response
  }

  // 6. Call IS (non-streaming)
  let aiReply: string;
  try {
    const hubResponse = await resolvedService.client.sendMessage({
      query: message,
      threadId,
      userId,
      workspaceId: workspaceId ?? undefined,
      ...getPodCallback(),
    });

    aiReply = hubResponse.content || "Sorry, I couldn't generate a response.";
  } catch (err) {
    logger.error({ err, userId, threadId }, "IS call failed");
    return c.json(
      {
        error: "is_error",
        message: "Failed to get AI response",
      },
      502
    );
  }

  // 7. Save the AI response to the DB
  try {
    const assistantMessageId = randomUUID();
    const assistantHash = createHash("sha256")
      .update(`${assistantMessageId}:${aiReply}`)
      .digest("hex");

    await db.insert(messages).values({
      id: assistantMessageId,
      channelId: threadId,
      role: MessageRole.ASSISTANT,
      authorType: MessageAuthorType.AI_AGENT,
      content: aiReply,
      userId,
      previousHash: userMessageHash,
      hash: assistantHash,
      ...(activeSessionId ? { sessionId: activeSessionId } : {}),
    });
  } catch (err) {
    logger.error({ err, threadId }, "Failed to save AI response message");
  }

  // 8. Update session activity (fire-and-forget)
  if (activeSessionId) {
    db.update(sessions)
      .set({
        lastActivityAt: new Date(),
        messageCount: drizzleSql`COALESCE(message_count, 0) + 2`,
      })
      .where(eq(sessions.id, activeSessionId))
      .catch(() => {});
  }

  // Cache for deduplication
  if (idempotencyKey) {
    processedKeys.set(`${channel}:${idempotencyKey}`, {
      reply: aiReply,
      cachedUntil: Date.now() + 10 * 60_000,
    });
  }

  return c.json({ ok: true, reply: aiReply });
});

// ---------------------------------------------------------------------------
// POST /unlink — remove a connection (called by the bot's /unlink command)
// ---------------------------------------------------------------------------

const unlinkSchema = z.object({
  channel: z.string().min(1),
  channelUserId: z.string().min(1),
});

channelGatewayApp.post("/unlink", async (c) => {
  const parsed = unlinkSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid request body" }, 400);
  const { channel, channelUserId } = parsed.data;

  const connection = await db.query.channelConnections.findFirst({
    where: and(
      eq(channelConnections.channel, channel),
      eq(channelConnections.channelUserId, channelUserId)
    ),
    columns: { id: true },
  });

  if (!connection) {
    return c.json({ error: "Connection not found" }, 404);
  }

  await db
    .delete(channelConnections)
    .where(eq(channelConnections.id, connection.id));

  logger.info({ channel, channelUserId }, "Channel connection removed");
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /callback — handle Telegram callback_query (inline keyboard button presses)
// ---------------------------------------------------------------------------
//
// Telegram sends all bot updates (messages AND button presses) to the same webhook
// URL. The external gateway service forwards them here. When the user presses
// ✅ Approve or ❌ Reject on a proposal notification, Telegram sends a
// callback_query update which we handle below.
export default channelGatewayApp;
