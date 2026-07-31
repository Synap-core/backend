/**
 * External Chat API — /api/external/chat
 *
 * Option D: Conversational Chat Proxy.
 * Lets external callers (Claude Code, custom agents, scripts) have a
 * streaming AI conversation backed by the pod's Intelligence Service,
 * using only their pod URL + API key (scope: chat.stream).
 *
 * GET  /channels — list channels the API key owner can chat in
 * POST /stream   — proxy to IS chat stream (SSE)
 *
 * Auth: Bearer API key with scope "chat.stream" (handled by externalApiKeyAuth).
 * IS credentials are never exposed in any response body.
 *
 * Durable ledger: every stream reserves a `chat_turns` row (full ledger for
 * external AI — not ephemeral-only). Clients may supply X-Request-Id or
 * body.requestId (UUID); otherwise the pod allocates one. Turn id is returned
 * via `X-Synap-Turn-Id` and a leading SSE `turn` frame.
 */

import { Hono } from "hono";
import { z } from "zod";
import { db, eq, and, inArray, or } from "@synap/database";
import { channels, workspaceMembers } from "@synap/database/schema";
import { getPodCallback } from "../../utils/pod-callback.js";
import { ChannelType, ChannelStatus } from "@synap/database/schema";
import { resolveIntelligenceService } from "../../utils/intelligence-routing.js";
import {
  ensureAgentThread,
  getAgentIdBySlug,
} from "../../utils/personal-channel.js";
import { createLogger } from "@synap-core/core";
import { externalApiKeyAuth, type ExternalApiVariables } from "./middleware.js";
import {
  beginExternalDurableTurn,
  resolveExternalRequestId,
  safeFinishExternalTurn,
  SYNAP_TURN_ID_HEADER,
  wrapUpstreamStreamWithTurnLifecycle,
} from "../../services/chat-turns/external-durable-turn.js";
import {
  decideChatTurnClaimAction,
  hasUsefulAssistantForTurn,
  reopenChatTurn,
} from "../../services/chat-turns/chat-turn-store.js";

const logger = createLogger({ module: "external-chat" });

const streamBodySchema = z.object({
  query: z.string().min(1, "query is required"),
  channelId: z.string().uuid().optional(),
  workspaceId: z.string().uuid().optional(),
  agentType: z.string().optional(),
  /** Client idempotency key (UUID). Also accepted via X-Request-Id header. */
  requestId: z.string().uuid().optional(),
});

export const externalChatApp = new Hono<{
  Variables: ExternalApiVariables;
}>();

// ── List channels ─────────────────────────────────────────────────────────────

/**
 * GET /channels
 * Returns all AI-chat channels the API key owner can chat in
 * (i.e. channels whose workspace the user is a member of).
 */
externalChatApp.get(
  "/channels",
  externalApiKeyAuth("chat.stream"),
  async (c) => {
    const userId = c.get("userId");

    // Find all workspaces the user is a member of
    const memberships = await db.query.workspaceMembers.findMany({
      where: eq(workspaceMembers.userId, userId),
      columns: { workspaceId: true },
    });

    if (memberships.length === 0) {
      return c.json([]);
    }

    const workspaceIds = memberships.map((m) => m.workspaceId);

    // Query channels in those workspaces with types suitable for AI chat
    const rows = await db.query.channels.findMany({
      where: and(
        inArray(channels.workspaceId, workspaceIds),
        or(
          eq(channels.channelType, ChannelType.AGENT_COLLAB),
          eq(channels.channelType, ChannelType.SUB_THREAD),
          and(
            eq(channels.channelType, ChannelType.THREAD),
            eq(channels.contextObjectType, "workspace")
          )
        )!,
        eq(channels.status, ChannelStatus.ACTIVE)
      ),
      columns: {
        id: true,
        channelType: true,
        title: true,
        workspaceId: true,
      },
    });

    return c.json(
      rows.map((r) => ({
        id: r.id,
        type: r.channelType,
        name: r.title ?? null,
        workspaceId: r.workspaceId,
      }))
    );
  }
);

// ── Stream chat ───────────────────────────────────────────────────────────────

