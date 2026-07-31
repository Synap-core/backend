import { describe, it, expect } from "vitest";
import {
  validateFlowDefinition,
  flowValidationErrorMessage,
  FLOW_NODE_TYPES,
} from "./validate-flow.js";
import { buildPlaybookRunFlowDefinition } from "../playbooks/cron-automation.js";

/**
 * Pure-function contract test for the author-time flow validation gate.
 * No DB — the structural + contract checks that catch real bugs run without a
 * resolver; the resolver-gated existence checks are exercised separately.
 */

// A well-formed flow that exercises MANY node types + valid condition/switch
// handles + valid channel_message target + a valid output.
function wellFormedFlow() {
  return {
    nodes: [
      {
        id: "trigger",
        type: "trigger",
        position: { x: 0, y: 0 },
        data: {
          triggerType: "cron",
          label: "Every day",
          config: { expression: "0 9 * * *" },
        },
      },
      {
        id: "q",
        type: "query",
        position: { x: 0, y: 1 },
        data: { label: "find", profileSlug: "client", filter: "", limit: 10 },
      },
      {
        id: "eread",
        type: "entity_read",
        position: { x: 0, y: 2 },
        data: { entityId: "{{trigger.payload.subjectId}}" },
      },
      {
        id: "rel",
        type: "related_entities",
        position: { x: 0, y: 3 },
        data: { entityId: "{{trigger.payload.subjectId}}" },
      },
      {
        id: "cmp",
        type: "compute",
        position: { x: 0, y: 4 },
        data: { operation: "now" },
      },
      {
        id: "sel",
        type: "select",
        position: { x: 0, y: 5 },
        data: { when: true, ifTrue: 1, ifFalse: 0 },
      },
      {
        id: "clm",
        type: "claim",
        position: { x: 0, y: 6 },
        data: { namespace: "ns", key: "k" },
      },
      {
        id: "grd",
        type: "guard",
        position: { x: 0, y: 7 },
        data: { checks: [{ path: "a", exists: true, message: "need a" }] },
      },
      {
        id: "mq",
        type: "messages_query",
        position: { x: 0, y: 8 },
        data: { label: "msgs", channelId: "ch-1" },
      },
      {
        id: "rq",
        type: "runs_query",
        position: { x: 0, y: 8.5 },
        data: { label: "runs", limit: 20 },
      },
      {
        id: "pq",
        type: "proposals_query",
        position: { x: 0, y: 8.7 },
        data: { label: "proposals", limit: 20 },
      },
      {
        id: "cond",
        type: "condition",
        position: { x: 0, y: 9 },
        data: { label: "c", expression: "trigger.payload.x === 1" },
      },
      {
        id: "sw",
        type: "switch",
        position: { x: 0, y: 10 },
        data: {
          label: "s",
          expression: "{{trigger.status}}",
          cases: [
            { value: "active", label: "Active" },
            { value: "won", label: "Won" },
          ],
        },
      },
      {
        id: "lp",
        type: "loop",
        position: { x: 0, y: 11 },
        data: {
          label: "each",
          iteratorExpression: "steps.q.output.entities",
          itemVariable: "item",
        },
      },
      {
        id: "cmd",
        type: "command",
        position: { x: 0, y: 12 },
        data: { commandTitle: "Analyze", inputMapping: {} },
      },
      {
        id: "tr",
        type: "transform",
        position: { x: 0, y: 13 },
        data: { label: "t", expression: "{{q.output}} | json" },
      },
      {
        id: "ft",
        type: "fetch",
        position: { x: 0, y: 14 },
        data: {
          label: "f",
          method: "GET",
          url: "https://x.test",
          headers: {},
          body: "",
        },
      },
      {
        id: "dl",
        type: "delay",
        position: { x: 0, y: 15 },
        data: { duration: "5m" },
      },
      {
        id: "sk",
        type: "skill",
        position: { x: 0, y: 16 },
        data: { label: "sk", skillId: "skill-123", inputMapping: {} },
      },
      {
        id: "cap",
        type: "capability",
        position: { x: 0, y: 17 },
        data: { verbId: "gmail.send", inputMapping: {} },
      },
      {
        id: "sub",
        type: "sub_automation",
        position: { x: 0, y: 18 },
        data: { label: "sub", automationId: "auto-1", payloadMapping: {} },
      },
      {
        id: "pb",
        type: "playbook_run",
        position: { x: 0, y: 19 },
        data: { label: "pb", playbookId: "pb-1" },
      },
      {
        id: "out",
        type: "output",
        position: { x: 0, y: 20 },
        data: {
          label: "notify",
          outputType: "channel_message",
          config: { channelType: "proactive" },
        },
      },
    ],
    edges: [
      { id: "e1", source: "trigger", target: "q" },
      { id: "e2", source: "q", target: "cond" },
      { id: "e3", source: "cond", target: "cmd", sourceHandle: "yes" },
      { id: "e4", source: "cond", target: "tr", sourceHandle: "no" },
      { id: "e5", source: "cmd", target: "sw" },
      { id: "e6", source: "sw", target: "sk", sourceHandle: "active" },
      { id: "e7", source: "sw", target: "cap", sourceHandle: "won" },
      { id: "e8", source: "cap", target: "out" },
    ],
  };
}

