import { describe, expect, it } from "vitest";
import {
  CONNECT_ANSWER_GRACE_MS,
  CONNECT_IDLE,
  CONNECT_WAIT_MINUTES,
  connectNoteWords,
  connectReducer,
  connectSessionCall,
  safeConnectLink,
  type ConnectWait,
} from "./provide-connect";

const t0 = 1_000_000;

function waiting(baseline: string[] = ["c1"]): ConnectWait {
  const starting = connectReducer(CONNECT_IDLE, { type: "start" });
  return connectReducer(starting, {
    type: "started",
    now: t0,
    link: "https://connect.example/s/1",
    blocked: false,
    baseline,
  });
}

describe("connectReducer", () => {
  it("idle → starting → waiting, keeping what could already be picked", () => {
    expect(connectReducer(CONNECT_IDLE, { type: "start" })).toEqual({
      phase: "starting",
    });
    expect(waiting()).toEqual({
      phase: "waiting",
      startedAt: t0,
      baseline: ["c1"],
      link: "https://connect.example/s/1",
      blocked: false,
      newSeenAt: null,
    });
  });

  it("a session that did not start goes back to idle", () => {
    const starting = connectReducer(CONNECT_IDLE, { type: "start" });
    expect(connectReducer(starting, { type: "start_failed" })).toEqual(
      CONNECT_IDLE
    );
  });

  it("a second press while starting or waiting starts nothing", () => {
    const starting = connectReducer(CONNECT_IDLE, { type: "start" });
    expect(connectReducer(starting, { type: "start" })).toBe(starting);
    const w = waiting();
    expect(connectReducer(w, { type: "start" })).toBe(w);
  });

  it("nothing new yet: keeps waiting", () => {
    const w = waiting();
    expect(
      connectReducer(w, { type: "tick", now: t0 + 4_000, rowIds: ["c1"] })
    ).toBe(w);
  });

  it("a new account still not answering after the grace: stop, and say so", () => {
    const seen = connectReducer(waiting(), {
      type: "tick",
      now: t0 + 4_000,
      rowIds: ["c1", "c2"],
    });
    expect(seen).toMatchObject({ phase: "waiting", newSeenAt: t0 + 4_000 });
    expect(
      connectReducer(seen, {
        type: "tick",
        now: t0 + 4_000 + CONNECT_ANSWER_GRACE_MS - 1,
        rowIds: ["c1", "c2"],
      })
    ).toBe(seen);
    expect(
      connectReducer(seen, {
        type: "tick",
        now: t0 + 4_000 + CONNECT_ANSWER_GRACE_MS,
        rowIds: ["c1", "c2"],
      })
    ).toEqual({ phase: "idle", note: "connected_unanswered" });
  });

  it("gives up with the pod's pending connect", () => {
    expect(
      connectReducer(waiting(), {
        type: "tick",
        now: t0 + CONNECT_WAIT_MINUTES * 60_000 + 1,
        rowIds: ["c1"],
      })
    ).toEqual({ phase: "idle", note: "expired" });
  });

  it("the person can stop waiting", () => {
    expect(connectReducer(waiting(), { type: "cancel" })).toEqual(CONNECT_IDLE);
  });

  it("a tick outside a wait changes nothing", () => {
    expect(
      connectReducer(CONNECT_IDLE, { type: "tick", now: t0, rowIds: ["x"] })
    ).toBe(CONNECT_IDLE);
  });
});

describe("connect words and calls", () => {
  it("notes in words", () => {
    expect(connectNoteWords(null, "Stripe")).toBeNull();
    expect(connectNoteWords("connected_unanswered", "Stripe")).toMatch(
      /^Your Stripe account is connected, but this question is still open/
    );
    expect(connectNoteWords("expired", "Stripe")).toMatch(
      /did not finish in time/
    );
  });

  it("the session is pinned to the asked integration and answers the slot", () => {
    expect(
      connectSessionCall({
        providerId: "stripe",
        sessionId: "s1",
        expectedLabel: "Connect Stripe",
        askFingerprint: "fp",
      })
    ).toEqual({
      providerId: "stripe",
      answerFor: {
        sessionId: "s1",
        expectedLabel: "Connect Stripe",
        askFingerprint: "fp",
      },
    });
  });

  it("only a web address is ever opened", () => {
    expect(safeConnectLink("https://connect.nango.dev/?session_token=x")).toBe(
      "https://connect.nango.dev/?session_token=x"
    );
    expect(safeConnectLink("javascript:alert(1)")).toBeNull();
    expect(safeConnectLink("/relative")).toBeNull();
    expect(safeConnectLink(undefined)).toBeNull();
  });
});
