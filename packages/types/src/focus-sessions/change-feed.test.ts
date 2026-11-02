import { describe, expect, it } from "vitest";
import {
  SESSION_CHANGE_KINDS,
  SESSION_CHANGE_WAKE,
  WAKING_SESSION_CHANGE_KINDS,
  isPauseResumed,
  isWakeWorthy,
} from "./change-feed.js";

const AGENT = "agent-1";
const me = { agentUserId: AGENT };
const resume = { from: "paused", category: "active", actor: "system" };

describe("the change feed's one wake rule (plan 07f8a997 W1)", () => {
  it("classifies every kind, and only the kinds", () => {
    expect(Object.keys(SESSION_CHANGE_WAKE).sort()).toEqual(
      [...SESSION_CHANGE_KINDS].sort()
    );
  });

  it("the waking kinds are the plan's §9 defaults; stage_moved and hold_set never wake", () => {
    expect([...WAKING_SESSION_CHANGE_KINDS].sort()).toEqual(
      [
        "answer",
        "blocker_ended",
        "checks_finished",
        "owner_message",
        "pr_closed",
        "pr_merged",
        "proposal_decided",
        "session_message",
        "signal_raised",
        "status_moved",
      ].sort()
    );
    expect(isWakeWorthy({ kind: "stage_moved" }, me)).toBe(false);
    expect(isWakeWorthy({ kind: "hold_set", move: resume }, me)).toBe(false);
  });

  it("always-kinds wake for anyone", () => {
    for (const kind of [
      "owner_message",
      "pr_merged",
      "pr_closed",
      "checks_finished",
      "blocker_ended",
      "signal_raised",
    ]) {
      expect(isWakeWorthy({ kind }, me)).toBe(true);
      expect(isWakeWorthy({ kind })).toBe(true);
    }
  });

  it("a session_message wakes only when the post door said so", () => {
    expect(isWakeWorthy({ kind: "session_message", wake: true }, me)).toBe(
      true
    );
    expect(isWakeWorthy({ kind: "session_message", wake: false }, me)).toBe(
      false
    );
    expect(isWakeWorthy({ kind: "session_message" }, me)).toBe(false);
    expect(isWakeWorthy({ kind: "session_message", wake: "true" }, me)).toBe(
      false
    );
  });

  it("an answer or a decision the reading agent caused itself does not wake it (finding bd970b41)", () => {
    expect(
      isWakeWorthy({ kind: "answer", answer: { relayedBy: AGENT } }, me)
    ).toBe(false);
    expect(
      isWakeWorthy({ kind: "answer", answer: { relayedBy: "other" } }, me)
    ).toBe(true);
    expect(
      isWakeWorthy({ kind: "answer", answer: { relayedBy: null } }, me)
    ).toBe(true);
    // A person reading (no agent) is never "the one who relayed".
    expect(isWakeWorthy({ kind: "answer", answer: { relayedBy: AGENT } })).toBe(
      true
    );
    expect(
      isWakeWorthy(
        { kind: "proposal_decided", proposal: { decidedBy: AGENT } },
        me
      )
    ).toBe(false);
    expect(
      isWakeWorthy(
        { kind: "proposal_decided", proposal: { decidedBy: "person" } },
        me
      )
    ).toBe(true);
    expect(
      isWakeWorthy(
        { kind: "proposal_decided", proposal: { decidedBy: null } },
        me
      )
    ).toBe(true);
  });

  it("a status move wakes only when the system resumed a pause to a live status", () => {
    expect(isWakeWorthy({ kind: "status_moved", move: resume }, me)).toBe(true);
    expect(
      isWakeWorthy(
        { kind: "status_moved", move: { ...resume, category: "open" } },
        me
      )
    ).toBe(true);
    for (const move of [
      { ...resume, actor: "agent" },
      { ...resume, actor: "human" },
      { ...resume, from: "active", category: "paused" },
      { ...resume, from: "stale" },
      // The reaper's paused -> stale: category paused.
      { ...resume, category: "paused" },
      { ...resume, category: "done" },
      null,
    ]) {
      expect(isWakeWorthy({ kind: "status_moved", move }, me)).toBe(false);
      expect(isPauseResumed(move)).toBe(false);
    }
  });

  it("an unknown kind never wakes (a newer pod's kind is news, not a doorbell)", () => {
    expect(isWakeWorthy({ kind: "wait_met" }, me)).toBe(false);
    expect(isWakeWorthy({ kind: "toString" }, me)).toBe(false);
    expect(isWakeWorthy({ kind: "__proto__" }, me)).toBe(false);
  });
});
