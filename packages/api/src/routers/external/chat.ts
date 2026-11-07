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
import { db, eq, and, inArray, or, isDelegationHeaders } from "@synap/database";
import { channels, workspaceMembers } from "@synap/database/schema";
import { ChannelType, ChannelStatus } from "@synap/database/schema";
import { channelVisibilityWhere } from "../../utils/channel-visibility.js";
import { externalApiKeyAuth, type ExternalApiVariables } from "./middleware.js";
import { handleChatStream } from "../../services/chat-turns/stream-chat-request.js";

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
        eq(channels.status, ChannelStatus.ACTIVE),
        // Only what POST /stream will accept (the same read floor).
        channelVisibilityWhere(userId)
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
 *   1-2. Resolve workspace + channel through `resolveChatTarget` (the same
 *        resolver as `/api/chat/stream`: body ids, else the default workspace
 *        and the personal agent thread)
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
    return handleChatStream(c, {
      userId,
      delegationFor: ({ isUrl, channelId, turnId }) =>
        // D4: this turn's hub calls run as `userId` on a per-turn token.
        isDelegationHeaders({
          isUrl,
          operatorUserId: userId,
          channelId,
          runId: turnId,
        }),
    });
  }
);
