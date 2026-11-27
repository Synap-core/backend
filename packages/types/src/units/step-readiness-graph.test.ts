import { describe, it, expect } from "vitest";
import {
  stepBlockersReadable,
  stepReadinessOf,
  type StepGraphEdge,
  type StepGraphNode,
  type StepReadinessGraph,
} from "./step-readiness-graph.js";

/**
 * THE readiness rule over a work graph. Each row names the naive reading it
 * rules OUT.
 */
const NOW = Date.UTC(2026, 10, 27, 12);

const node = (id: string, o: Partial<StepGraphNode> = {}): StepGraphNode => ({
  id,
  status: "active",
  inWindow: true,
  ...o,
});
const blockedBy = (
  from: string,
  to: string,
  o: Partial<StepGraphEdge> = {}
): StepGraphEdge => ({ kind: "blocked_by", from, to, ...o });
const replaces = (from: string, to: string): StepGraphEdge => ({
  kind: "replaces",
  from,
  to,
});
const readiness = (g: StepReadinessGraph) => stepReadinessOf(g, NOW);

describe("stepReadinessOf, a planned window", () => {
  it("a future plannedFor is planned; a past one is ready (rules out 'forming is always ready')", () => {
    const out = readiness({
      nodes: [
        node("future", { status: "forming", plannedFor: "2027-03-14" }),
        node("past", { status: "forming", plannedFor: "2026-11-01" }),
        node("none", { status: "forming" }),
      ],
      edges: [],
    });
    expect(out.get("future")).toBe("planned");
    expect(out.get("past")).toBe("ready");
    expect(out.get("none")).toBe("ready");
  });
});

describe("stepReadinessOf, how it ended", () => {
  it("closed-not-done is dropped, closed done is done (rules out 'closed = done')", () => {
    const out = readiness({
      nodes: [
        node("a", { status: "closed", closedAs: "not_done" }),
        node("b", { status: "closed", closedAs: "done" }),
        node("c", { status: "closed" }),
      ],
      edges: [],
    });
    expect(out.get("a")).toBe("dropped");
    expect(out.get("b")).toBe("done");
    expect(out.get("c")).toBe("done");
  });

  it("a step waiting on a closed-not-done blocker is not freed by it (rules out 'closed releases')", () => {
    const out = readiness({
      nodes: [
        node("blocker", { status: "closed", closedAs: "not_done" }),
        node("step", { status: "forming" }),
        node("running", { status: "active" }),
      ],
      edges: [blockedBy("step", "blocker"), blockedBy("running", "blocker")],
    });
    // A dropped blocker holds a step that is not started...
    expect(out.get("step")).toBe("blocked");
    // ...and one already running reads blocked as well.
    expect(out.get("running")).toBe("blocked");
  });

  it("a delivered blocker frees the step", () => {
    const out = readiness({
      nodes: [
        node("blocker", { status: "closed", closedAs: "done" }),
        node("step", { status: "forming" }),
      ],
      edges: [blockedBy("step", "blocker")],
    });
    expect(out.get("step")).toBe("ready");
  });
});

describe("stepReadinessOf, a replaced blocker", () => {
  it("a blocker replaced by a delivered step is released (rules out 'the old blocker still holds')", () => {
    const out = readiness({
      nodes: [
        node("old", { status: "cancelled", closedAs: "not_done" }),
        node("new", { status: "closed", closedAs: "done" }),
        node("step", { status: "forming" }),
      ],
      edges: [blockedBy("step", "old"), replaces("new", "old")],
    });
    expect(out.get("step")).toBe("ready");
  });

  it("a replacement still open holds the step (planned, not blocked)", () => {
    const out = readiness({
      nodes: [
        node("old", { status: "cancelled", closedAs: "not_done" }),
        node("new", { status: "active" }),
        node("step", { status: "forming" }),
      ],
      edges: [blockedBy("step", "old"), replaces("new", "old")],
    });
    expect(out.get("step")).toBe("planned");
  });

  it("without the replaces edge the same blocker holds (the edge is what releases)", () => {
    const out = readiness({
      nodes: [
        node("old", { status: "cancelled", closedAs: "not_done" }),
        node("step", { status: "forming" }),
      ],
      edges: [blockedBy("step", "old")],
    });
    expect(out.get("step")).toBe("blocked");
  });
});

