/**
 * The plan's steps as marks: the projection over THE shared readiness rule.
 * The rule itself is pinned in `@synap-core/types/units`
 * (`step-readiness-graph.test.ts`); these rows pin what pod admin adds: which
 * nodes are steps, and that every state is a glyph AND a word, never colour
 * alone.
 */
import { describe, expect, it } from "vitest";
import { STEP_READINESS_STATES } from "@synap-core/types/units";
import {
  READINESS_MARKS,
  planSteps,
  readinessMark,
  readinessWord,
  type PlanGraph,
  type PlanGraphNode,
} from "./plan-steps-model";

const ROOT = "root";
const NOW = Date.UTC(2026, 10, 27, 12);

const node = (id: string, o: Partial<PlanGraphNode> = {}): PlanGraphNode => ({
  id,
  status: "active",
  inWindow: true,
  parentSessionId: ROOT,
  ...o,
});

const rowsOf = (graph: PlanGraph) => {
  const out = planSteps(graph, ROOT, NOW);
  if (out.state !== "ok") throw new Error("no steps");
  return out.rows;
};

describe("a readiness mark", () => {
  it("covers every state of the rule: one word, one glyph, no state twice", () => {
    expect(READINESS_MARKS.map((m) => m.state)).toEqual([
      ...STEP_READINESS_STATES,
    ]);
    const words = STEP_READINESS_STATES.map(readinessWord);
    expect(new Set(words).size).toBe(STEP_READINESS_STATES.length);
    // Rules out colour alone: no two states share a glyph, so a reader who
    // cannot tell the tones apart still has the glyph and the word.
    expect(new Set(READINESS_MARKS.map((m) => m.glyph)).size).toBe(
      STEP_READINESS_STATES.length
    );
    expect(readinessMark("blocked").wordKey).toBe("readiness.blocked");
  });

  it("says each state in the person's words", () => {
    expect(STEP_READINESS_STATES.map(readinessWord)).toEqual([
      "Planned",
      "Ready",
      "Blocked",
      "Active",
      "Done",
      "Skipped",
      "Dropped",
    ]);
  });
});

describe("planSteps", () => {
  it("draws the steps the root spawned, each with the rule's readiness", () => {
    const rows = rowsOf({
      nodes: [
        node("a", { status: "closed", closedAs: "done", title: "Draft" }),
        node("b", { status: "forming", title: "Review" }),
        node("c", { status: "forming", plannedFor: "2099-01", goal: "Ship" }),
        node("d", { status: "closed", closedAs: "not_done" }),
      ],
      edges: [{ kind: "blocked_by", from: "b", to: "a" }],
    });
    expect(rows.map((r) => [r.id, r.mark.state])).toEqual([
      ["a", "done"],
      ["b", "ready"],
      ["c", "planned"],
      ["d", "dropped"],
    ]);
    expect(rows.map((r) => r.title)).toEqual([
      "Draft",
      "Review",
      "Ship",
      "Untitled step",
    ]);
  });

  it("a step waiting on one still running is planned; on a dropped one, blocked", () => {
    const rows = rowsOf({
      nodes: [
        node("run", { status: "active" }),
        node("dead", { status: "cancelled", closedAs: "not_done" }),
        node("waits", { status: "forming" }),
        node("stuck", { status: "forming" }),
      ],
      edges: [
        { kind: "blocked_by", from: "waits", to: "run" },
        { kind: "blocked_by", from: "stuck", to: "dead" },
      ],
    });
    const state = (id: string) => rows.find((r) => r.id === id)!.mark.state;
    expect(state("waits")).toBe("planned");
    expect(state("stuck")).toBe("blocked");
  });

  it("leaves out the root, a far end, and a session another step spawned", () => {
    const rows = rowsOf({
      nodes: [
        node("root", { parentSessionId: null }),
        node("step"),
        node("far", { inWindow: false }),
        node("grandchild", { parentSessionId: "step" }),
      ],
      edges: [],
    });
    expect(rows.map((r) => r.id)).toEqual(["step"]);
  });

  it("is OMITTED with no step, or with no read", () => {
    expect(planSteps(null, ROOT)).toEqual({ state: "none" });
    expect(
      planSteps(
        { nodes: [node("root", { parentSessionId: null })], edges: [] },
        ROOT
      )
    ).toEqual({ state: "none" });
  });

  it("says when a blocker section could not be read, and when the window cut the read", () => {
    const out = planSteps(
      {
        nodes: [node("a", { status: "forming" })],
        edges: [],
        sections: { crossKind: { status: "unavailable" } },
        window: { truncated: true },
      },
      ROOT,
      NOW
    );
    expect(out).toMatchObject({
      state: "ok",
      waitsUnread: true,
      truncated: true,
    });
    // Never "ready" on a guess.
    expect(out.state === "ok" && out.rows[0]?.mark.state).toBe("planned");
  });

  it("a clean read says neither", () => {
    const out = planSteps(
      {
        nodes: [node("a", { status: "forming" })],
        edges: [],
        sections: { blockedBy: { status: "ok" }, farEnds: { status: "ok" } },
        window: { truncated: false },
      },
      ROOT,
      NOW
    );
    expect(out).toMatchObject({ waitsUnread: false, truncated: false });
  });
});
