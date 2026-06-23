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
 */

import { Hono } from "hono";
import { z } from "zod";
import { db, eq, and, inArray, or } from "@synap/database";
import { channels, workspaceMembers } from "@synap/database/schema";
import { getPodReadKey } from "../../utils/pod-read-key.js";
import { ChannelType, ChannelStatus } from "@synap/database/schema";
import { resolveIntelligenceService } from "../../utils/intelligence-routing.js";
import {
  ensureAgentThread,
  getAgentIdBySlug,
} from "../../utils/personal-channel.js";
import { createLogger } from "@synap-core/core";
import { externalApiKeyAuth, type ExternalApiVariables } from "./middleware.js";

const logger = createLogger({ module: "external-chat" });

const streamBodySchema = z.object({
  query: z.string().min(1, "query is required"),
  channelId: z.string().uuid().optional(),
  workspaceId: z.string().uuid().optional(),
  agentType: z.string().optional(),
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
 *   3. Resolve IS endpoint + key (resolveIntelligenceService)
 *   4. Build IS request body
 *   5. Fetch IS and pipe SSE frames back to caller
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

    // ── Step 3: Resolve IS endpoint ──────────────────────────────────────────
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
      return c.json({ error: "Intelligence service unavailable" }, 502);
    }

    // ── Step 4: Build IS request body ────────────────────────────────────────
    const isBody = {
      query: input.query,
      threadId: resolvedChannelId, // IS calls channels "threads"
      userId,
      workspaceId: resolvedWorkspaceId,
      agentType: input.agentType ?? "meta",
      dataPodUrl: process.env.PUBLIC_URL ?? process.env.BACKEND_URL ?? "",
      dataPodApiKey: getPodReadKey(),
      stream: true,
    };

    // ── Step 5: Proxy to IS and stream SSE back ──────────────────────────────
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
      // Never expose IS URL or IS API key in the error
      return c.json({ error: "Intelligence service unreachable" }, 502);
    }

    if (!isResponse.ok) {
      // Consume error body (never forward IS internals to caller)
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

    // Pipe the SSE response body directly back to the caller
    return c.newResponse(isResponse.body, 200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
  }
);