describe("stepReadinessOf, a decision's arms", () => {
  const decision = {
    id: "d",
    status: "accepted",
    category: "done" as const,
    chosenOption: "a",
  };

  it("a skipped arm is skipped itself and holds none of its dependents", () => {
    const out = readiness({
      nodes: [
        node("armB", { status: "cancelled", skipped: true }),
        node("after", { status: "forming" }),
        node("armA", { status: "forming" }),
      ],
      edges: [
        blockedBy("armB", "d", { toKind: "entity", option: "b" }),
        blockedBy("armA", "d", { toKind: "entity", option: "a" }),
        blockedBy("after", "armB"),
      ],
      decisions: [decision],
    });
    expect(out.get("armB")).toBe("skipped");
    expect(out.get("after")).toBe("ready");
    expect(out.get("armA")).toBe("ready");
  });

  it("an arm not taken but not yet closed as skipped holds (never a silent green)", () => {
    const out = readiness({
      nodes: [node("armB", { status: "forming" })],
      edges: [blockedBy("armB", "d", { toKind: "entity", option: "b" })],
      decisions: [decision],
    });
    expect(out.get("armB")).toBe("blocked");
  });

  it("an undecided decision holds every arm", () => {
    const out = readiness({
      nodes: [node("armA", { status: "forming" })],
      edges: [blockedBy("armA", "d", { toKind: "entity", option: "a" })],
      decisions: [
        { id: "d", status: "proposed", category: "open", chosenOption: null },
      ],
    });
    expect(out.get("armA")).toBe("planned");
  });
});

describe("stepReadinessOf, what the graph does not hold", () => {
  it("a blocker missing from the graph is unknown, so it waits (rules out 'no node = delivered')", () => {
    const out = readiness({
      nodes: [node("step", { status: "forming" })],
      edges: [blockedBy("step", "ghost")],
    });
    expect(out.get("step")).toBe("planned");
  });

  it("a replacement missing from the graph holds the step too", () => {
    const out = readiness({
      nodes: [
        node("old", { status: "cancelled", closedAs: "not_done" }),
        node("step", { status: "forming" }),
      ],
      edges: [blockedBy("step", "old"), replaces("ghost", "old")],
    });
    expect(out.get("step")).toBe("planned");
  });

  it("an unreadable blocker section reads every step as waiting, never ready", () => {
    const graph: StepReadinessGraph = {
      nodes: [node("step", { status: "forming" })],
      edges: [],
      sections: { blockedBy: { status: "unavailable", reason: "x" } },
    };
    expect(stepBlockersReadable(graph)).toBe(false);
    expect(readiness(graph).get("step")).toBe("planned");
  });

  it("a started step keeps reading active when the section failed (it claims no block it cannot see)", () => {
    const out = readiness({
      nodes: [node("step", { status: "active" })],
      edges: [],
      sections: { crossKind: { status: "unavailable" } },
    });
    expect(out.get("step")).toBe("active");
  });

  it("a far end is a blocker, never a step of the result", () => {
    const out = readiness({
      nodes: [
        node("step", { status: "forming" }),
        node("far", { status: "closed", closedAs: "done", inWindow: false }),
      ],
      edges: [blockedBy("step", "far")],
    });
    expect([...out.keys()]).toEqual(["step"]);
    expect(out.get("step")).toBe("ready");
  });

  it("a goal blocker follows the goal's status", () => {
    const out = readiness({
      nodes: [node("step", { status: "forming" })],
      edges: [blockedBy("step", "g", { toKind: "track" })],
      goals: [{ id: "g", status: "active" }],
    });
    expect(out.get("step")).toBe("planned");
  });
});
