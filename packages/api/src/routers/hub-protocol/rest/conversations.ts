/**
 * Hub Protocol REST — the terminal heartbeat door (Agents working together
 * plan v1 §3 "Presence"). What a terminal reporter (the ClaudeSwitch hook on
 * the Mac, the CLI hook on the devbox, the bridge on bind) calls to keep its
 * conversation on the map.
 *
 *   POST /conversations/heartbeat
 *     {computer, harness, conversationId, state, folder?, subagents?,
 *      sessionId?, ended?}   — STRICT: any other field is a 400
 *     → 200 {conversation, written, sessionId, sessionLinkSkipped?}
 *     → 400 invalid body · 403 missing scope · 404 sessionId not the person's
 *
 * Telemetry, never governed (the `last_used_at` precedent): the effect is
 * `recordHeartbeat` (`services/agent-conversations/`), and what it may store is
 * `decodeHeartbeat`'s output only. The person is the key's (`userId`); the
 * agent, key and computer principal come from the key, never from the body.
 */

import { z } from "zod";
import { AGENT_CONVERSATION_STATES } from "@synap/database/schema";
import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  hasScope,
  logger,
  resolveActingContext,
  type HubHono,
  httpStatusForTrpcError,
} from "./_shared.js";
import {
  HeartbeatBodySchema,
  decodeHeartbeat,
} from "../../../services/agent-conversations/heartbeat-codec.js";
import { recordHeartbeat } from "../../../services/agent-conversations/agent-conversations.js";

const HeartbeatResponseSchema = z.object({
  conversation: z.object({
    id: z.string().uuid(),
    computer: z.string(),
    harness: z.string(),
    conversationId: z.string(),
    state: z.enum(AGENT_CONVERSATION_STATES),
    stateSince: z.string(),
    endedAt: z.string().nullable(),
  }),
  written: z.boolean(),
  sessionId: z.string().uuid().nullable(),
  sessionLinkSkipped: z.enum(["no_api_key", "ended"]).optional(),
});

export function registerConversationsRoutes(app: HubHono): void {
  registerOpenApi(app, {
    method: "post",
    path: "/conversations/heartbeat",
    tags: ["Conversations"],
    summary: "Report a live agent terminal (heartbeat)",
    description:
      "Idempotent upsert of one agent conversation, keyed by (person, computer, harness, conversationId). " +
      "Send on every state change and at least every 5 minutes while the conversation is open; " +
      "`ended: true` closes it (a later beat reopens it). `state` is working | idle | waiting; the " +
      "server stamps `stateSince` when it changes. `folder` keeps only its basename; `computer` its " +
      "first host-name label, lower-cased. `sessionId` (a session the person owns) links the " +
      "conversation to that session as one of its runners. The body is strict: any other field " +
      "(prompt text, pid, tty, paths, tokens, account labels) is refused with 400. Telemetry: never a proposal.",
    request: { body: HeartbeatBodySchema },
    responses: {
      200: { description: "Recorded", schema: HeartbeatResponseSchema },
      400: { description: "Invalid body", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Session not found", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.post("/conversations/heartbeat", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const raw = await c.req.json().catch(() => null);
    const decoded = decodeHeartbeat(raw);
    if (!decoded.ok) {
      return c.json({ error: `Invalid heartbeat: ${decoded.error}` }, 400);
    }
    try {
      const acting = await resolveActingContext(c, {});
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);
      const result = await recordHeartbeat({
        userId: acting.userId,
        agentUserId: (c.get("agentUserId") as string | undefined) ?? null,
        apiKeyId: (c.get("apiKeyId") as string | undefined) ?? null,
        heartbeat: decoded.heartbeat,
      });
      if (!result.ok) return c.json({ error: result.error }, result.status);
      return c.json(result.answer);
    } catch (err) {
      logger.error({ err }, "conversations.heartbeat failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        httpStatusForTrpcError(err) as never
      );
    }
  });
}
