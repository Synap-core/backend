/**
 * Session-authed AI chat streaming — /api/chat/stream
 *
 * Why this route exists:
 *   The pod already exposes two chat paths:
 *     - `trpc.chat.sendMessage` — streams via Socket.IO, requires a socket
 *       client (none on Relay mobile today, deferred to Layer 3)
 *     - `/api/external/chat/stream` — SSE, but auth is API-key-based
 *       (scope: chat.stream), which session-authenticated clients like
 *       Relay can't use without leaking their session as an API key
 *
 *   Relay mobile has a session token (from Kratos) and needs HTTP/SSE
 *   streaming without a socket dependency. This route is the bridge: same
 *   IS proxy shape as the external variant, but session auth via the
 *   existing `orySessionMiddleware`, so any signed-in client on the pod
 *   (Relay, future Browser mobile, anything with a Kratos session) can
 *   stream AI responses over plain SSE.
 *
 * Flow:
 *   1. `orySessionMiddleware` (applied locally on this router — the pod's
 *      upstream auth middleware only covers /trpc/*, not /api/*) resolves
 *      the X-Session-Token header / session cookie and sets `userId` on
 *      the Hono context.
 *   2. Resolve the target channelId (either user-supplied or the personal
 *      thread channel for this workspace).
 *   3. Resolve the Intelligence Service endpoint for this workspace.
 *   4. Build the IS payload and proxy the SSE response bytes straight
 *      through to the client.
 *
 * Contract (client → server):
 *   POST /api/chat/stream
 *   Content-Type: application/json
 *   X-Session-Token: <kratos session token>     (upstream auth middleware)
 *   Body: { query: string, channelId?: string, workspaceId?: string,
 *           agentType?: string, threadId?: string }
 *
 * Contract (server → client):
 *   Standard SSE frames: `data: {"type":"content","content":"..."}`.
 *   Pass-through from IS — the pod never rewrites event types, it just
 *   pipes bytes. Clients parse whatever IS emits.
 */

import { Hono } from "hono";
import { z } from "zod";
import { db, eq, and } from "@synap/database";
import { getPodCallback } from "../utils/pod-callback.js";
import {
  channels,
  agents,
  workspaceMembers,
  messages,
  ChannelStatus,
  MessageRole,
} from "@synap/database/schema";
import {
  resolveIntelligenceService,
  resolveIntelligenceServiceByAgentId,
} from "../utils/intelligence-routing.js";
import {
  ensureAgentThread,
  getAgentIdBySlug,
} from "../utils/personal-channel.js";
import { queryChannelMessages } from "../utils/query-channel-messages.js";
import { channelVisibilityWhere } from "../utils/channel-visibility.js";
import { createLogger } from "@synap-core/core";
import { authMiddleware } from "@synap/auth";
import { createContext } from "../context.js";
import { channelSendMessageInputSchema, channelsRouter } from "./channels.js";
import { runWithChatTurnObserver } from "../utils/chat-turn-observer.js";
import {
  createChatTurnFrameSequencer,
  encodeAiSdkUiMessageStreamFrame,
  type ChatTurnFrame,
} from "../utils/chat-turn-sse.js";
import {
  appendChatTurnEvent,
  getChatTurnEvents,
  getChatTurnForUser,
  requestChatTurnCancellation,
} from "../services/chat-turns/chat-turn-store.js";
import { abortActiveChatTurn } from "../services/chat-turns/chat-turn-runtime.js";

const logger = createLogger({ module: "chat-stream" });

const streamBodySchema = z.object({
  query: z.string().min(1, "query is required"),
  channelId: z.string().uuid().optional(),
  workspaceId: z.string().uuid().optional(),
  agentType: z.string().optional(),
  /** Optional client-supplied thread id — passed through to IS for
   *  session continuity across multiple sends on the same conversation. */
  threadId: z.string().optional(),
});

// Hono's Variables type for the ory middleware — it sets `userId` + `user`.
interface SessionChatVariables {
  userId: string;
  user: unknown;
  authenticated: boolean;
}

export const chatStreamApp = new Hono<{
  Variables: SessionChatVariables;
}>();

