/**
 * A wait kind as the mark it wears (`unitStateInputOfWaitKind`,
 * `resolveWaitKindState`): every kind, by its ball, so no surface maps ball →
 * state by hand. And the ONE lead kind of a row (`leadWaitKind`).
 */
import { describe, expect, it } from "vitest";
import { resolveWaitKindState, unitStateInputOfWaitKind } from "./state.js";
import { WAIT_KINDS, WAIT_KIND_BALL } from "./wait-kind.js";
import { leadWaitKind } from "./goal.js";

/** The decided state of each ball; `me` splits answer vs judgement. */
const BALL_STATE = {
  them: ["with_them"],
  machine: ["on_machine"],
  agent: ["working", "paused"],
  thing: ["blocked"],
  date: ["scheduled"],
  nobody: ["paused"],
  me: ["needs_you", "needs_review"],
} as const;

describe("resolveWaitKindState", () => {
  it("every kind wears its ball's state, never the default spark", () => {
    for (const k of WAIT_KINDS) {
      const state = resolveWaitKindState(k).state;
      expect(BALL_STATE[WAIT_KIND_BALL[k]] as readonly string[]).toContain(
        state
      );
    }
  });

  it("an answer is yours, a judgement is a review, an agent at work works", () => {
    expect(resolveWaitKindState("answer")).toMatchObject({
      state: "needs_you",
      glyph: "person",
    });
    expect(resolveWaitKindState("approval")).toMatchObject({
      state: "needs_review",
      glyph: "scales",
    });
    expect(resolveWaitKindState("try_it").state).toBe("needs_review");
    expect(resolveWaitKindState("agent_work").state).toBe("working");
    expect(resolveWaitKindState("agent_stopped").state).toBe("paused");
    expect(resolveWaitKindState("another_work").state).toBe("blocked");
    expect(resolveWaitKindState("date")).toMatchObject({
      state: "scheduled",
      glyph: "clock",
    });
    expect(resolveWaitKindState("nobody").state).toBe("paused");
  });

  it("an unknown kind is unmeasured, never a guess", () => {
    expect(unitStateInputOfWaitKind("nope")).toEqual({ unreadable: true });
    expect(resolveWaitKindState(null).state).toBe("unmeasured");
  });
});

describe("leadWaitKind", () => {
  it("leads with the first ball: yours, then theirs, an agent's, a machine's", () => {
    expect(
      leadWaitKind([
        { refs: [{ waitKind: "ci" }, { waitKind: "their_reply" }] },
        { refs: [{ waitKind: "approval" }] },
      ])
    ).toBe("approval");
    expect(
      leadWaitKind([
        { refs: [{ waitKind: "merge_queue" }, { waitKind: "date" }] },
      ])
    ).toBe("merge_queue");
  });

  it("names nothing when no ref names a known kind", () => {
    expect(leadWaitKind([])).toBeNull();
    expect(leadWaitKind(null)).toBeNull();
    expect(leadWaitKind([{ refs: [{ waitKind: "x" }, {}] }, {}])).toBeNull();
  });
});
