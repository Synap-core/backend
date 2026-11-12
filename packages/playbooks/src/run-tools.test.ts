/**
 * The class of a run and the tools of a turn (plan 08e4fba7, decisions 3 and
 * 4): one-shot gets nothing, short gets the reads, long its floor; a
 * declared list adds only run tools; a stage list narrows its playbook's.
 */
import { describe, expect, it } from "vitest";
import { runsOnPodAi } from "./index.js";
import {
  activeToolsList,
  isRunToolName,
  LONG_RUN_FLOOR,
  normalizeToolEntry,
  readToolsList,
  RUN_TOOL_FLOORS,
  RUN_TOOL_NAMES,
  runClassOf,
  runTurnToolNames,
  SHORT_RUN_FLOOR,
  stageToolsOutsidePlaybook,
} from "./run-tools.js";

const st = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  ...extra,
});

describe("runClassOf", () => {
  it("generate is one-shot, whatever its stages", () => {
    expect(
      runClassOf({ executor: "generate", stages: [st("a"), st("b"), st("c")] })
    ).toBe("one-shot");
  });
  it("an IS run with at most 2 stages and no gate is short (an absent executor is is-agent)", () => {
    expect(runClassOf({ executor: "is-agent", stages: [] })).toBe("short");
    expect(runClassOf({ stages: [st("a"), st("b")] })).toBe("short");
    expect(runClassOf({ executor: "hybrid", stages: "not a list" })).toBe(
      "short"
    );
  });
  it("3+ stages, a gate, or an external agent is long", () => {
    expect(
      runClassOf({ executor: "is-agent", stages: [st("a"), st("b"), st("c")] })
    ).toBe("long");
    expect(
      runClassOf({
        executor: "is-agent",
        stages: [st("a", { gate: { kind: "human" } })],
      })
    ).toBe("long");
    expect(runClassOf({ executor: "external-agent", stages: [] })).toBe("long");
    // A gate key holding null is no gate.
    expect(runClassOf({ stages: [st("a", { gate: null })] })).toBe("short");
  });
});

describe("the floors and the vocabulary", () => {
  it("one-shot has none, short the reads, long the core tools, the relation read, its own and the run-history reads; short is inside long", () => {
    expect(RUN_TOOL_FLOORS["one-shot"]).toEqual([]);
    for (const t of SHORT_RUN_FLOOR) expect(LONG_RUN_FLOOR).toContain(t);
  });
  it("the long floor holds the run-history reads (plan fbfadf54 fix 1.5)", () => {
    for (const t of ["list_playbooks", "list_sessions", "get_session"])
      expect(LONG_RUN_FLOOR).toContain(t);
  });
  it("a long run drives its own session (decision 832469a0); a short one reads only", () => {
    for (const t of [
      "update_run",
      "post_in_room",
      "get_brand_kit",
      "graph_traverse",
    ]) {
      expect(LONG_RUN_FLOOR).toContain(t);
      expect(SHORT_RUN_FLOOR).not.toContain(t);
      expect(isRunToolName(t)).toBe(true);
    }
  });
  it("every floor tool is a declarable run tool; no tool that names ANY session is", () => {
    for (const t of LONG_RUN_FLOOR) expect(isRunToolName(t)).toBe(true);
    for (const t of [
      "update_session",
      "start_session",
      "relay_answer",
      "proactive_post",
    ])
      expect(RUN_TOOL_NAMES).not.toContain(t);
    expect(new Set(RUN_TOOL_NAMES).size).toBe(RUN_TOOL_NAMES.length);
  });
});

describe("runTurnToolNames", () => {
  it("is the floor, then the declared RUN tools only, each once", () => {
    expect(
      runTurnToolNames("short", [
        "get_entity",
        "web_search",
        "search_external",
        "fireflies",
      ])
    ).toEqual([...SHORT_RUN_FLOOR, "web_search"]);
  });
});

describe("activeToolsList and the stage subset", () => {
  const stages = [
    st("draft", { tools: ["update_document", "web_search"] }),
    st("send"),
  ];
  it("an active stage with a list narrows the playbook's (entries outside it are dropped)", () => {
    expect(
      activeToolsList(["update_document", "send_message"], stages, "draft")
    ).toEqual(["update_document"]);
  });
  it("a stage with no list, or no active stage, gets the playbook's list", () => {
    expect(activeToolsList(["update_document"], stages, "send")).toEqual([
      "update_document",
    ]);
    expect(activeToolsList(["update_document"], stages, null)).toEqual([
      "update_document",
    ]);
  });
  it("stageToolsOutsidePlaybook names what a stage lists and its playbook does not", () => {
    expect(
      stageToolsOutsidePlaybook(
        ["update_document"],
        ["update_document", "web_search"]
      )
    ).toEqual(["web_search"]);
  });
});

describe("the MCP spelling of a run tool", () => {
  it("synap_<run tool> reads as the run tool; any other entry stays as it is", () => {
    expect(normalizeToolEntry("synap_list_playbooks")).toBe("list_playbooks");
    expect(normalizeToolEntry("synap_update_session")).toBe(
      "synap_update_session"
    );
    expect(normalizeToolEntry("github.pr_checks")).toBe("github.pr_checks");
  });
  it("a tools list reads MCP spellings once, as run tools, so a stage list stays a subset", () => {
    expect(
      readToolsList(["synap_get_session", "get_session", "synap_web_search"])
    ).toEqual(["get_session", "web_search"]);
    expect(
      activeToolsList(
        readToolsList(["get_session"]),
        [st("read", { tools: ["synap_get_session"] })],
        "read"
      )
    ).toEqual(["get_session"]);
  });
});

describe("runsOnPodAi", () => {
  it("no runner, self, synap_ai and a persona are the pod's AI; an agent, role or engine is not", () => {
    expect(runsOnPodAi(undefined)).toBe(true);
    expect(runsOnPodAi("self")).toBe(true);
    expect(runsOnPodAi(["synap_ai", { synapAi: { persona: "x" } }])).toBe(true);
    expect(runsOnPodAi(["self", { engine: "claude-code" }])).toBe(false);
    expect(runsOnPodAi({ role: "reviewer" })).toBe(false);
    expect(runsOnPodAi({ agentId: "a" })).toBe(false);
  });
});
