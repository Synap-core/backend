/**
 * The coordination-post codec: the reader accepts only a whole stamp (a
 * malformed one never addresses or wakes a session), and the strip removes a
 * caller's forged copy while keeping everything else it sent.
 */
import { describe, expect, it } from "vitest";
import {
  SESSION_POST_META_KEY,
  isWakeWorthySessionPostIntent,
  readSessionPost,
  withoutSessionPostMeta,
} from "./index.js";

const FROM = "11111111-1111-4111-8111-111111111111";
const TO = "22222222-2222-4222-8222-222222222222";
const AGENT = "33333333-3333-4333-8333-333333333333";

const stamp = (over: Record<string, unknown> = {}) => ({
  intent: "handoff",
  from: {
    sessionId: FROM,
    agentUserId: AGENT,
    harness: "claude-code",
    conversationId: "abc",
  },
  to: { sessionId: TO },
  hop: 0,
  wake: true,
  ...over,
});

describe("readSessionPost", () => {
  it("reads a whole stamp back", () => {
    expect(
      readSessionPost({
        [SESSION_POST_META_KEY]: stamp({
          refs: [{ kind: "slot", id: TO, label: "API key" }],
          cause: "m1",
          hop: 1,
        }),
      })
    ).toEqual({
      ...stamp({ hop: 1 }),
      refs: [{ kind: "slot", id: TO, label: "API key" }],
      cause: "m1",
    });
  });

  it.each([
    ["no stamp", {}],
    ["an unknown intent", { [SESSION_POST_META_KEY]: stamp({ intent: "x" }) }],
    [
      "no target",
      { [SESSION_POST_META_KEY]: stamp({ to: { sessionId: "" } }) },
    ],
    [
      "no sender agent",
      {
        [SESSION_POST_META_KEY]: stamp({ from: { sessionId: FROM } }),
      },
    ],
  ])("%s reads as null", (_name, metadata) => {
    expect(readSessionPost(metadata)).toBeNull();
  });

  it("wake is true only when stamped true", () => {
    expect(
      readSessionPost({ [SESSION_POST_META_KEY]: stamp({ wake: "yes" }) })?.wake
    ).toBe(false);
  });

  it("drops refs it cannot read, keeps the rest", () => {
    expect(
      readSessionPost({
        [SESSION_POST_META_KEY]: stamp({
          refs: [
            { kind: "nope", id: "x" },
            { kind: "proposal", id: "p1" },
          ],
        }),
      })?.refs
    ).toEqual([{ kind: "proposal", id: "p1" }]);
  });
});

describe("withoutSessionPostMeta", () => {
  it("removes a caller's stamp and keeps the rest", () => {
    expect(
      withoutSessionPostMeta({ [SESSION_POST_META_KEY]: stamp(), anchor: 1 })
    ).toEqual({ anchor: 1 });
  });
  it("leaves metadata without a stamp as it was", () => {
    const m = { anchor: 1 };
    expect(withoutSessionPostMeta(m)).toBe(m);
    expect(withoutSessionPostMeta(undefined)).toBeUndefined();
  });
});

describe("wake-worthy intents", () => {
  it.each([
    ["blocked_on_you", true],
    ["handoff", true],
    ["done", false],
    ["fyi", false],
    [null, false],
  ])("%s → %s", (intent, wakes) => {
    expect(isWakeWorthySessionPostIntent(intent)).toBe(wakes);
  });
});