/**
 * POST /stream
 * Proxies a chat request to the Intelligence Service as SSE.
 *
 * Steps:
 *   1. Resolve workspaceId (from body or first membership)
 *   2. Resolve channelId (from body or personal channel via ensurePersonalChannel)
 *   3. Reserve durable chat_turn (full external ledger)
 *   4. Resolve IS endpoint + key (resolveIntelligenceService)
 *   5. Build IS request body
 *   6. Fetch IS and pipe SSE frames back to caller; finish turn on drain/error
 */
externalChatApp.post(
  "/stream",
  externalApiKeyAuth("chat.stream"),
  async (c) => {
    const userId = c.get("userId");

    // Parse + validate request body
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

    // ── Step 1: Resolve workspaceId ──────────────────────────────────────────
    let resolvedWorkspaceId: string;

    if (input.workspaceId) {
      // Verify membership
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
      // Use first workspace membership
      const membership = await db.query.workspaceMembers.findFirst({
        where: eq(workspaceMembers.userId, userId),
        columns: { workspaceId: true },
      });
      if (!membership) {
        return c.json({ error: "No workspace found for this user" }, 404);
      }
      resolvedWorkspaceId = membership.workspaceId;
    }

    // ── Step 2: Resolve channelId ────────────────────────────────────────────
    let resolvedChannelId: string;

    if (input.channelId) {
      // Verify the channel exists and user has access (member of channel's workspace)
      const channel = await db.query.channels.findFirst({
        where: eq(channels.id, input.channelId),
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
          return c.json({ error: "Channel not found" }, 404); // 404 to avoid info leak
        }
      }
      resolvedChannelId = input.channelId;
    } else {
      // Auto-create or retrieve the user's personal thread
      try {
        const orchestratorId = await getAgentIdBySlug("orchestrator");
        if (!orchestratorId) throw new Error("Default agent not found");
        const personalChannel = await ensureAgentThread(userId, orchestratorId);
        resolvedChannelId = personalChannel.id;
      } catch (err) {
        logger.error(
          { err: err instanceof Error ? err.message : String(err) },
          "Failed to ensure personal channel"
        );
        return c.json({ error: "Failed to resolve chat channel" }, 500);
      }
    }

    // ── Step 3: Reserve durable chat_turn ────────────────────────────────────
    const requestId = resolveExternalRequestId(
      c.req.header("x-request-id") ?? c.req.header("X-Request-Id"),
      input.requestId
    );

    let durableTurn: Awaited<
      ReturnType<typeof beginExternalDurableTurn>
    >["turn"];
    let turnCreated: boolean;
    try {
      const claimed = await beginExternalDurableTurn({
        channelId: resolvedChannelId,
        userId,
        requestId,
        content: input.query,
        source: "external_chat",
      });
      durableTurn = claimed.turn;
      turnCreated = claimed.created;
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "Failed to create durable chat turn"
      );
      return c.json({ error: "Failed to start chat turn" }, 500);
    }

    // Idempotent claim policy under the same requestId (D5):
    // completed → skip; running → in_progress; failed + no assistant → reopen.
    if (!turnCreated) {
      const hasUsefulAssistant = await hasUsefulAssistantForTurn(
        durableTurn.assistantMessageId
      );
      const action = decideChatTurnClaimAction({
        created: false,
        status: durableTurn.status,
        hasUsefulAssistant,
      });

      if (action === "reopen_and_run") {
        const claimedReopen = await reopenChatTurn(durableTurn.id);
        if (!claimedReopen) {
          // Lost CAS race — another worker reopened first.
          const encoder = new TextEncoder();
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    type: "turn",
                    turnId: durableTurn!.id,
                    requestId: durableTurn!.requestId,
                    status: "running",
                    reused: true,
                    error: "turn_in_progress",
                  })}\n\n`
                )
              );
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            },
          });
          return new Response(stream, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
              [SYNAP_TURN_ID_HEADER]: durableTurn.id,
            },
          });
        }
        durableTurn = {
          ...durableTurn,
          status: "running",
          error: null,
          completedAt: null,
        };
        // Fall through to IS — same requestId, fresh attempt.
      } else {
        const encoder = new TextEncoder();
        const leading = `data: ${JSON.stringify({
          type: "turn",
          turnId: durableTurn.id,
          requestId: durableTurn.requestId,
          status: durableTurn.status,
          reused: true,
        })}\n\n`;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(leading));
            if (action === "skip_completed") {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "complete", turnId: durableTurn.id, reused: true })}\n\n`
                )
              );
            } else if (action === "in_progress") {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    type: "error",
                    turnId: durableTurn.id,
                    message: "Turn already in progress for this requestId",
                    reused: true,
                  })}\n\n`
                )
              );
            } else {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    type: "error",
                    turnId: durableTurn.id,
                    message: durableTurn.error ?? "Turn already finished",
                    reused: true,
                  })}\n\n`
                )
              );
            }
            controller.close();
          },
        });
        return c.newResponse(stream, 200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
          [SYNAP_TURN_ID_HEADER]: durableTurn.id,
        });
      }
    }

    // ── Step 4: Resolve IS endpoint ──────────────────────────────────────────
    let isUrl: string;
    let isApiKey: string;
    try {
      const resolved = await resolveIntelligenceService({
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
      await safeFinishExternalTurn({
        turnId: durableTurn.id,
        status: "failed",
        error: "Intelligence service unavailable",
      });
      return c.json(
        {
          error: "Intelligence service unavailable",
          turnId: durableTurn.id,
        },
        502,
        { [SYNAP_TURN_ID_HEADER]: durableTurn.id }
      );
    }

    // ── Step 5: Build IS request body ────────────────────────────────────────
    const isBody = {
      query: input.query,
      threadId: resolvedChannelId, // IS calls channels "threads"
      userId,
      workspaceId: resolvedWorkspaceId,
      agentType: input.agentType ?? "meta",
      ...getPodCallback(),
      stream: true,
    };

    // ── Step 6: Proxy to IS and stream SSE back ──────────────────────────────
    let isResponse: Response;
    try {
      isResponse = await fetch(`${isUrl}/api/chat/stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": isApiKey,
          "X-Synap-Channel": "api",
        },
        body: JSON.stringify(isBody),
        signal: AbortSignal.timeout(120_000), // 2 min timeout for long AI responses
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, "Failed to reach intelligence service");
      await safeFinishExternalTurn({
        turnId: durableTurn.id,
        status: "failed",
        error: "Intelligence service unreachable",
      });
      // Never expose IS URL or IS API key in the error
      return c.json(
        {
          error: "Intelligence service unreachable",
          turnId: durableTurn.id,
        },
        502,
        { [SYNAP_TURN_ID_HEADER]: durableTurn.id }
      );
    }

    if (!isResponse.ok) {
      // Consume error body (never forward IS internals to caller)
      await isResponse.text().catch(() => "");
      logger.warn(
        { status: isResponse.status, channelId: resolvedChannelId },
        "Intelligence service returned non-OK status"
      );
      await safeFinishExternalTurn({
        turnId: durableTurn.id,
        status: "failed",
        error: `Chat stream failed: IS returned ${isResponse.status}`,
      });
      return c.json(
        {
          error: `Chat stream failed: IS returned ${isResponse.status}`,
          turnId: durableTurn.id,
        },
        502,
        { [SYNAP_TURN_ID_HEADER]: durableTurn.id }
      );
    }

    if (!isResponse.body) {
      await safeFinishExternalTurn({
        turnId: durableTurn.id,
        status: "failed",
        error: "Intelligence service returned empty response",
      });
      return c.json(
        {
          error: "Intelligence service returned empty response",
          turnId: durableTurn.id,
        },
        502,
        { [SYNAP_TURN_ID_HEADER]: durableTurn.id }
      );
    }

    const leadingSseFrame = `data: ${JSON.stringify({
      type: "turn",
      turnId: durableTurn.id,
      requestId: durableTurn.requestId,
    })}\n\n`;

    const body = wrapUpstreamStreamWithTurnLifecycle({
      upstream: isResponse.body,
      turnId: durableTurn.id,
      leadingSseFrame,
    });

    return c.newResponse(body, 200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      [SYNAP_TURN_ID_HEADER]: durableTurn.id,
    });
  }
);
