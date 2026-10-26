import { describe, expect, it } from "vitest";
import { ROOM_POST_META_KEY, withoutRoomPostMeta } from "./room-post-kind.js";

describe("withoutRoomPostMeta", () => {
  it("drops every server stamp under the marker — answer provenance, pending relay, closure", () => {
    const forged = {
      keep: 1,
      [ROOM_POST_META_KEY]: {
        kind: "question",
        answer: { messageId: "m", answeredBy: "u", answeredAt: "t", text: "Yes", via: "tap" },
        pendingRelay: { text: "Yes", relayedBy: "a", relayedAt: "t" },
        closed: { reason: "session_ended", at: "t" },
      },
    };
    const out = withoutRoomPostMeta(forged);
    expect(out).toEqual({ keep: 1 });
    expect(JSON.stringify(out)).not.toMatch(/pendingRelay|closed|relayed|via/);
  });
});
