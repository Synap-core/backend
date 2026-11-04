import { describe, expect, it } from "vitest";
import {
  ROUTE_CHOICE_META_KEY,
  SERVER_OWNED_MESSAGE_META_KEYS,
  SESSION_POST_META_KEY,
  withoutServerOwnedMessageMeta,
} from "./index.js";
import { ROOM_POST_META_KEY } from "../ask/index.js";

describe("withoutServerOwnedMessageMeta", () => {
  it("names the three stamps only the pod writes", () => {
    expect([...SERVER_OWNED_MESSAGE_META_KEYS].sort()).toEqual(
      [ROOM_POST_META_KEY, ROUTE_CHOICE_META_KEY, SESSION_POST_META_KEY].sort()
    );
  });

  it("drops a forged route choice, room post and session post; keeps the rest", () => {
    const forged = {
      [ROUTE_CHOICE_META_KEY]: {
        triggerMessageId: "m1",
        candidates: [{ agentUserId: "a" }, { agentUserId: "b" }],
      },
      [ROOM_POST_META_KEY]: { kind: "question", answer: { text: "yes" } },
      [SESSION_POST_META_KEY]: { intent: "handoff", wake: true },
      agentType: "meta",
      anchor: { proposalId: "p" },
    };
    expect(withoutServerOwnedMessageMeta(forged)).toEqual({
      agentType: "meta",
      anchor: { proposalId: "p" },
    });
    // The caller's object is never mutated.
    expect(forged).toHaveProperty(ROUTE_CHOICE_META_KEY);
  });

  it("leaves metadata without a stamp as it was", () => {
    const m = { anchor: 1 };
    expect(withoutServerOwnedMessageMeta(m)).toBe(m);
    expect(withoutServerOwnedMessageMeta(undefined)).toBeUndefined();
    expect(withoutServerOwnedMessageMeta(null)).toBeNull();
  });
});