// Apply session auth to every route in this router. The upstream pod
// only applies auth to /trpc/*, so /api/chat/* is unauthenticated unless
// we gate it here. Scoping the middleware to the router keeps the auth
// requirement co-located with the route — if someone mounts this app at
// a different prefix, the auth travels with it.
chatStreamApp.use("*", authMiddleware);

/**
 * POST /api/chat/turns
 *
 * The sender's authoritative stream. It invokes the same protected tRPC
 * procedure as Browser chat, so user persistence, proposal governance,
 * sessions, side effects, and observer Socket.IO fanout stay single-sourced.
 */
chatStreamApp.post("/turns", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  let input: z.infer<typeof channelSendMessageInputSchema>;
  try {
    const parsed = channelSendMessageInputSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        { error: "Invalid request body", details: parsed.error.issues },
        400
      );
    }
    // A retry key is mandatory for the canonical HTTP sender. tRPC remains
    // backward-compatible for older/non-SSE callers, but HTTP must never risk
    // invoking an agent twice after a network retry.
    if (!parsed.data.clientRequestId) {
      return c.json({ error: "clientRequestId is required" }, 400);
    }
    input = parsed.data;
  } catch {
    return c.json({ error: "Request body must be valid JSON" }, 400);
  }

  // Reuse the already authenticated Hono session when constructing the exact
  // context used by tRPC. This keeps protectedProcedure, audit logging, read
  // only checks, and AI rate limiting active for HTTP senders too.
  const context = await createContext(c.req.raw, c);
  if (!context.authenticated || context.userId !== userId) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const encoder = new TextEncoder();
  // A browser closing its SSE reader must not stop the authoritative turn or
  // its journal. It merely detaches this response; a reconnect replays the
  // same durable events with the same clientRequestId.
  let clientDetached = false;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
  const frames = createChatTurnFrameSequencer();

  let durableWrites = Promise.resolve();
  const writeStored = (frame: ChatTurnFrame | undefined) => {
    if (!frame || clientDetached || !controllerRef) return;
    try {
      controllerRef.enqueue(
        encoder.encode(encodeAiSdkUiMessageStreamFrame(frame))
      );
    } catch {
      clientDetached = true;
    }
  };
  const write = (frame: ChatTurnFrame | undefined) => {
    if (!frame) return;
    // Journal authority is independent from this response writer. Queue it
    // before attempting enqueue so a close race cannot drop the frame that a
    // reconnect needs to recover the turn.
    durableWrites = durableWrites
      .then(async () => {
        if (!frame.turnId) return;
        await appendChatTurnEvent({
          turnId: frame.turnId,
          type: frame.type,
          eventId: frame.eventId,
          payload: frame,
        });
      })
      .catch((error) => {
        logger.error(
          { err: error, turnId: frame.turnId },
          "Failed to persist chat turn event"
        );
      });
    try {
      if (!clientDetached && controllerRef) {
        controllerRef.enqueue(
          encoder.encode(encodeAiSdkUiMessageStreamFrame(frame))
        );
      }
    } catch {
      clientDetached = true;
    }
  };

  /**
   * A duplicate POST is a reconnect, not another model invocation. Replay the
   * immutable journal and keep following it until the original worker reaches
   * a terminal state. This also covers a browser reconnect after the original
   * SSE connection died mid-turn.
   */
  const replayExistingTurn = async (turnId: string) => {
    let afterSeq = 0;
    while (!clientDetached) {
      const events = await getChatTurnEvents({ turnId, afterSeq });
      for (const event of events) {
        writeStored(event.payload as ChatTurnFrame);
        afterSeq = event.seq;
        const frame = event.payload as ChatTurnFrame;
        if (frame.type === "complete" || frame.type === "error") return;
      }
      const turn = await getChatTurnForUser({ turnId, userId });
      if (!turn) return;
      if (turn.status !== "running") {
        // `channels.sendMessage` finishes domain persistence before this route
        // appends its canonical terminal frame. Do not close the reconnect in
        // that small window: wait for the journal's complete/error authority.
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        continue;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      const caller = channelsRouter.createCaller(context);

      void runWithChatTurnObserver(
        (event) => write(frames.fromBroadcast(event)),
        () => caller.sendMessage(input)
      )
        .then(async (result) => {
          if (result.reused && typeof result.turnId === "string") {
            await replayExistingTurn(result.turnId);
            return;
          }
          await durableWrites;
          write(frames.complete(result));
          await durableWrites;
        })
        .catch(async (error) => {
          write(frames.error(error));
          await durableWrites;
        })
        .finally(() => {
          if (!clientDetached) controller.close();
        });
    },
    cancel() {
      // Client detachment only ends this HTTP reader. A visible Stop uses the
      // explicit /turns/:id/cancel endpoint, which reaches the active IS fetch.
      clientDetached = true;
    },
  });

  return c.newResponse(stream, 200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "x-vercel-ai-ui-message-stream": "v1",
  });
});

