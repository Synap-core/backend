import { describe, it, expect } from "vitest";
import type {
  AutomationEdge,
  AutomationNode,
  FlowDefinition,
} from "@synap/database";
import {
  resolveTemplate,
  deepResolveTemplates,
  evaluateCondition,
  executeTransformStep,
  topoSort,
  markDescendantsSkipped,
  computePathTaken,
  seedResumeState,
  seedPruningState,
  executeSelectStep,
  resolveExecutionActor,
  shouldRunFlow,
  resolveQueryProfileSlug,
  parseQueryFilterConditions,
  parseQueryOrderBy,
  buildRunDefinitionSnapshot,
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

  // ── Membership operators (list-based): in / not-in / contains / contains-any ──
  describe("membership operators", () => {
    const withFrom = (from: string, extra: Record<string, unknown> = {}) =>
      ctx({ trigger: { payload: { from, ...extra } } });

    it("`in` — value ∈ inline literal allow-list (member / non-member)", () => {
      expect(
        evaluateCondition(
          "trigger.payload.from in 'a@x.com','b@y.com'",
          withFrom("a@x.com")
        )
      ).toBe(true);
      expect(
        evaluateCondition(
          "trigger.payload.from in 'a@x.com','b@y.com'",
          withFrom("c@z.com")
        )
      ).toBe(false);
    });

    it("`in` — value ∈ a context-path list (resolved array)", () => {
      const c = withFrom("b@y.com", { allow: ["a@x.com", "b@y.com"] });
      expect(
        evaluateCondition("trigger.payload.from in trigger.payload.allow", c)
      ).toBe(true);
    });

    it("`contains` — list ∋ value (list on the LEFT)", () => {
      const c = withFrom("a@x.com", { allow: ["a@x.com", "b@y.com"] });
      expect(
        evaluateCondition(
          "trigger.payload.allow contains trigger.payload.from",
          c
        )
      ).toBe(true);
      expect(
        evaluateCondition("trigger.payload.allow contains 'c@z.com'", c)
      ).toBe(false);
    });

    it("`contains-any` — non-empty intersection (either side a list)", () => {
      const c = ctx({
        trigger: { payload: { tags: ["urgent", "sales"] } },
      });
      expect(
        evaluateCondition("trigger.payload.tags contains-any 'sales','ops'", c)
      ).toBe(true);
      expect(
        evaluateCondition("trigger.payload.tags contains-any 'ops','hr'", c)
      ).toBe(false);
    });

    it("`not-in` — deny-list keep-gate (deny-wins: matched sender is dropped)", () => {
      const denied = withFrom("spam@bad.com", {
        deny: ["spam@bad.com", "noise@bad.com"],
      });
      // keep-gate: a denied sender → false (don't keep)
      expect(
        evaluateCondition(
          "trigger.payload.from not-in trigger.payload.deny",
          denied
        )
      ).toBe(false);
      // a clean sender → true (keep)
      const clean = withFrom("ok@good.com", { deny: ["spam@bad.com"] });
      expect(
        evaluateCondition(
          "trigger.payload.from not-in trigger.payload.deny",
          clean
        )
      ).toBe(true);
    });

    it("empty list → `in` false, `not-in` true (missing path resolves to [])", () => {
      const c = withFrom("a@x.com"); // no `allow` key at all
      expect(
        evaluateCondition("trigger.payload.from in trigger.payload.allow", c)
      ).toBe(false);
      expect(
        evaluateCondition(
          "trigger.payload.from not-in trigger.payload.allow",
          c
        )
      ).toBe(true);
    });

    it("does NOT hijack a `===` compare whose literal contains ' in ' (leftmost wins)", () => {
      // The `===` operator appears LEFTMOST, so this stays a scalar comparison
      // and the membership `in` inside the literal is ignored.
      expect(
        evaluateCondition(
          "steps.s.output.k === 'fell in love'",
          withSteps({ k: "fell in love" })
        )
      ).toBe(true);
      expect(
        evaluateCondition(
          "steps.s.output.k === 'fell in love'",
          withSteps({ k: "other" })
        )
      ).toBe(false);
    });
  });
});

