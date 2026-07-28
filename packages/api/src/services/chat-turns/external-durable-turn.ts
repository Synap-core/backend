/**
 * Durable chat_turns for external streaming doors
 * (`/api/external/chat/stream`, `/v1/chat/completions`).
 *
 * Founder chose full ledger for external AI (not ephemeral-only): every
 * external turn reserves a row before the IS (or custom provider) call and
 * finishes completed/failed after the response drains or errors.
 *
 * Reuses the same createOrGet + finish helpers as Companion sendMessage so
 * the journal is one table, not a parallel agent_runs concept.
 */

import { randomUUID } from "node:crypto";
import { computeMessageHash } from "@synap/database";
import { MessageRole, messages } from "@synap/database/schema";
import {
  createOrGetChatTurnWithUserMessage,
  finishChatTurn,
  type DurableChatTurn,
} from "./chat-turn-store.js";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "external-durable-turn" });

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Accept a client-supplied UUID request id; otherwise allocate one. */
export function resolveExternalRequestId(
  headerValue: string | undefined,
  bodyValue: string | undefined
): string {
  if (bodyValue && UUID_RE.test(bodyValue)) return bodyValue;
  if (headerValue && UUID_RE.test(headerValue)) return headerValue;
  return randomUUID();
}

export type ExternalTurnSource =
  "external_chat" | "openai_compat" | "openai_compat_custom";

/**
 * Reserve an idempotent turn + user message after channel/user are known and
 * before any upstream AI call.
 */
export async function beginExternalDurableTurn(input: {
  channelId: string;
  userId: string;
  requestId: string;
  content: string;
  source: ExternalTurnSource;
}): Promise<{ turn: DurableChatTurn; created: boolean }> {
  const userMessageId = randomUUID();
  const assistantMessageId = randomUUID();
  const hash = computeMessageHash(userMessageId, input.content);

  return createOrGetChatTurnWithUserMessage({
    turn: {
      channelId: input.channelId,
      userId: input.userId,
      requestId: input.requestId,
      userMessageId,
      assistantMessageId,
    },
    userMessage: {
      id: userMessageId,
      channelId: input.channelId,
      role: MessageRole.USER,
      content: input.content,
      userId: input.userId,
      previousHash: "",
      hash,
      metadata: {
        source: input.source,
        externalDurableTurn: true,
      } as (typeof messages.$inferInsert)["metadata"],
    },
  });
}

/** Best-effort terminal update — never throws into the HTTP path. */
export async function safeFinishExternalTurn(input: {
  turnId: string;
  status: "completed" | "failed" | "cancelled";
  error?: string;
}): Promise<void> {
  try {
    await finishChatTurn(input);
  } catch (err) {
    logger.error(
      {
        err: err instanceof Error ? err.message : String(err),
        turnId: input.turnId,
        status: input.status,
      },
      "Failed to finish external chat turn"
    );
  }
}

/**
 * Pipe an upstream body while finishing the durable turn when the stream ends,
 * errors, or the client disconnects (ReadableStream cancel).
 *
 * Optionally prefixes a first SSE frame (Synap-native doors only — OpenAI
 * wire format must not receive non-OAI events).
 */
export function wrapUpstreamStreamWithTurnLifecycle(input: {
  upstream: ReadableStream<Uint8Array>;
  turnId: string;
  /** When set, enqueued once before upstream bytes. */
  leadingSseFrame?: string;
}): ReadableStream<Uint8Array> {
  const reader = input.upstream.getReader();
  const encoder = new TextEncoder();
  let finished = false;

  const finishOnce = (status: "completed" | "failed", error?: string) => {
    if (finished) return;
    finished = true;
    void safeFinishExternalTurn({
      turnId: input.turnId,
      status,
      error,
    });
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      if (input.leadingSseFrame) {
        try {
          controller.enqueue(encoder.encode(input.leadingSseFrame));
        } catch {
          finishOnce("failed", "client disconnected before first frame");
          try {
            await reader.cancel();
          } catch {
            /* ignore */
          }
          try {
            controller.close();
          } catch {
            /* ignore */
          }
          return;
        }
      }

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
        finishOnce("completed");
        controller.close();
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "upstream stream failed";
        finishOnce("failed", message);
        try {
          controller.error(err);
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {
      finishOnce("failed", "client disconnected");
      void reader.cancel().catch(() => undefined);
    },
  });
}

/** Header name used by both external doors for clients that read metadata. */
export const SYNAP_TURN_ID_HEADER = "X-Synap-Turn-Id";