describe("validateFlowDefinition — valid flows", () => {
  it("a well-formed multi-node-type flow → valid", () => {
    const result = validateFlowDefinition(wellFormedFlow());
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("covers all 23 node types (well-formed flow exercises each type)", () => {
    const types = new Set(wellFormedFlow().nodes.map((n) => n.type));
    for (const t of FLOW_NODE_TYPES) {
      expect(types.has(t)).toBe(true);
    }
  });

  it("empty flow (no nodes/edges) → valid", () => {
    expect(validateFlowDefinition({ nodes: [], edges: [] }).valid).toBe(true);
  });

  it("channel_message with explicit channelId → valid", () => {
    const flow = {
      nodes: [
        {
          id: "o",
          type: "output",
          position: { x: 0, y: 0 },
          data: {
            outputType: "channel_message",
            config: { channelId: "ch-1" },
          },
        },
      ],
      edges: [],
    };
    expect(validateFlowDefinition(flow).valid).toBe(true);
  });

  it("channel_message with templated channelId → valid", () => {
    const flow = {
      nodes: [
        {
          id: "o",
          type: "output",
          position: { x: 0, y: 0 },
          data: {
            outputType: "channel_message",
            config: { channelId: "{{steps.mq.output.channelId}}" },
          },
        },
      ],
      edges: [],
    };
    expect(validateFlowDefinition(flow).valid).toBe(true);
  });

  it("targetless channel_message → valid (defaults to the automation's run channel)", () => {
    const flow = {
      nodes: [
        {
          id: "o",
          type: "output",
          position: { x: 0, y: 0 },
          data: { outputType: "channel_message", config: {} },
        },
      ],
      edges: [],
    };
    expect(validateFlowDefinition(flow).valid).toBe(true);
  });

  it("channel_message with channelEntityRef (context-derived) → valid", () => {
    const flow = {
      nodes: [
        {
          id: "o",
          type: "output",
          position: { x: 0, y: 0 },
          data: {
            outputType: "channel_message",
            config: { channelEntityRef: "{{steps.q.output.clientId}}" },
          },
        },
      ],
      edges: [],
    };
    expect(validateFlowDefinition(flow).valid).toBe(true);
  });
});

describe("validateFlowDefinition — keystone regressions (real materializer)", () => {
  it("single playbook_run cron flow (maintenance/hygiene shape) → valid", () => {
    const flow = buildPlaybookRunFlowDefinition("pb-1", {
      playbookName: "CRM Hygiene",
    });
    const result = validateFlowDefinition(flow);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("kind-fan-out query→loop→playbook_run radar flow → valid", () => {
    const flow = buildPlaybookRunFlowDefinition("pb-1", {
      playbookName: "Radar",
      subjectProfile: { profileSlug: "client" },
    });
    const result = validateFlowDefinition(flow);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("seeded auto-tag shape (trigger→command→output entity_update) → valid", () => {
    const flow = {
      nodes: [
        {
          id: "trigger-1",
          type: "trigger",
          position: { x: 250, y: 0 },
          data: {
            triggerType: "event",
            label: "Entity created",
            config: { eventPattern: "entity.create.completed" },
          },
        },
        {
          id: "cmd-analyze",
          type: "command",
          position: { x: 250, y: 150 },
          data: { commandTitle: "Analyze Entities", inputMapping: {} },
        },
        {
          id: "output-tags",
          type: "output",
          position: { x: 250, y: 300 },
          data: {
            label: "Propose tag update",
            outputType: "entity_update",
            config: { entityId: "{{trigger.payload.subjectId}}" },
          },
        },
      ],
      edges: [
        { id: "e1", source: "trigger-1", target: "cmd-analyze" },
        { id: "e2", source: "cmd-analyze", target: "output-tags" },
      ],
    };
    expect(validateFlowDefinition(flow).valid).toBe(true);
  });
});

describe("validateFlowDefinition — malformed flows", () => {
  it("channel_message with unknown (typo'd) channelType → invalid", () => {
    const flow = {
      nodes: [
        {
          id: "o",
          type: "output",
          position: { x: 0, y: 0 },
          data: {
            outputType: "channel_message",
            config: { channelType: "some_random_thing" },
          },
        },
      ],
      edges: [],
    };
    const result = validateFlowDefinition(flow);
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain(
      "channel_message_unknown_channelType"
    );
    expect(result.errors[0].nodeId).toBe("o");
  });

  it("capability with no verbId → invalid (capability_missing_verbId)", () => {
    const flow = {
      nodes: [
        {
          id: "cap",
          type: "capability",
          position: { x: 0, y: 0 },
          data: { inputMapping: {} },
        },
      ],
      edges: [],
    };
    const result = validateFlowDefinition(flow);
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain(
      "capability_missing_verbId"
    );
  });

  it("skill with neither skillId nor skillName → invalid (skill_missing_ref)", () => {
    const flow = {
      nodes: [
        {
          id: "sk",
          type: "skill",
          position: { x: 0, y: 0 },
          data: { inputMapping: {} },
        },
      ],
      edges: [],
    };
    const result = validateFlowDefinition(flow);
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain("skill_missing_ref");
  });

  it("skill referenced by skillName (no skillId) → valid (template-friendly form)", () => {
    const flow = {
      nodes: [
        {
          id: "sk",
          type: "skill",
          position: { x: 0, y: 0 },
          data: { skillName: "daily-digest", inputMapping: {} },
        },
      ],
      edges: [],
    };
    expect(validateFlowDefinition(flow).valid).toBe(true);
  });

  it("playbook_run with neither playbookId nor playbookName → invalid", () => {
    const flow = {
      nodes: [
        {
          id: "pb",
          type: "playbook_run",
          position: { x: 0, y: 0 },
          data: { label: "x" },
        },
      ],
      edges: [],
    };
    const result = validateFlowDefinition(flow);
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain(
      "playbook_run_missing_ref"
    );
  });

  it("unknown node.type → invalid (unknown_node_type)", () => {
    const flow = {
      nodes: [
        {
          id: "x",
          type: "franken_node",
          position: { x: 0, y: 0 },
          data: {},
        },
      ],
      edges: [],
    };
    const result = validateFlowDefinition(flow);
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain("unknown_node_type");
  });

  it("edge to nonexistent node → invalid (edge_bad_target)", () => {
    const flow = {
      nodes: [
        {
          id: "a",
          type: "delay",
          position: { x: 0, y: 0 },
          data: { duration: "5m" },
        },
      ],
      edges: [{ id: "e1", source: "a", target: "ghost" }],
    };
    const result = validateFlowDefinition(flow);
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain("edge_bad_target");
  });

  it("edge from nonexistent node → invalid (edge_bad_source)", () => {
    const flow = {
      nodes: [
        {
          id: "a",
          type: "delay",
          position: { x: 0, y: 0 },
          data: { duration: "5m" },
        },
      ],
      edges: [{ id: "e1", source: "ghost", target: "a" }],
    };
    const result = validateFlowDefinition(flow);
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain("edge_bad_source");
  });

  it("a cycle → invalid (flow_has_cycle)", () => {
    const flow = {
      nodes: [
        {
          id: "a",
          type: "delay",
          position: { x: 0, y: 0 },
          data: { duration: "1m" },
        },
        {
          id: "b",
          type: "delay",
          position: { x: 0, y: 1 },
          data: { duration: "1m" },
        },
        {
          id: "c",
          type: "delay",
          position: { x: 0, y: 2 },
          data: { duration: "1m" },
        },
      ],
      edges: [
        { id: "e1", source: "a", target: "b" },
        { id: "e2", source: "b", target: "c" },
        { id: "e3", source: "c", target: "a" },
      ],
    };
    const result = validateFlowDefinition(flow);
    expect(result.valid).toBe(false);
    const cycleErr = result.errors.find((e) => e.code === "flow_has_cycle");
    expect(cycleErr).toBeDefined();
    expect(cycleErr!.message).toContain("a");
    expect(cycleErr!.message).toContain("b");
    expect(cycleErr!.message).toContain("c");
  });

  it("output with bad outputType → invalid (output_bad_outputType)", () => {
    const flow = {
      nodes: [
        {
          id: "o",
          type: "output",
          position: { x: 0, y: 0 },
          data: { outputType: "teleport", config: {} },
        },
      ],
      edges: [],
    };
    const result = validateFlowDefinition(flow);
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain("output_bad_outputType");
  });

  it("loop with no iteratorExpression → invalid", () => {
    const flow = {
      nodes: [
        {
          id: "lp",
          type: "loop",
          position: { x: 0, y: 0 },
          data: { label: "each", itemVariable: "item" },
        },
      ],
      edges: [],
    };
    const result = validateFlowDefinition(flow);
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain("loop_missing_iterator");
  });

  it("condition with no expression → invalid", () => {
    const flow = {
      nodes: [
        {
          id: "c",
          type: "condition",
          position: { x: 0, y: 0 },
          data: { label: "c" },
        },
      ],
      edges: [],
    };
    const result = validateFlowDefinition(flow);
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain(
      "condition_missing_expression"
    );
  });

  it("switch with no cases → invalid", () => {
    const flow = {
      nodes: [
        {
          id: "sw",
          type: "switch",
          position: { x: 0, y: 0 },
          data: { label: "s", expression: "{{x}}", cases: [] },
        },
      ],
      edges: [],
    };
    const result = validateFlowDefinition(flow);
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain("switch_missing_cases");
  });

  it("condition edge with a bad handle → invalid (condition_bad_handle)", () => {
    const flow = {
      nodes: [
        {
          id: "c",
          type: "condition",
          position: { x: 0, y: 0 },
          data: { expression: "x === 1" },
        },
        {
          id: "d",
          type: "delay",
          position: { x: 0, y: 1 },
          data: { duration: "1m" },
        },
      ],
      edges: [{ id: "e1", source: "c", target: "d", sourceHandle: "maybe" }],
    };
    const result = validateFlowDefinition(flow);
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain("condition_bad_handle");
  });

  it("switch edge with a handle matching no case → invalid (switch_bad_handle)", () => {
    const flow = {
      nodes: [
        {
          id: "sw",
          type: "switch",
          position: { x: 0, y: 0 },
          data: { expression: "{{x}}", cases: [{ value: "a", label: "A" }] },
        },
        {
          id: "d",
          type: "delay",
          position: { x: 0, y: 1 },
          data: { duration: "1m" },
        },
      ],
      edges: [{ id: "e1", source: "sw", target: "d", sourceHandle: "zzz" }],
    };
    const result = validateFlowDefinition(flow);
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain("switch_bad_handle");
  });

  it("duplicate node ids → invalid (duplicate_node_id)", () => {
    const flow = {
      nodes: [
        {
          id: "a",
          type: "delay",
          position: { x: 0, y: 0 },
          data: { duration: "1m" },
        },
        {
          id: "a",
          type: "delay",
          position: { x: 0, y: 1 },
          data: { duration: "1m" },
        },
      ],
      edges: [],
    };
    const result = validateFlowDefinition(flow);
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain("duplicate_node_id");
  });

  it("non-object flow → invalid (flow_not_object)", () => {
    const result = validateFlowDefinition(null);
    expect(result.valid).toBe(false);
    expect(result.errors[0].code).toBe("flow_not_object");
  });
});

describe("validateFlowDefinition — resolver-gated existence checks", () => {
  const capNode = {
    nodes: [
      {
        id: "cap",
        type: "capability",
        position: { x: 0, y: 0 },
        data: { verbId: "unknown.verb", inputMapping: {} },
      },
    ],
    edges: [],
  };

  it("without a resolver → verbId existence is NOT checked (valid)", () => {
    expect(validateFlowDefinition(capNode).valid).toBe(true);
  });

  it("with a resolver that rejects the verb → invalid", () => {
    const result = validateFlowDefinition(capNode, {
      verbExists: () => false,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain(
      "capability_unknown_verbId"
    );
  });

  it("with a resolver that accepts the verb → valid", () => {
    expect(
      validateFlowDefinition(capNode, { verbExists: () => true }).valid
    ).toBe(true);
  });
});

describe("flowValidationErrorMessage", () => {
  it("valid flow → null", () => {
    expect(flowValidationErrorMessage({ nodes: [], edges: [] })).toBeNull();
  });

  it("invalid flow → a joined actionable string naming the node", () => {
    const msg = flowValidationErrorMessage({
      nodes: [
        {
          id: "cap",
          type: "capability",
          position: { x: 0, y: 0 },
          data: {},
        },
      ],
      edges: [],
    });
    expect(msg).toContain("Invalid automation flow");
    expect(msg).toContain("[cap]");
    expect(msg).toContain("verbId");
  });
});
