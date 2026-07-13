import { describe, expect, it } from "vitest";
import { EventNames } from "@synap-core/types/events";
import { SERVER_CONVERSATION_EVENTS } from "../realtime/socket-events.js";
import {
  createChatTurnFrameSequencer,
  encodeAiSdkUiMessageStreamFrame,
} from "./chat-turn-sse.js";

describe("chat turn SSE contract", () => {
  it("keeps typed sender frames ordered and completes only after persistence", () => {
    const frames = createChatTurnFrameSequencer();

    expect(
      frames.fromBroadcast({
        event: EventNames.CHAT_STREAM,
        data: {
          type: "start",
          threadId: "channel-1",
          triggerMessageId: "user-message-1",
        },
      })
    ).toMatchObject({ type: "start", seq: 1, turnId: "user-message-1" });

    expect(
      frames.fromBroadcast({
        event: SERVER_CONVERSATION_EVENTS.AI_STEP,
        data: { threadId: "channel-1", step: { type: "tool", name: "search" } },
      })
    ).toMatchObject({ type: "step", seq: 2, turnId: "user-message-1" });

    expect(
      frames.fromBroadcast({
        event: EventNames.CHAT_STREAM,
        data: { type: "chunk", threadId: "channel-1", content: "Hello" },
      })
    ).toMatchObject({ type: "delta", seq: 3, content: "Hello" });

    // A legacy fallback notice is progress, not a terminal sender frame. The
    // canonical route emits exactly one terminal event after the procedure ends.
    expect(
      frames.fromBroadcast({
        event: SERVER_CONVERSATION_EVENTS.CHAT_STREAM_ERROR,
        data: { threadId: "channel-1", fallback: true, error: "retrying" },
      })
    ).toBeUndefined();

    // The legacy socket completion happens before assistant persistence and
    // must not terminate the sender stream.
    expect(
      frames.fromBroadcast({
        event: EventNames.CHAT_STREAM,
        data: { type: "complete", threadId: "channel-1", isComplete: true },
      })
    ).toBeUndefined();

    expect(
      frames.complete({
        channelId: "channel-1",
        messageId: "assistant-message-1",
        content: "Hello",
        entities: [],
        branchDecision: undefined,
        createdProposals: [],
      })
    ).toMatchObject({
      type: "complete",
      seq: 4,
      turnId: "user-message-1",
      messageId: "assistant-message-1",
    });
  });
});

it("opens the stable text part before encoding AI SDK deltas", () => {
  const start = encodeAiSdkUiMessageStreamFrame({
    type: "start",
    seq: 1,
    eventId: "event-1",
    turnId: "turn-1",
    channelId: "channel-1",
    assistantMessageId: "assistant-1",
    triggerMessageId: "user-1",
  });
  const delta = encodeAiSdkUiMessageStreamFrame({
    type: "delta",
    seq: 2,
    eventId: "event-2",
    turnId: "turn-1",
    channelId: "channel-1",
    assistantMessageId: "assistant-1",
    content: "Hello",
  });

  expect(start).toContain('"type":"start"');
  expect(start).toContain('"type":"text-start"');
  expect(start).toContain('"id":"assistant-1"');
  expect(delta).toContain('"type":"text-delta"');
  expect(delta).toContain('"id":"assistant-1"');
  expect(delta).toContain('"type":"data-synap-turn"');
  expect(delta).toContain('"eventId":"event-2"');
});
