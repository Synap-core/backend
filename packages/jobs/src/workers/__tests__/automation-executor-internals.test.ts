import { describe, it, expect } from "vitest";
import type { AutomationEdge, AutomationNode } from "@synap/database";
import {
  resolveTemplate,
  deepResolveTemplates,
  evaluateCondition,
  topoSort,
  markDescendantsSkipped,
  seedResumeState,
  executeSelectStep,
  resolveExecutionActor,
  shouldRunFlow,
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

describe("deepResolveTemplates", () => {
  it("preserves native values for exact placeholders", () => {
    const c = ctx({
      steps: {
        compute: { output: { amount: 42, active: true, data: { x: 1 } } },
      },
    });
    expect(deepResolveTemplates("{{steps.compute.output.amount}}", c)).toBe(42);
    expect(deepResolveTemplates("{{steps.compute.output.active}}", c)).toBe(
      true
    );
    expect(deepResolveTemplates("{{steps.compute.output.data}}", c)).toEqual({
      x: 1,
    });
  });

  it("keeps embedded placeholders textual", () => {
    const c = ctx({ steps: { compute: { output: { amount: 42 } } } });
    expect(
      deepResolveTemplates("Fee: {{steps.compute.output.amount}}", c)
    ).toBe("Fee: 42");
  });

  // Regression: a capability/skill node's inputMapping whose value is an
  // exact array placeholder must reach the verb as an ARRAY, not a JSON string.
  // The old path (resolveInputMapping → resolveTemplate) stringified it, which
  // made e.g. mail_triage's `emails: z.array(...)` fail "expected array,
  // received string". Mirrors how the skill/capability nodes now resolve inputs.
  it("preserves an exact-placeholder array through an inputMapping (capability/skill node shape)", () => {
    const c = ctx({
      steps: {
        fetchEmails: {
          output: {
            emails: [
              { id: "1", subject: "a" },
              { id: "2", subject: "b" },
            ],
          },
        },
      },
    });
    const resolved = deepResolveTemplates(
      { emails: "{{steps.fetchEmails.output.emails}}" },
      c
    ) as Record<string, unknown>;
    expect(Array.isArray(resolved.emails)).toBe(true);
    expect(resolved.emails).toEqual([
      { id: "1", subject: "a" },
      { id: "2", subject: "b" },
    ]);
  });
});

describe("executeSelectStep", () => {
  it("chooses a native typed value from a boolean step result", () => {
    const c = ctx({ steps: { decision: { output: { result: true } } } });
    expect(
      executeSelectStep(
        {
          when: "{{steps.decision.output.result}}",
          ifTrue: "first",
          ifFalse: "subsequent",
        },
        c
      )
    ).toEqual({ value: "first" });
  });

  it("fails closed when the selection predicate is not boolean", () => {
    expect(() =>
      executeSelectStep(
        { when: "{{trigger.payload.unknown}}", ifTrue: "yes", ifFalse: "no" },
        ctx()
      )
    ).toThrow("select node: 'when' must resolve to a boolean");
  });

  it("accepts the explicit 0/1 output of a compute predicate", () => {
    expect(
      executeSelectStep({ when: 1, ifTrue: "first", ifFalse: "later" }, ctx())
        .value
    ).toBe("first");
    expect(
      executeSelectStep({ when: 0, ifTrue: "first", ifFalse: "later" }, ctx())
        .value
    ).toBe("later");
  });
});

describe("resolveExecutionActor", () => {
  it("uses the manual triggering member for record-bound workflow writes", () => {
    expect(
      resolveExecutionActor("business-developer", "automation-owner")
    ).toBe("business-developer");
  });

  it("retains the automation owner for unattended runs", () => {
    expect(resolveExecutionActor("system", "automation-owner")).toBe(
      "automation-owner"
    );
    expect(resolveExecutionActor("automation", "automation-owner")).toBe(
      "automation-owner"
    );
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

describe("shouldRunFlow (Wave 4.V3 precondition early-exit)", () => {
  it("runs when there is no precondition", () => {
    expect(shouldRunFlow(undefined, ctx())).toBe(true);
  });

  it("runs when the precondition is empty/whitespace", () => {
    expect(shouldRunFlow("", ctx())).toBe(true);
    expect(shouldRunFlow("   ", ctx())).toBe(true);
  });

  it("runs when the precondition evaluates true against the trigger payload", () => {
    const c = ctx({ trigger: { payload: { stage: "won" } } });
    expect(shouldRunFlow("trigger.payload.stage === 'won'", c)).toBe(true);
  });

  it("skips (returns false) when the precondition evaluates false", () => {
    const c = ctx({ trigger: { payload: { stage: "lost" } } });
    expect(shouldRunFlow("trigger.payload.stage === 'won'", c)).toBe(false);
  });

  it("reads automation.state like a condition node does", () => {
    const c = ctx({ automation: { id: "a1", state: { count: 5 } } });
    expect(shouldRunFlow("automation.state.count >= 3", c)).toBe(true);
    expect(shouldRunFlow("automation.state.count > 10", c)).toBe(false);
  });

  it("throws (fail-closed) on an unparseable precondition — never a silent run", () => {
    expect(() => shouldRunFlow("not a comparison", ctx())).toThrow();
  });
});
