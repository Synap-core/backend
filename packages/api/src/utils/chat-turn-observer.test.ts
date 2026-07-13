import { describe, expect, it } from "vitest";
import {
  notifyChatTurnObserver,
  runWithChatTurnObserver,
} from "./chat-turn-observer.js";

describe("chat turn observer", () => {
  it("observes only broadcasts emitted within its async chat-turn scope", async () => {
    const observed: string[] = [];

    await runWithChatTurnObserver(
      (event) => observed.push(event.event),
      async () => {
        await Promise.resolve();
        notifyChatTurnObserver({
          event: "chat:stream",
          data: { type: "chunk", content: "live" },
          channelId: "channel-1",
        });
      }
    );

    notifyChatTurnObserver({
      event: "chat:stream",
      data: { type: "chunk", content: "outside" },
      channelId: "channel-1",
    });

    expect(observed).toEqual(["chat:stream"]);
  });
});