describe("executeTransformStep — to_ms date pipe", () => {
  it("parses an ISO-8601 string to epoch ms", () => {
    const out = executeTransformStep(
      { expression: "2026-07-23T10:30:00.000Z | to_ms" },
      ctx()
    );
    expect(out.result).toBe(Date.parse("2026-07-23T10:30:00.000Z"));
  });

  it("parses an RFC-2822 email date header to epoch ms", () => {
    const rfc = "Wed, 23 Jul 2026 10:30:00 +0000";
    const out = executeTransformStep({ expression: `${rfc} | to_ms` }, ctx());
    expect(out.result).toBe(Date.parse(rfc));
  });

  it("returns the 0 sentinel on unparseable input (not NaN / not a throw)", () => {
    const out = executeTransformStep(
      { expression: "not a date at all | to_ms" },
      ctx()
    );
    expect(out.result).toBe(0);
  });

  it("resolves a template date then converts (watermark pipeline shape)", () => {
    const c = ctx({
      steps: { gmail: { output: { date: "2026-07-23T10:30:00.000Z" } } },
    });
    const out = executeTransformStep(
      { expression: "{{steps.gmail.output.date}} | to_ms" },
      c
    );
    expect(out.result).toBe(Date.parse("2026-07-23T10:30:00.000Z"));
  });

  it("`date_ms` is an accepted alias", () => {
    const out = executeTransformStep(
      { expression: "2026-01-01T00:00:00.000Z | date_ms" },
      ctx()
    );
    expect(out.result).toBe(Date.parse("2026-01-01T00:00:00.000Z"));
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

  it("does not treat skipped/failed rows as completed", () => {
    const { completed } = seedResumeState(undefined, [
      row("A", "skipped"),
      row("B", "failed"),
    ]);
    expect(completed.size).toBe(0);
  });

  it("carries skipped rows through — a prune decision must survive a resume", () => {
    // The bug: `skipped` rows were DISCARDED, so a resumed pass rebuilt
    // skippedNodes empty and executed a node the run had already pruned.
    const { skipped } = seedResumeState(undefined, [
      row("A", "completed", {}),
      row("B", "skipped"),
      row("C", "failed"),
    ]);
    expect([...skipped]).toEqual(["B"]);
  });

  it("gives `completed` precedence over `skipped` for the same node", () => {
    const { completed, skipped } = seedResumeState(
      ["N"],
      [row("N", "skipped")]
    );
    expect(completed.has("N")).toBe(true);
    expect(skipped.has("N")).toBe(false); // never re-run, never double-recorded
  });
});

describe("seedPruningState (a resumed pass inherits the pruning)", () => {
  // cond --yes--> A --> delay --> E ;  cond --no--> B1 --> B2
  const eYes = edge("e1", "cond", "A", "yes");
  const eNo = edge("e2", "cond", "B1", "no");
  const eB = edge("e3", "B1", "B2");
  const eAD = edge("e4", "A", "delay");
  const eDE = edge("e5", "delay", "E");
  const edges = [eYes, eNo, eB, eAD, eDE];

  it("is a no-op for a fresh run", () => {
    const { skippedNodes, prunedEdges } = seedPruningState(
      edges,
      new Set(),
      null
    );
    expect(skippedNodes.size).toBe(0);
    expect(prunedEdges.size).toBe(0);
  });

  it("re-skips a pruned node the first pass recorded, AND its descendants", () => {
    // The first pass walked past B1 (wrote a `skipped` row) but suspended at the
    // delay before reaching B2 — so only B1 has a row. B2 must still be pruned.
    const { skippedNodes } = seedPruningState(edges, new Set(["B1"]), null);
    expect(skippedNodes.has("B1")).toBe(true);
    expect(skippedNodes.has("B2")).toBe(true);
  });

  it("re-skips a branch that has NO ledger row at all, from the stored pathTaken", () => {
    // Topo order can put the whole untaken branch after the delay node, so the
    // ledger is silent about it. `pathTaken.prunedEdgeIds` is the only record.
    const { skippedNodes, prunedEdges } = seedPruningState(edges, new Set(), {
      traversedEdgeIds: ["e1"],
      prunedEdgeIds: ["e2"],
    });
    expect(prunedEdges.has(eNo)).toBe(true);
    expect(skippedNodes.has("B1")).toBe(true);
    expect(skippedNodes.has("B2")).toBe(true);
  });

  it("leaves the TAKEN branch alone", () => {
    const { skippedNodes } = seedPruningState(edges, new Set(["B1"]), {
      traversedEdgeIds: ["e1"],
      prunedEdgeIds: ["e2"],
    });
    expect(skippedNodes.has("A")).toBe(false);
    expect(skippedNodes.has("E")).toBe(false);
  });

  it("keeps a join reachable from the taken branch alive (diamond)", () => {
    // cond --yes--> A --> J ; cond --no--> B --> J
    const yes = edge("y", "cond", "A", "yes");
    const no = edge("n", "cond", "B", "no");
    const aj = edge("aj", "A", "J");
    const bj = edge("bj", "B", "J");
    const { skippedNodes } = seedPruningState(
      [yes, no, aj, bj],
      new Set(["B"]),
      { traversedEdgeIds: ["y"], prunedEdgeIds: ["n"] }
    );
    expect(skippedNodes.has("B")).toBe(true);
    expect(skippedNodes.has("J")).toBe(false);
  });

  it("re-derives the same pruned edges the first pass stored (union stays stable)", () => {
    // What computePathTaken merges on the second pass must equal what it stored
    // on the first — the seed re-derives, it does not invent.
    const { prunedEdges, skippedNodes } = seedPruningState(edges, new Set(), {
      traversedEdgeIds: ["e1"],
      prunedEdgeIds: ["e2"],
    });
    const path = computePathTaken(edges, prunedEdges, new Set(["cond", "A"]), {
      traversedEdgeIds: ["e1"],
      prunedEdgeIds: ["e2"],
    });
    expect(path.prunedEdgeIds.sort()).toEqual(["e2", "e3"]);
    expect(path.traversedEdgeIds.sort()).toEqual(["e1", "e4"]);
    expect(skippedNodes.has("B2")).toBe(true);
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

describe("buildRunDefinitionSnapshot", () => {
  it("records the exact version and flow evaluated by the executor", () => {
    const flow: FlowDefinition = {
      nodes: [
        {
          id: "trigger",
          type: "trigger",
          position: { x: 0, y: 0 },
          data: {
            triggerType: "manual",
            label: "On demand",
            config: {},
          },
        },
      ],
      edges: [],
      precondition: "trigger.payload.ready === true",
    };

    expect(buildRunDefinitionSnapshot(9, flow)).toEqual({
      version: 9,
      flowDefinition: flow,
    });
  });
});

// Regression for the "Daily Reconnection Nudges" / "Event Prep Briefing" /
// "Generate report" query-node crash: `diagnose(runId)` forensics showed all
// three failing with "Cannot read properties of undefined (reading
// 'replace')" on a query node whose `filter` nests `profileSlug` and property
// operators, and whose top-level `orderBy`/`orderDir` sort a
// `properties.<field>` path — a shape the old executor never resolved before
// calling `resolveTemplate` (→ `String.replace`) on the missing top-level
// `profileSlug`.
describe("resolveQueryProfileSlug (query node profileSlug resolution)", () => {
  it("resolves the legacy top-level profileSlug field", () => {
    expect(resolveQueryProfileSlug({ profileSlug: "person" }, ctx())).toBe(
      "person"
    );
  });

  it("resolves profileSlug nested inside an object filter (the crashing shape)", () => {
    // Before the fix: `data.profileSlug` is undefined here, and
    // `resolveTemplate(undefined, …)` threw on `undefined.replace(...)`.
    expect(() =>
      resolveQueryProfileSlug(
        {
          filter: {
            profileSlug: "person",
            "properties.strengthScore": { $gt: 30 },
          },
        },
        ctx()
      )
    ).not.toThrow();
    expect(
      resolveQueryProfileSlug(
        {
          filter: {
            profileSlug: "person",
            "properties.strengthScore": { $gt: 30 },
          },
        },
        ctx()
      )
    ).toBe("person");
  });

  it("returns '' (not a throw) when profileSlug is missing from both locations", () => {
    expect(() => resolveQueryProfileSlug({}, ctx())).not.toThrow();
    expect(resolveQueryProfileSlug({}, ctx())).toBe("");
    expect(resolveQueryProfileSlug({ filter: {} }, ctx())).toBe("");
  });

  it("template-resolves a nested profileSlug reference", () => {
    const c = ctx({ trigger: { payload: { slug: "event" } } });
    expect(
      resolveQueryProfileSlug(
        { filter: { profileSlug: "{{trigger.payload.slug}}" } },
        c
      )
    ).toBe("event");
  });
});

describe("parseQueryFilterConditions (query node filter parsing)", () => {
  it("parses an operator object ($gt) alongside profileSlug, skipping profileSlug", () => {
    const conditions = parseQueryFilterConditions(
      {
        profileSlug: "person",
        "properties.strengthScore": { $gt: 30 },
      },
      ctx()
    );
    expect(conditions).toEqual([
      { propKey: "strengthScore", op: "gt", value: 30 },
    ]);
  });

  it("parses a plain equality filter object", () => {
    const conditions = parseQueryFilterConditions(
      { profileSlug: "event", "properties.status": "active" },
      ctx()
    );
    expect(conditions).toEqual([
      { propKey: "status", op: "eq", value: "active" },
    ]);
  });

  it("still supports the legacy JSON-stringified flat filter", () => {
    const conditions = parseQueryFilterConditions(
      JSON.stringify({ status: "active" }),
      ctx()
    );
    expect(conditions).toEqual([
      { propKey: "status", op: "eq", value: "active" },
    ]);
  });

  it("returns [] (not a throw) for an unparseable/empty filter", () => {
    expect(parseQueryFilterConditions(undefined, ctx())).toEqual([]);
    expect(parseQueryFilterConditions("not json", ctx())).toEqual([]);
    expect(parseQueryFilterConditions("", ctx())).toEqual([]);
  });
});

describe("parseQueryOrderBy (query node orderBy parsing)", () => {
  it("parses a properties.<field> orderBy path with orderDir", () => {
    expect(
      parseQueryOrderBy({
        orderBy: "properties.strengthScore",
        orderDir: "desc",
      })
    ).toEqual({ kind: "property", propKey: "strengthScore", dir: "desc" });
  });

  it("defaults orderDir to desc when omitted", () => {
    expect(parseQueryOrderBy({ orderBy: "properties.startDate" })).toEqual({
      kind: "property",
      propKey: "startDate",
      dir: "desc",
    });
  });

  it("honors an explicit asc orderDir", () => {
    expect(
      parseQueryOrderBy({ orderBy: "properties.startDate", orderDir: "asc" })
    ).toEqual({ kind: "property", propKey: "startDate", dir: "asc" });
  });

  it("returns undefined (not a throw) when orderBy is missing/non-string", () => {
    expect(() => parseQueryOrderBy({})).not.toThrow();
    expect(parseQueryOrderBy({})).toBeUndefined();
    expect(
      parseQueryOrderBy({ orderBy: 42 as unknown as string })
    ).toBeUndefined();
  });
});

// ── computePathTaken (D3d: "which path did this run take", as a stored fact) ──
//
// PURE unit tests over the extracted decision logic — no Postgres, no pg-boss.
// They exercise the SAME `markDescendantsSkipped` + `getOutEdges` pruning the
// executor runs, then assert what `computePathTaken` freezes, which is exactly
// the contract the persisted `automation_runs.path_taken` column carries.
describe("computePathTaken", () => {
  it("records nothing pruned and every edge traversed for a linear flow", () => {
    // trigger → a → b, all executed
    const edges = [edge("e1", "t", "a"), edge("e2", "a", "b")];
    const path = computePathTaken(
      edges,
      new Set(),
      new Set(["t", "a", "b"]),
      null
    );
    expect(path.prunedEdgeIds).toEqual([]);
    expect(path.traversedEdgeIds.sort()).toEqual(["e1", "e2"]);
  });

  it("records the untaken branch of a false condition as pruned", () => {
    // t → c(condition); c --yes--> y → y2 ; c --no--> n
    // condition evaluated FALSE ⇒ the "yes" branch is pruned.
    const edges = [
      edge("e_t", "t", "c"),
      edge("e_yes", "c", "y", "yes"),
      edge("e_y2", "y", "y2"),
      edge("e_no", "c", "n", "no"),
    ];
    const skippedNodes = new Set<string>();
    const prunedEdges = new Set<AutomationEdge>();
    // Mirror the executor's condition case: prune the untaken handle's edges,
    // then walk their descendants.
    const untaken = edges.filter(
      (e) => e.source === "c" && e.sourceHandle === "yes"
    );
    for (const e of untaken) prunedEdges.add(e);
    for (const e of untaken)
      markDescendantsSkipped(e.target, edges, skippedNodes, prunedEdges);

    // Executed: trigger, the condition, and the taken-branch node.
    const path = computePathTaken(
      edges,
      prunedEdges,
      new Set(["t", "c", "n"]),
      null
    );
    // Both the direct untaken edge AND the dead descendant edge are pruned.
    expect(path.prunedEdgeIds.sort()).toEqual(["e_y2", "e_yes"]);
    expect(path.traversedEdgeIds.sort()).toEqual(["e_no", "e_t"]);
    expect(skippedNodes).toEqual(new Set(["y", "y2"]));
  });

  it("prunes only the non-matching switch cases, by sourceHandle", () => {
    const edges = [
      edge("e_a", "s", "na", "alpha"),
      edge("e_b", "s", "nb", "beta"),
      edge("e_g", "s", "ng", "gamma"),
    ];
    const skippedNodes = new Set<string>();
    const prunedEdges = new Set<AutomationEdge>();
    for (const handle of ["alpha", "gamma"]) {
      const caseEdges = edges.filter((e) => e.sourceHandle === handle);
      for (const e of caseEdges) prunedEdges.add(e);
      for (const e of caseEdges)
        markDescendantsSkipped(e.target, edges, skippedNodes, prunedEdges);
    }
    const path = computePathTaken(
      edges,
      prunedEdges,
      new Set(["s", "nb"]),
      null
    );
    expect(path.prunedEdgeIds.sort()).toEqual(["e_a", "e_g"]);
    expect(path.traversedEdgeIds).toEqual(["e_b"]);
  });

  it("prunes every outgoing edge when no switch case matched", () => {
    const edges = [
      edge("e_a", "s", "na", "alpha"),
      edge("e_b", "s", "nb", "beta"),
    ];
    const skippedNodes = new Set<string>();
    const prunedEdges = new Set<AutomationEdge>();
    for (const e of edges) prunedEdges.add(e);
    for (const e of edges)
      markDescendantsSkipped(e.target, edges, skippedNodes, prunedEdges);
    const path = computePathTaken(edges, prunedEdges, new Set(["s"]), null);
    expect(path.prunedEdgeIds.sort()).toEqual(["e_a", "e_b"]);
    expect(path.traversedEdgeIds).toEqual([]);
  });

  it("keeps a diamond's join edge live — merge reachable from the taken branch", () => {
    // c --yes--> y --> j ; c --no--> n --> j   (j is the join)
    const edges = [
      edge("e_yes", "c", "y", "yes"),
      edge("e_no", "c", "n", "no"),
      edge("e_yj", "y", "j"),
      edge("e_nj", "n", "j"),
    ];
    const skippedNodes = new Set<string>();
    const prunedEdges = new Set<AutomationEdge>();
    const untaken = edges.filter((e) => e.sourceHandle === "yes");
    for (const e of untaken) prunedEdges.add(e);
    for (const e of untaken)
      markDescendantsSkipped(e.target, edges, skippedNodes, prunedEdges);
    const path = computePathTaken(
      edges,
      prunedEdges,
      new Set(["c", "n", "j"]),
      null
    );
    // The join node survives, so only the dead branch's edges are pruned.
    expect(path.prunedEdgeIds.sort()).toEqual(["e_yes", "e_yj"]);
    expect(path.traversedEdgeIds.sort()).toEqual(["e_nj", "e_no"]);
    expect(skippedNodes).toEqual(new Set(["y"]));
  });

  it("leaves an edge whose source never ran UNDECIDED (in neither list)", () => {
    // a failed fast; b never ran ⇒ e2 is not traversed and not pruned.
    const edges = [edge("e1", "t", "a"), edge("e2", "b", "c")];
    const path = computePathTaken(edges, new Set(), new Set(["t"]), null);
    expect(path.traversedEdgeIds).toEqual(["e1"]);
    expect(path.prunedEdgeIds).toEqual([]);
  });

  it("union-merges onto the previous value (delay resumption), deduped", () => {
    const edges = [edge("e1", "t", "a"), edge("e2", "a", "b")];
    const path = computePathTaken(edges, new Set(), new Set(["t", "a"]), {
      traversedEdgeIds: ["e1", "e0"],
      prunedEdgeIds: ["e9"],
    });
    expect(path.traversedEdgeIds.sort()).toEqual(["e0", "e1", "e2"]);
    expect(path.prunedEdgeIds).toEqual(["e9"]);
  });

  it("lets a prune win over a previously-claimed traversal", () => {
    const edges = [edge("e1", "t", "a")];
    const path = computePathTaken(edges, new Set([edges[0]!]), new Set(["t"]), {
      traversedEdgeIds: ["e1"],
      prunedEdgeIds: [],
    });
    expect(path.prunedEdgeIds).toEqual(["e1"]);
    expect(path.traversedEdgeIds).toEqual([]);
  });
});
