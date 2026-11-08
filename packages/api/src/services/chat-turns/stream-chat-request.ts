/**
 * The ONE chat stream handler (`POST …/stream`), shared by the external API
 * (`/api/external/chat/stream`, an API key with `chat.stream`) and the Hub
 * door (`/api/hub/chat/stream`, an app's grant). Same behaviour on both: the
 * durable `chat_turns` ledger, the IS proxy, the IS credentials never leave the
 * pod. The two callers differ only in two hooks:
 *   - `authorizeTarget`: a narrower caller (an app's grant) may refuse the
 *     resolved workspace/channel (403);
 *   - `appGrant`: set for an app, the per-turn IS token then carries the app's
 *     grant and a signing failure refuses the turn (never the stored key).
 */

import type { Context, Env } from "hono";
import { z } from "zod";
import {
  db,
  isDelegationHeaders,
  mintIsDelegationToken,
  IS_DELEGATION_HEADER,
} from "@synap/database";
import { getPodCallback } from "../../utils/pod-callback.js";
import { resolveIntelligenceService } from "../../utils/intelligence-routing.js";
import { createLogger } from "@synap-core/core";
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
import { resolveChatTarget } from "../../utils/resolve-chat-target.js";

const logger = createLogger({ module: "external-chat" });

export const streamBodySchema = z.object({
  query: z.string().min(1, "query is required"),
  channelId: z.string().uuid().optional(),
  workspaceId: z.string().uuid().optional(),
  agentType: z.string().optional(),
  /** Client idempotency key (UUID). Also accepted via X-Request-Id header. */
  requestId: z.string().uuid().optional(),
});

export interface ChatStreamTarget {
  workspaceId: string;
  channelId: string;
}

export interface ChatStreamOptions {
  /** The person the turn runs as (the key's effective user). */
  userId: string;
  /** Refuse a resolved target the caller's grant does not reach. */
  authorizeTarget?: (target: ChatStreamTarget) => boolean;
  /**
   * The app's grant claim, when the caller is an app. The turn's IS token then
   * carries it and cannot be built without it: a signing failure refuses the
   * turn (503) instead of letting the IS use the stored full-access key.
   * Unset (an API key): the person's own token, as the external door always did.
   */
  appGrant?: Record<string, unknown> | null;
}

export async function handleChatStream<E extends Env>(
  c: Context<E>,
  opts: ChatStreamOptions
): Promise<Response> {
  const { userId, authorizeTarget, appGrant } = opts;

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

  // ── Steps 1-2: Resolve workspace + channel ──────────────────────────────
  // The ONE resolver, shared with `/api/chat/stream`: an explicit channelId
  // must be an ACTIVE channel the caller can read (never resolved by id
  // alone), and a refusal is a 404 that does not reveal the channel exists.
  const target = await resolveChatTarget(db, userId, {
    workspaceId: input.workspaceId,
    channelId: input.channelId,
  });
  if (!target.ok) {
    return c.json({ error: target.error }, target.status);
  }
  const resolvedWorkspaceId = target.workspaceId;
  const resolvedChannelId = target.channelId;
  // A caller narrower than the user (an app's grant) may refuse the target.
  if (authorizeTarget && !authorizeTarget(target)) {
    return c.json(
      { error: "This chat is outside the grant this app holds" },
      403
    );
  }

  // ── Step 3: Reserve durable chat_turn ────────────────────────────────────
  const requestId = resolveExternalRequestId(
    c.req.header("x-request-id") ?? c.req.header("X-Request-Id"),
    input.requestId
  );

  let durableTurn: Awaited<ReturnType<typeof beginExternalDurableTurn>>["turn"];
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

  // The turn's delegation headers. An app's token throws when it cannot be
  // signed and the turn is refused (503): the IS must never fall back to a
  // stored full-access key for an app. (`isDelegationHeaders` returns {} on a
  // signing failure, which is that fallback, so an app never uses it.)
  let delegationHeaders: Record<string, string>;
  try {
    const turn = {
      isUrl,
      operatorUserId: userId,
      channelId: resolvedChannelId,
      runId: durableTurn.id,
    };
    delegationHeaders = appGrant
      ? {
          [IS_DELEGATION_HEADER]: mintIsDelegationToken({ ...turn, appGrant }),
        }
      : isDelegationHeaders(turn);
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "Failed to sign the chat turn delegation"
    );
    await safeFinishExternalTurn({
      turnId: durableTurn.id,
      status: "failed",
      error: "Intelligence service delegation unavailable",
    });
    return c.json(
      { error: "Intelligence service unavailable", turnId: durableTurn.id },
      503,
      { [SYNAP_TURN_ID_HEADER]: durableTurn.id }
    );
  }

  // ── Step 6: Proxy to IS and stream SSE back ──────────────────────────────
  let isResponse: Response;
  try {
    isResponse = await fetch(`${isUrl}/api/chat/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": isApiKey,
        "X-Synap-Channel": "api",
        // D4: this turn's hub calls run on a per-turn token (built by the caller).
        ...delegationHeaders,
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
