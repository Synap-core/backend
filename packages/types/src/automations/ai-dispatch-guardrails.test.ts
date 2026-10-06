import { describe, it, expect } from "vitest";
import {
  AI_DISPATCH_GUARDRAILS,
  findUnfilteredAiFanouts,
  isAiDispatchNode,
  readMaxAiDispatchesPerDay,
  unfilteredAiFanoutError,
} from "./ai-dispatch-guardrails.js";
import { AUTOMATION_SKIP_REASONS } from "./rule-run-policy.js";
import { humanizeToken } from "../vocabulary/index.js";

/** The incident's shape: cron → query(company, no filter) → loop → AI body. */
function incidentFlow(query: Record<string, unknown>, body = "playbook_run") {
  return {
    nodes: [
      { id: "t", type: "trigger", data: {} },
      {
        id: "q",
        type: "query",
        data: { profileSlug: "company", limit: 100, ...query },
      },
      {
        id: "l",
        type: "loop",
        data: {
          iteratorExpression: "{{steps.q.output.entities}}",
          itemVariable: "c",
        },
      },
      { id: "b", type: body, data: { playbookName: "advance" } },
    ],
    edges: [
      { id: "e1", source: "t", target: "q" },
      { id: "e2", source: "q", target: "l" },
      { id: "e3", source: "l", target: "b" },
    ],
  };
}

describe("required filter on an AI fan-out", () => {
  it("rejects the incident's flow: empty filter feeding a loop that starts AI work", () => {
    for (const filter of [undefined, "", "   ", {}, []]) {
      const errors = findUnfilteredAiFanouts(incidentFlow({ filter }));
      expect(errors, JSON.stringify(filter)).toHaveLength(1);
      expect(errors[0]).toContain("[q]");
      expect(errors[0]).toContain('scope: "all"');
    }
  });

  it("rejects an IS command body exactly like a playbook body", () => {
    expect(
      findUnfilteredAiFanouts(incidentFlow({ filter: "" }, "command"))
    ).toHaveLength(1);
  });

  it('accepts a real filter, or an explicit scope: "all"', () => {
    expect(
      findUnfilteredAiFanouts(incidentFlow({ filter: "status = 'active'" }))
    ).toEqual([]);
    expect(
      findUnfilteredAiFanouts(incidentFlow({ filter: { status: "active" } }))
    ).toEqual([]);
    expect(
      findUnfilteredAiFanouts(incidentFlow({ filter: "", scope: "all" }))
    ).toEqual([]);
  });

  it("the pod lens is NOT an acknowledgement (it narrows rows, not the fan-out)", () => {
    expect(
      findUnfilteredAiFanouts(incidentFlow({ filter: "", scope: "pod" }))
    ).toHaveLength(1);
  });

  it("leaves a loop with no AI body alone (an entity write per row is not paid work)", () => {
    expect(
      findUnfilteredAiFanouts(incidentFlow({ filter: "" }, "output"))
    ).toEqual([]);
  });

  it("propose / appointment playbook nodes start no agent, so they need no filter", () => {
    for (const mode of ["propose", "appointment"]) {
      const flow = incidentFlow({ filter: "" });
      (flow.nodes[3]!.data as Record<string, unknown>).mode = mode;
      expect(findUnfilteredAiFanouts(flow), mode).toEqual([]);
    }
  });

  it("finds the feed through the iterator even with no query → loop edge", () => {
    const flow = incidentFlow({ filter: "" });
    flow.edges = flow.edges.filter((e) => e.id !== "e2");
    flow.edges.push({ id: "e2b", source: "t", target: "l" });
    expect(findUnfilteredAiFanouts(flow)).toHaveLength(1);
  });

  it("reaches an AI node deeper in the loop body chain", () => {
    const flow = incidentFlow({ filter: "" }, "transform");
    flow.nodes.push({
      id: "cmd",
      type: "command",
      data: { playbookName: "x" },
    });
    flow.edges.push({ id: "e4", source: "b", target: "cmd" });
    expect(findUnfilteredAiFanouts(flow)).toHaveLength(1);
  });

  it("is tolerant of junk (never throws at a door)", () => {
    for (const junk of [null, undefined, 1, "x", {}, { nodes: 1, edges: [] }]) {
      expect(findUnfilteredAiFanouts(junk)).toEqual([]);
    }
    expect(unfilteredAiFanoutError(incidentFlow({ filter: "x" }))).toBeNull();
    expect(unfilteredAiFanoutError(incidentFlow({}))).toMatch(
      /^Invalid automation flow: /
    );
  });
});

describe("AI dispatch classification", () => {
  it("counts IS commands and run-mode playbook runs only", () => {
    expect(isAiDispatchNode({ type: "command" })).toBe(true);
    expect(isAiDispatchNode({ type: "playbook_run", data: {} })).toBe(true);
    expect(
      isAiDispatchNode({ type: "playbook_run", data: { mode: "run" } })
    ).toBe(true);
    expect(
      isAiDispatchNode({ type: "playbook_run", data: { mode: "propose" } })
    ).toBe(false);
    expect(isAiDispatchNode({ type: "output" })).toBe(false);
    expect(isAiDispatchNode(null)).toBe(false);
  });
});

describe("maxAiDispatchesPerDay", () => {
  it("defaults when absent", () => {
    expect(readMaxAiDispatchesPerDay({})).toEqual({
      ok: true,
      value: AI_DISPATCH_GUARDRAILS.maxAiDispatchesPerDayDefault,
    });
    expect(readMaxAiDispatchesPerDay(null)).toMatchObject({ ok: true });
  });
  it("accepts a whole number and rejects anything else", () => {
    expect(readMaxAiDispatchesPerDay({ maxAiDispatchesPerDay: 5 })).toEqual({
      ok: true,
      value: 5,
    });
    for (const bad of [0, -1, 1.5, "5", 10_001]) {
      expect(
        readMaxAiDispatchesPerDay({ maxAiDispatchesPerDay: bad }).ok,
        String(bad)
      ).toBe(false);
    }
  });
});

describe("the new skip reasons humanize", () => {
  it("renders through the vocabulary, never a raw token", () => {
    expect(humanizeToken(AUTOMATION_SKIP_REASONS.coolingDown)).toBe(
      "Cooling down"
    );
    expect(
      humanizeToken(AUTOMATION_SKIP_REASONS.aiDispatchCapReached)
    ).not.toContain("_");
  });
});