/** Replay immutable events after a reconnect. `after` is exclusive. */
chatStreamApp.get("/turns/:turnId/events", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  const turnId = c.req.param("turnId");
  const afterRaw = c.req.query("after");
  const after = afterRaw === undefined ? undefined : Number(afterRaw);
  if (after !== undefined && (!Number.isInteger(after) || after < 0)) {
    return c.json({ error: "after must be a non-negative integer" }, 400);
  }
  const turn = await getChatTurnForUser({ turnId, userId });
  if (!turn) return c.json({ error: "Chat turn not found" }, 404);

  const events = await getChatTurnEvents({ turnId, afterSeq: after });
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(
          encoder.encode(
            encodeAiSdkUiMessageStreamFrame(event.payload as ChatTurnFrame)
          )
        );
      }
      if (turn.status !== "running") controller.close();
      else {
        // This endpoint is a deterministic catch-up snapshot, not a second
        // active stream owner. The client reconnects with the next `after` if
        // the original sender connection died while the turn remains active.
        controller.close();
      }
    },
  });
  return c.newResponse(stream, 200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "x-vercel-ai-ui-message-stream": "v1",
  });
});

/** Request real cancellation: marks the durable turn then aborts its active IS fetch. */
chatStreamApp.post("/turns/:turnId/cancel", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  const turn = await requestChatTurnCancellation({
    turnId: c.req.param("turnId"),
    userId,
  });
  if (!turn)
    return c.json({ error: "Chat turn not found or no longer active" }, 404);
  return c.json({
    turnId: turn.id,
    cancelled: true,
    abortDelivered: abortActiveChatTurn(turn.id),
    // A different replica observes cancelRequested through the turn worker's
    // short poll, so 200 always means cancellation is durably scheduled.
    cancellationScheduled: true,
  });
});

