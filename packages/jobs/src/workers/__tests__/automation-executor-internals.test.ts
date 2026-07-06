import { describe, it, expect } from "vitest";
import type { AutomationEdge, AutomationNode } from "@synap/database";
import {
  resolveTemplate,
  evaluateCondition,
  topoSort,
  markDescendantsSkipped,
  type StepContext,
} from "../automation-executor.js";

const ctx = (overrides: Partial<StepContext> = {}): StepContext => ({
  trigger: { payload: {} },
  steps: {},
  automation: { id: "a1", state: {} },
  ...overrides,
});

const node = (id: string): AutomationNode =>
  ({
    id,
    type: "command",
    position: { x: 0, y: 0 },
    data: {},
  }) as AutomationNode;
const edge = (
  id: string,
  source: string,
  target: string,
  sourceHandle?: string
): AutomationEdge => ({
  id,
  source,
  target,
  ...(sourceHandle ? { sourceHandle } : {}),
});

describe("resolveTemplate", () => {
  it("resolves a scalar path", () => {
    expect(
      resolveTemplate(
        "{{trigger.payload.title}}",
        ctx({ trigger: { payload: { title: "Hi" } } })
      )
    ).toBe("Hi");
  });

  it("returns '' for a missing path (not 'undefined')", () => {
    expect(resolveTemplate("{{trigger.payload.nope}}", ctx())).toBe("");
  });

  it("JSON-encodes an object/array instead of '[object Object]'", () => {
    const c = ctx({ steps: { s: { output: { relations: [{ a: 1 }] } } } });
    // The dossier-relations bug: an object interpolated into a prompt must be
    // JSON, not "[object Object]".
    expect(resolveTemplate("{{steps.s.output.relations}}", c)).toBe(
      '[{"a":1}]'
    );
  });

  it("stringifies scalars normally", () => {
    expect(
      resolveTemplate(
        "n={{steps.s.output.n}}",
        ctx({ steps: { s: { output: { n: 5 } } } })
      )
    ).toBe("n=5");
  });
});

describe("evaluateCondition", () => {
  const withSteps = (output: Record<string, unknown>) =>
    ctx({ steps: { s: { output } } });

  // Conditions use BARE operand paths (no {{ }}); the evaluator resolves the
  // left path itself and resolves the right when it is a bare context path.
  it("compares string literals", () => {
    expect(
      evaluateCondition("steps.s.output.k === 'x'", withSteps({ k: "x" }))
    ).toBe(true);
    expect(
      evaluateCondition("steps.s.output.k === 'x'", withSteps({ k: "y" }))
    ).toBe(false);
  });

  it("compares booleans via bare true/false", () => {
    expect(
      evaluateCondition(
        "steps.s.output.flag === true",
        withSteps({ flag: true })
      )
    ).toBe(true);
    expect(
      evaluateCondition(
        "steps.s.output.flag === true",
        withSteps({ flag: false })
      )
    ).toBe(false);
  });

  it("handles numeric comparisons", () => {
    expect(evaluateCondition("steps.s.output.n > 5", withSteps({ n: 9 }))).toBe(
      true
    );
    expect(evaluateCondition("steps.s.output.n > 5", withSteps({ n: 2 }))).toBe(
      false
    );
  });

  it("does NOT let a missing operand satisfy a numeric gate (Number('')===0 trap)", () => {
    // missing → "" → must be NaN, not 0. So `< 5` is false, not true.
    expect(evaluateCondition("steps.s.output.missing < 5", withSteps({}))).toBe(
      false
    );
    expect(evaluateCondition("steps.s.output.missing > 5", withSteps({}))).toBe(
      false
    );
  });

  it("resolves BOTH operands for a two-path comparison", () => {
    const c = ctx({
      trigger: {
        payload: { a: "id-1", b: "id-1", data: { channelId: "id-2" } },
      },
    });
    // equal → false
    expect(
      evaluateCondition("trigger.payload.a !== trigger.payload.b", c)
    ).toBe(false);
    // differ → true (the link-gate case)
    expect(
      evaluateCondition(
        "trigger.payload.a !== trigger.payload.data.channelId",
        c
      )
    ).toBe(true);
  });

  it("FAILS CLOSED (throws) on an unparseable expression", () => {
    expect(() => evaluateCondition("this has no operator", ctx())).toThrow(
      /fail-closed/
    );
  });
});

describe("topoSort", () => {
  it("orders a DAG parents-before-children", () => {
    const nodes = [node("a"), node("b"), node("c")];
    const edges = [edge("e1", "a", "b"), edge("e2", "b", "c")];
    expect(topoSort(nodes, edges).map((n) => n.id)).toEqual(["a", "b", "c"]);
  });

  it("drops cyclic nodes (caller detects length < nodes.length and throws)", () => {
    const nodes = [node("a"), node("b")];
    const edges = [edge("e1", "a", "b"), edge("e2", "b", "a")];
    expect(topoSort(nodes, edges).length).toBeLessThan(nodes.length);
  });
});

describe("markDescendantsSkipped (diamond fix)", () => {
  it("skips a linear untaken branch", () => {
    const edges = [edge("e1", "cond", "b", "no")];
    const skipped = new Set<string>();
    const pruned = new Set<AutomationEdge>([edges[0]]);
    markDescendantsSkipped("b", edges, skipped, pruned);
    expect(skipped.has("b")).toBe(true);
  });

  it("does NOT skip a join node reachable from the taken branch", () => {
    // cond --yes--> A --> J ;  cond --no--> B --> J   (diamond, J is the merge)
    const eYes = edge("e1", "cond", "A", "yes");
    const eNo = edge("e2", "cond", "B", "no");
    const eAJ = edge("e3", "A", "J");
    const eBJ = edge("e4", "B", "J");
    const edges = [eYes, eNo, eAJ, eBJ];
    const skipped = new Set<string>();
    const pruned = new Set<AutomationEdge>([eNo]); // "no" branch pruned
    markDescendantsSkipped("B", edges, skipped, pruned);
    expect(skipped.has("B")).toBe(true); // B only reachable via the pruned edge
    expect(skipped.has("J")).toBe(false); // J still reachable via A (taken)
  });
});
