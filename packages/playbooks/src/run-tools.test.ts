/**
 * The class of a run and the tools of a turn (plan 08e4fba7, decisions 3 and
 * 4): one-shot gets nothing, short gets 6 reads, long the 19 core tools; a
 * declared list adds only run tools; a stage list narrows its playbook's.
 */
import { describe, expect, it } from "vitest";
import {
  activeToolsList,
  isRunToolName,
  LONG_RUN_FLOOR,
  RUN_TOOL_FLOORS,
  RUN_TOOL_NAMES,
  runClassOf,
  runTurnToolNames,
  SHORT_RUN_FLOOR,
  stageToolsOutsidePlaybook,
} from "./run-tools.js";

const st = (key: string, extra: Record<string, unknown> = {}) => ({ key, ...extra });

describe("runClassOf", () => {
  it("generate is one-shot, whatever its stages", () => {
    expect(runClassOf({ executor: "generate", stages: [st("a"), st("b"), st("c")] })).toBe(
      "one-shot"
    );
  });
  it("an IS run with at most 2 stages and no gate is short (an absent executor is is-agent)", () => {
    expect(runClassOf({ executor: "is-agent", stages: [] })).toBe("short");
    expect(runClassOf({ stages: [st("a"), st("b")] })).toBe("short");
    expect(runClassOf({ executor: "hybrid", stages: "not a list" })).toBe("short");
  });
  it("3+ stages, a gate, or an external agent is long", () => {
    expect(runClassOf({ executor: "is-agent", stages: [st("a"), st("b"), st("c")] })).toBe(
      "long"
    );
    expect(runClassOf({ executor: "is-agent", stages: [st("a", { gate: { kind: "human" } })] })).toBe(
      "long"
    );
    expect(runClassOf({ executor: "external-agent", stages: [] })).toBe("long");
    // A gate key holding null is no gate.
    expect(runClassOf({ stages: [st("a", { gate: null })] })).toBe("short");
  });
});

describe("the floors and the vocabulary", () => {
  it("one-shot has none, short the 6 reads, long the 19 core tools; short is inside long", () => {
    expect(RUN_TOOL_FLOORS["one-shot"]).toEqual([]);
    expect(SHORT_RUN_FLOOR).toHaveLength(6);
    expect(LONG_RUN_FLOOR).toHaveLength(19);
    for (const t of SHORT_RUN_FLOOR) expect(LONG_RUN_FLOOR).toContain(t);
  });
  it("every floor tool is a declarable run tool; no session, ask or room tool is", () => {
    for (const t of LONG_RUN_FLOOR) expect(isRunToolName(t)).toBe(true);
    for (const t of ["update_session", "start_session", "relay_answer", "proactive_post"])
      expect(RUN_TOOL_NAMES).not.toContain(t);
    expect(new Set(RUN_TOOL_NAMES).size).toBe(RUN_TOOL_NAMES.length);
  });
});

describe("runTurnToolNames", () => {
  it("is the floor, then the declared RUN tools only, each once", () => {
    expect(runTurnToolNames("short", ["get_entity", "web_search", "search_external", "fireflies"])).toEqual([
      ...SHORT_RUN_FLOOR,
      "web_search",
    ]);
  });
});

describe("activeToolsList and the stage subset", () => {
  const stages = [st("draft", { tools: ["update_document", "web_search"] }), st("send")];
  it("an active stage with a list narrows the playbook's (entries outside it are dropped)", () => {
    expect(activeToolsList(["update_document", "send_message"], stages, "draft")).toEqual([
      "update_document",
    ]);
  });
  it("a stage with no list, or no active stage, gets the playbook's list", () => {
    expect(activeToolsList(["update_document"], stages, "send")).toEqual(["update_document"]);
    expect(activeToolsList(["update_document"], stages, null)).toEqual(["update_document"]);
  });
  it("stageToolsOutsidePlaybook names what a stage lists and its playbook does not", () => {
    expect(stageToolsOutsidePlaybook(["update_document"], ["update_document", "web_search"])).toEqual([
      "web_search",
    ]);
  });
});
