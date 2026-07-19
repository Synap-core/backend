import { describe, it, expect } from "vitest";
import type { AutomationEdge, AutomationNode } from "@synap/database";
import {
  resolveTemplate,
  evaluateCondition,
  topoSort,
  markDescendantsSkipped,
  seedResumeState,
  type StepContext,
  type LedgerStepRow,
} from "../automation-executor.js";
import { deterministicUuidV5 } from "../../utils/deterministic-uuid.js";

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

describe("seedResumeState (Wave 4.R resume-from-ledger)", () => {
  const row = (
    nodeId: string,
    status: string,
    output: unknown = null
  ): LedgerStepRow => ({ nodeId, status, output });

  it("is a no-op for a fresh run (no completedNodeIds, empty ledger)", () => {
    const { completed, priorSteps } = seedResumeState(undefined, []);
    expect(completed.size).toBe(0);
    expect(priorSteps).toEqual({});
  });

  it("seeds completed nodes from the ledger even when job.data carries none (crash-retry)", () => {
    // The F1 bug: a redelivered job has completedNodeIds undefined, so ONLY the
    // ledger tells us step A already ran. Without this, A re-executes.
    const { completed, priorSteps } = seedResumeState(undefined, [
      row("A", "completed", { entityId: "e1" }),
      row("B", "running"),
    ]);
    expect(completed.has("A")).toBe(true);
    expect(completed.has("B")).toBe(false); // not completed → will re-run
    expect(priorSteps.A).toEqual({ output: { entityId: "e1" } });
    expect(priorSteps.B).toBeUndefined();
  });

  it("unions job.data completedNodeIds with the ledger", () => {
    const { completed } = seedResumeState(["X"], [row("Y", "completed", {})]);
    expect(completed.has("X")).toBe(true); // from job.data (delay-resume path)
    expect(completed.has("Y")).toBe(true); // from ledger (crash-retry path)
  });

  it("does not seed context output for a completed row with no output", () => {
    const { completed, priorSteps } = seedResumeState(undefined, [
      row("A", "completed", null),
    ]);
    expect(completed.has("A")).toBe(true); // still skipped on resume
    expect(priorSteps.A).toBeUndefined(); // but nothing to reload into context
  });

  it("ignores skipped/failed rows", () => {
    const { completed } = seedResumeState(undefined, [
      row("A", "skipped"),
      row("B", "failed"),
    ]);
    expect(completed.size).toBe(0);
  });
});

describe("deterministicUuidV5 (Wave 4.R idempotency key)", () => {
  it("is stable for the same input (so a retry re-derives the same row id)", () => {
    const key = "channel_message:run1:node1:-";
    expect(deterministicUuidV5(key)).toBe(deterministicUuidV5(key));
  });

  it("differs per (run, node, iteration) and per kind", () => {
    const a = deterministicUuidV5("channel_message:run1:node1:0");
    const b = deterministicUuidV5("channel_message:run1:node1:1"); // next loop iter
    const c = deterministicUuidV5("notification:run1:node1:0"); // other output kind
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("produces a valid RFC-4122 v5 UUID string", () => {
    expect(deterministicUuidV5("x")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });
});
