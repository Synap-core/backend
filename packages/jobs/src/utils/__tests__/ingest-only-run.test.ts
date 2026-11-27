import { describe, it, expect } from "vitest";
import { isIngestOnlyAutomation } from "../ingest-only-run.js";

const INGEST = {
  dataContract: {
    version: 1,
    mode: "ingest",
    gets: [
      {
        id: "g",
        label: "GitHub",
        nodeIds: ["t"],
        origin: "external",
        event: "pr",
      },
    ],
    stores: [{ id: "s", label: "facts", nodeIds: ["o"], resource: "events" }],
    reacts: [],
  },
};

const node = (
  id: string,
  type: string,
  data: Record<string, unknown> = {}
) => ({
  id,
  type,
  data,
});

/** The shape of "GitHub pull requests and checks → dev-loop facts" on the pod. */
const GITHUB_DEV_LOOP = {
  nodes: [
    node("t", "trigger", { triggerType: "webhook" }),
    node("sw", "switch", {
      expression: "{{trigger.payload.headers.x-github-event}}",
      cases: [],
    }),
    node("c", "condition", { expression: "true" }),
    node("g", "guard", {}),
    node("fold-3", "select", { when: true, ifTrue: "a", ifFalse: "b" }),
    node("pr-opened", "output", {
      outputType: "record_observation",
      config: { type: "dev.pr_opened" },
    }),
    node("ci-finished", "output", {
      outputType: "record_observation",
      config: { type: "ci.finished" },
    }),
  ],
  edges: [],
};

describe("isIngestOnlyAutomation: decided from declared facts only", () => {
  it("the GitHub dev-loop ingest (contract ingest, observations only) is ingest-only", () => {
    expect(
      isIngestOnlyAutomation({
        metadata: INGEST,
        flowDefinition: GITHUB_DEV_LOOP,
      })
    ).toBe(true);
  });

  it("set_state and read nodes still only store", () => {
    expect(
      isIngestOnlyAutomation({
        metadata: INGEST,
        flowDefinition: {
          nodes: [
            node("t", "trigger"),
            node("q", "query", { profileSlug: "task" }),
            node("w", "output", {
              outputType: "set_state",
              config: { cursor: 1 },
            }),
          ],
        },
      })
    ).toBe(true);
  });

  it("no contract, a react contract, or an ingest contract that declares reacts: keeps its session", () => {
    const flow = GITHUB_DEV_LOOP;
    expect(
      isIngestOnlyAutomation({ metadata: null, flowDefinition: flow })
    ).toBe(false);
    expect(isIngestOnlyAutomation({ metadata: {}, flowDefinition: flow })).toBe(
      false
    );
    for (const mode of ["react", "ingest_and_react"]) {
      expect(
        isIngestOnlyAutomation({
          metadata: { dataContract: { ...INGEST.dataContract, mode } },
          flowDefinition: flow,
        })
      ).toBe(false);
    }
    expect(
      isIngestOnlyAutomation({
        metadata: {
          dataContract: {
            ...INGEST.dataContract,
            reacts: [
              {
                id: "r",
                label: "notify",
                nodeIds: ["n"],
                kind: "notification",
              },
            ],
          },
        },
        flowDefinition: flow,
      })
    ).toBe(false);
  });

  it("an ingest contract whose flow can ask, post, propose, call out or hand off keeps its session", () => {
    const withNode = (n: ReturnType<typeof node>) => ({
      metadata: INGEST,
      flowDefinition: { nodes: [node("t", "trigger"), n] },
    });
    for (const risky of [
      node("x", "capability", { verbId: "document.update" }),
      node("x", "command", { commandId: "c" }),
      node("x", "playbook_run", { playbookId: "p" }),
      node("x", "sub_automation", {}),
      node("x", "fetch", { method: "POST", url: "https://x" }),
      node("x", "delay", { duration: "1h" }),
      node("x", "loop", {}),
      node("x", "skill", {}),
      node("x", "claim", {}),
      node("x", "output", { outputType: "entity_create" }),
      node("x", "output", { outputType: "entity_update" }),
      node("x", "output", { outputType: "notification" }),
      node("x", "output", { outputType: "channel_message" }),
      node("x", "output", { outputType: "session_update" }),
      node("x", "output", { outputType: "facet_attach" }),
      node("x", "output", {}),
      node("x", "some_future_node", {}),
    ]) {
      expect(isIngestOnlyAutomation(withNode(risky))).toBe(false);
    }
  });

  it("a missing flow is not ingest-only", () => {
    expect(
      isIngestOnlyAutomation({ metadata: INGEST, flowDefinition: null })
    ).toBe(false);
  });
});
