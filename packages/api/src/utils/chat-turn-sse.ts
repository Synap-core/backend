import { EventNames } from "@synap-core/types/events";
import { randomUUID } from "node:crypto";
import { SERVER_CONVERSATION_EVENTS } from "../realtime/socket-events.js";
import type { ChatBroadcastOptions } from "./chat-realtime-broadcast.js";

export type ChatTurnFrameType =
  | "start"
  | "step"
  | "delta"
  | "proposal"
  | "complete"
  | "error";

export type ChatTurnFrame = {
  type: ChatTurnFrameType;
  seq: number;
  /** Stable dedupe identity, persisted in chat_turn_events. */
  eventId: string;
  turnId: string;
  channelId: string;
  [key: string]: unknown;
};

type ChatTurnFrameInput = {
  type: ChatTurnFrameType;
  [key: string]: unknown;
};

/**
 * Converts the existing in-process chat broadcast contract into the sender
 * SSE contract. Socket complete is intentionally ignored: it precedes durable
 * assistant persistence, while `complete()` below is emitted after it.
 */
export function createChatTurnFrameSequencer() {
  let seq = 0;
  let turnId: string | undefined;
  let channelId: string | undefined;
  let userMessageId: string | undefined;
  let assistantMessageId: string | undefined;

  const frame = (value: ChatTurnFrameInput): ChatTurnFrame => ({
    ...value,
    seq: ++seq,
    eventId: randomUUID(),
    // `fromBroadcast` drops events before start, so these are always set.
    turnId: turnId ?? "",
    channelId: channelId ?? "",
    ...(assistantMessageId ? { assistantMessageId } : {}),
  });

  return {
    fromBroadcast({
      event,
      data,
    }: ChatBroadcastOptions): ChatTurnFrame | undefined {
      if (event === EventNames.CHAT_STREAM) {
        if (data.type === "start") {
          const triggerMessageId = data.triggerMessageId;
          if (typeof triggerMessageId !== "string") return undefined;
          turnId =
            typeof data.turnId === "string" ? data.turnId : triggerMessageId;
          channelId =
            typeof data.threadId === "string" ? data.threadId : undefined;
          userMessageId =
            typeof data.userMessageId === "string"
              ? data.userMessageId
              : triggerMessageId;
          assistantMessageId =
            typeof data.assistantMessageId === "string"
              ? data.assistantMessageId
              : undefined;
          return frame({
            type: "start",
            triggerMessageId,
            userMessageId,
            assistantMessageId,
          });
        }
        if (
          (data.type === "chunk" || data.type === "delta") &&
          typeof data.content === "string"
        ) {
          return frame({
            type: "delta",
            content: data.content,
          });
        }
        if (data.type === "step") {
          return frame({ type: "step", step: data.step });
        }
        if (data.type === "proposal") {
          const proposal =
            data.proposal && typeof data.proposal === "object"
              ? (data.proposal as Record<string, unknown>)
              : data;
          return frame({
            type: "proposal",
            proposalId: proposal.proposalId,
            toolName: proposal.toolName,
            description: proposal.description,
          });
        }
        return undefined;
      }

      if (event === SERVER_CONVERSATION_EVENTS.AI_STEP) {
        if (typeof data.turnId === "string") return undefined;
        return frame({
          type: "step",
          step: data.step,
        });
      }

      if (event === EventNames.AI_PROPOSAL) {
        if (typeof data.turnId === "string") return undefined;
        return frame({
          type: "proposal",
          proposalId: data.proposalId,
          toolName: data.toolName,
          description: data.description,
        });
      }

      if (event === SERVER_CONVERSATION_EVENTS.CHAT_STREAM_ERROR) {
        // `channels.sendMessage` broadcasts fallback progress and legacy
        // errors. The canonical HTTP route owns its one terminal error after
        // the procedure resolves/rejects; forwarding these would either mark
        // a safe fallback terminal too early or duplicate the terminal frame.
        return undefined;
      }

      return undefined;
    },

    complete(result: {
      channelId: string;
      messageId: string;
      [key: string]: unknown;
    }): ChatTurnFrame {
      if (typeof result.turnId === "string") turnId = result.turnId;
      if (typeof result.channelId === "string") channelId = result.channelId;
      if (typeof result.userMessageId === "string") {
        userMessageId = result.userMessageId;
      }
      if (typeof result.assistantMessageId === "string") {
        assistantMessageId = result.assistantMessageId;
      } else if (typeof result.messageId === "string") {
        assistantMessageId = result.messageId;
      }
      return frame({
        type: "complete",
        ...result,
        triggerMessageId: userMessageId,
        userMessageId,
        assistantMessageId,
      });
    },

    error(error: unknown): ChatTurnFrame {
      return frame({
        type: "error",
        recoverable: false,
        message: error instanceof Error ? error.message : "Chat turn failed",
      });
    },
  };
}

/**
 * AI SDK UI Message Stream v1-compatible encoding. `data-synap-turn` is an
 * extension data part carrying Synap's durable ids/sequence; standard text and
 * finish parts keep generic AI SDK consumers useful without teaching them our
 * governance model.
 */
export function encodeAiSdkUiMessageStreamFrame(frame: ChatTurnFrame): string {
  const dataPart = {
    type: "data-synap-turn",
    id: frame.eventId,
    data: frame,
  };
  const parts: Array<Record<string, unknown> | "[DONE]"> = [dataPart];

  if (frame.type === "start") {
    // UI Message Stream v1 requires a text block to be opened before its first
    // text-delta. Open the one stable assistant block with the turn itself so
    // a generic AI SDK consumer can immediately accept a later delta.
    const textId = frame.assistantMessageId ?? frame.turnId;
    parts.unshift(
      { type: "start", messageId: frame.assistantMessageId ?? frame.turnId },
      { type: "text-start", id: textId }
    );
  } else if (frame.type === "delta") {
    parts.unshift({
      type: "text-delta",
      id: frame.assistantMessageId ?? frame.turnId,
      delta: frame.content,
    });
  } else if (frame.type === "complete") {
    parts.unshift({
      type: "text-end",
      id: frame.assistantMessageId ?? frame.turnId,
    });
    parts.push({ type: "finish", finishReason: "stop" }, "[DONE]");
  } else if (frame.type === "error") {
    parts.push({ type: "error", errorText: frame.message }, "[DONE]");
  }

  return parts
    .map(
      (part) =>
        `data: ${typeof part === "string" ? part : JSON.stringify(part)}\n\n`
    )
    .join("");
}
