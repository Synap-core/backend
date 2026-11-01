/**
 * Rule 5 of the push decision, pure: which sessions a notification is ABOUT
 * (`notificationSessionIds`), and the mute's verdict (`withSessionMute`).
 * The reads (a proposal's session, a room's session) and the door itself are
 * pinned on PGlite in `__tests__/session-mute.pglite.test.ts`.
 */
import { describe, it, expect } from "vitest";
import {
  decidePush,
  notificationSessionIds,
  pushAboutMutedSession,
  withSessionMute,
} from "./push-decision.js";

const S = "22222222-2222-4222-8222-222222222222";
const T = "33333333-3333-4333-8333-333333333333";

describe("notificationSessionIds", () => {
  it("reads a session source, a session or owed target, data.sessionId and the session thread", () => {
    expect(
      notificationSessionIds({ sourceType: "session", sourceId: S })
    ).toEqual([S]);
    expect(
      notificationSessionIds({
        sourceType: "agent",
        target: { kind: "owed", id: S },
      })
    ).toEqual([S]);
    expect(
      notificationSessionIds({
        sourceType: "system",
        data: { sessionId: S.toUpperCase() },
      })
    ).toEqual([S]);
    expect(
      notificationSessionIds({ sourceType: "agent", push: { threadId: T } })
    ).toEqual([T]);
  });

  it("names no session for a non-session source, a non-uuid id or an entity target", () => {
    expect(
      notificationSessionIds({ sourceType: "entity", sourceId: S })
    ).toEqual([]);
    expect(
      notificationSessionIds({ sourceType: "session", sourceId: "s-1" })
    ).toEqual([]);
    expect(
      notificationSessionIds({
        sourceType: "agent",
        target: { kind: "entity", id: S },
      })
    ).toEqual([]);
  });
});

describe("withSessionMute", () => {
  const earned = decidePush({
    type: "session.needs_you",
    typeRule: undefined,
    facts: {},
    prefs: {},
  });
  it("holds back any push about a muted session, an ask too", () => {
    expect(earned).toMatchObject({ push: true, category: "blocking-ask" });
    expect(withSessionMute(earned, true)).toEqual({
      push: false,
      category: "blocking-ask",
      reason: "session_muted",
    });
    expect(withSessionMute(earned, false)).toBe(earned);
  });

  it("never holds what the person sent to their own phone", () => {
    const sent = decidePush({
      type: "handoff.to_phone",
      typeRule: undefined,
      facts: {},
      prefs: {},
    });
    expect(withSessionMute(sent, true)).toBe(sent);
  });

  it("nothing muted reads nothing: the lookup is free", async () => {
    expect(
      await pushAboutMutedSession({ sourceType: "proposal", sourceId: S }, [])
    ).toBe(false);
    expect(
      await pushAboutMutedSession({ sourceType: "session", sourceId: S }, [S])
    ).toBe(true);
  });
});