chatStreamApp.post("/stream", async (c) => {
  // Session auth is enforced by the router-level `authMiddleware` above.
  // Defend anyway so a routing change can't silently skip it.
  const userId = c.get("userId");
  if (!userId) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // Parse + validate body
  let input: z.infer<typeof streamBodySchema>;
  try {
    const raw = await c.req.json();
    const parsed = streamBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid request body", details: parsed.error.issues },
        400
      );
    }
    input = parsed.data;
  } catch {
    return c.json({ error: "Request body must be valid JSON" }, 400);
  }

  // ── Resolve workspaceId ──────────────────────────────────────────────────
  let resolvedWorkspaceId: string;
  if (input.workspaceId) {
    const membership = await db.query.workspaceMembers.findFirst({
      where: and(
        eq(workspaceMembers.workspaceId, input.workspaceId),
        eq(workspaceMembers.userId, userId)
      ),
      columns: { workspaceId: true },
    });
    if (!membership) {
      return c.json({ error: "Workspace not found or access denied" }, 404);
    }
    resolvedWorkspaceId = input.workspaceId;
  } else {
    const membership = await db.query.workspaceMembers.findFirst({
      where: eq(workspaceMembers.userId, userId),
      columns: { workspaceId: true },
    });
    if (!membership) {
      return c.json({ error: "No workspace found for this user" }, 404);
    }
    resolvedWorkspaceId = membership.workspaceId;
  }

  // ── Resolve channelId ────────────────────────────────────────────────────
  let resolvedChannelId: string;
  if (input.channelId) {
    const channel = await db.query.channels.findFirst({
      where: and(
        eq(channels.id, input.channelId),
        eq(channels.status, ChannelStatus.ACTIVE),
        channelVisibilityWhere(userId)
      ),
      columns: { id: true, workspaceId: true },
    });
    if (!channel) {
      return c.json({ error: "Channel not found" }, 404);
    }
    if (channel.workspaceId) {
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(
          eq(workspaceMembers.workspaceId, channel.workspaceId),
          eq(workspaceMembers.userId, userId)
        ),
        columns: { workspaceId: true },
      });
      if (!membership) {
        // 404 instead of 403 to avoid leaking channel existence
        return c.json({ error: "Channel not found" }, 404);
      }
    }
    resolvedChannelId = input.channelId;
  } else {
    try {
      const orchestratorId = await getAgentIdBySlug("orchestrator");
      if (!orchestratorId)
        return c.json({ error: "Default agent not found" }, 500);
      const personalChannel = await ensureAgentThread(userId, orchestratorId);
      resolvedChannelId = personalChannel.id;
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "Failed to resolve default agent thread"
      );
      return c.json({ error: "Failed to resolve chat channel" }, 500);
    }
  }

  // ── Read channel's assigned agent to drive IS routing and agentType ────────
  let channelAgentId: string | null = null;
  let channelAgentSlug: string | null = null;
  try {
    const channelRow = await db.query.channels.findFirst({
      where: eq(channels.id, resolvedChannelId),
      columns: { assignedAgentId: true },
    });
    if (channelRow?.assignedAgentId) {
      channelAgentId = channelRow.assignedAgentId;
      const [agentRow] = await db
        .select({ slug: agents.slug })
        .from(agents)
        .where(eq(agents.id, channelAgentId))
        .limit(1);
      channelAgentSlug = agentRow?.slug ?? null;
    }
  } catch {
    // non-fatal
  }

  // ── Resolve Intelligence Service endpoint ────────────────────────────────
  let isUrl: string;
  let isApiKey: string;
  try {
    const resolved = channelAgentId
      ? await resolveIntelligenceServiceByAgentId(channelAgentId, {
          userId,
          workspaceId: resolvedWorkspaceId,
          capability: "chat",
        })
      : await resolveIntelligenceService({
          userId,
          workspaceId: resolvedWorkspaceId,
        });
    isUrl = resolved.endpoint;
    isApiKey = resolved.serviceApiKey;
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "Failed to resolve intelligence service"
    );
    return c.json({ error: "Intelligence service unavailable" }, 502);
  }

  // ── Build IS request body ────────────────────────────────────────────────
  // IS calls channels "threads" in its own vocabulary. Prefer the explicit
  // client-supplied threadId if present (for cross-session continuity),
  // otherwise fall back to the resolved channel id.
  const isBody = {
    query: input.query,
    threadId: input.threadId ?? resolvedChannelId,
    userId,
    workspaceId: resolvedWorkspaceId,
    agentType: input.agentType ?? channelAgentSlug ?? "meta",
    ...getPodCallback(),
    stream: true,
  };

  // ── Proxy to IS and pipe SSE back ────────────────────────────────────────
  let isResponse: Response;
  try {
    isResponse = await fetch(`${isUrl}/api/chat/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": isApiKey,
        "X-Synap-Channel": "session",
      },
      body: JSON.stringify(isBody),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, "Failed to reach intelligence service");
    return c.json({ error: "Intelligence service unreachable" }, 502);
  }

  if (!isResponse.ok) {
    await isResponse.text().catch(() => "");
    logger.warn(
      { status: isResponse.status, channelId: resolvedChannelId },
      "Intelligence service returned non-OK status"
    );
    return c.json(
      { error: `Chat stream failed: IS returned ${isResponse.status}` },
      502
    );
  }

  if (!isResponse.body) {
    return c.json(
      { error: "Intelligence service returned empty response" },
      502
    );
  }

  // Pipe the SSE response body straight through. Clients read the
  // standard `data: {...}` SSE frames and parse whatever `type` the IS
  // emits (`content`, `step`, `complete`, `error`, ...).
  return c.newResponse(isResponse.body, 200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
});

/**
 * GET /api/chat/history
 *
 * Returns recent chat messages for the caller's personal channel in the
 * given workspace. Relay calls this on mount when AsyncStorage is empty
 * (new device / fresh install) to restore conversation history from the pod.
 *
 * Query params:
 *   workspaceId  (optional) — UUID of the workspace. Defaults to the
 *                             user's first accessible workspace.
 *   channelId    (optional) — explicit channel to read from. When omitted,
 *                             the user's personal channel is used.
 *   limit        (optional) — Max messages to return (default 50, max 100).
 *
 * Response: { messages: Array<{ id, role, content, timestamp }> }
 * Messages are returned oldest-first so clients can render in order.
 * role is "user" | "assistant" — system messages are excluded.
 */
chatStreamApp.get("/history", async (c) => {
  const userId = c.get("userId");
  if (!userId) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // ── Resolve workspaceId ────────────────────────────────────────────────────
  const rawWorkspaceId = c.req.query("workspaceId");
  const rawChannelId = c.req.query("channelId");
  if (rawWorkspaceId) {
    const membership = await db.query.workspaceMembers.findFirst({
      where: and(
        eq(workspaceMembers.workspaceId, rawWorkspaceId),
        eq(workspaceMembers.userId, userId)
      ),
      columns: { workspaceId: true },
    });
    if (!membership) {
      return c.json({ error: "Workspace not found or access denied" }, 404);
    }
  } else {
    const membership = await db.query.workspaceMembers.findFirst({
      where: eq(workspaceMembers.userId, userId),
      columns: { workspaceId: true },
    });
    if (!membership) {
      return c.json({ error: "No workspace found for this user" }, 404);
    }
  }

  // ── Parse limit ────────────────────────────────────────────────────────────
  const rawLimit = c.req.query("limit");
  const limit = Math.min(
    100,
    Math.max(1, parseInt(rawLimit ?? "50", 10) || 50)
  );

  // ── Resolve channel ────────────────────────────────────────────────────────
  let channelId: string;
  if (rawChannelId) {
    const channel = await db.query.channels.findFirst({
      where: and(eq(channels.id, rawChannelId), eq(channels.userId, userId)),
      columns: { id: true, workspaceId: true },
    });
    if (!channel) {
      return c.json({ error: "Channel not found" }, 404);
    }
    if (channel.workspaceId) {
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(
          eq(workspaceMembers.workspaceId, channel.workspaceId),
          eq(workspaceMembers.userId, userId)
        ),
        columns: { workspaceId: true },
      });
      if (!membership) {
        return c.json({ error: "Channel not found" }, 404);
      }
    }
    channelId = channel.id;
  } else {
    try {
      const orchestratorId = await getAgentIdBySlug("orchestrator");
      if (!orchestratorId)
        return c.json({ error: "Default agent not found" }, 500);
      const personalChannel = await ensureAgentThread(userId, orchestratorId);
      channelId = personalChannel.id;
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "Failed to resolve default agent thread for history fetch"
      );
      return c.json({ error: "Failed to resolve chat channel" }, 500);
    }
  }

  // ── Fetch messages (user + assistant only, newest first, then reverse) ─────
  // Reads through the ONE door (queryChannelMessages). `channelId` was already
  // authorized above (owner + workspace-membership check), so no userId gate is
  // passed here; the helper still owns isNull(deletedAt) + ephemeral=false so
  // catch-me-up recaps never restore into a fresh client's history.
  const rows = await queryChannelMessages<
    Pick<typeof messages.$inferSelect, "id" | "role" | "content" | "timestamp">
  >(db, {
    channelId,
    order: "desc",
    limit,
    columns: { id: true, role: true, content: true, timestamp: true },
  });

  // Exclude system messages and return oldest-first for rendering order
  const filtered = rows
    .filter(
      (m) => m.role === MessageRole.USER || m.role === MessageRole.ASSISTANT
    )
    .reverse();

  return c.json({ messages: filtered });
});
