import { describe, it, expect } from "vitest";
import {
  projectToolRuns,
  appendToolRunStep,
  pairToolRunSteps,
  type ToolRunStep,
} from "./tool-runs.js";

const call = (over: Partial<ToolRunStep> = {}): ToolRunStep => ({
  id: "tool-call-1",
  type: "tool_call",
  toolName: "search_unified",
  status: "running",
  ...over,
});

const result = (over: Partial<ToolRunStep> = {}): ToolRunStep => ({
  id: "tool-result-1",
  type: "tool_result",
  toolName: "search_unified",
  status: "complete",
  ...over,
});

describe("projectToolRuns — what becomes a card", () => {
  it("makes a running card from a tool call", () => {
    expect(projectToolRuns([call()])).toEqual([
      {
        id: "tool-call-1",
        toolName: "search_unified",
        label: "Search unified",
        status: "running",
      },
    ]);
  });

  it("EXCLUDES thinking steps — the bubble already shows the turn working", () => {
    const steps: ToolRunStep[] = [
      { id: "s1", type: "thinking", content: "Assembling context" },
      { id: "s2", type: "thinking", title: "Reading memory", toolName: "x" },
    ];
    expect(projectToolRuns(steps)).toEqual([]);
  });

  it("ignores a step with no toolName rather than inventing one", () => {
    expect(projectToolRuns([call({ toolName: undefined })])).toEqual([]);
    expect(projectToolRuns([call({ toolName: "   " })])).toEqual([]);
  });
});

describe("projectToolRuns — labels", () => {
  it("prefers the producer-authored title and drops its trailing ellipsis", () => {
    const [card] = projectToolRuns([
      call({ title: "Searching your workspace…" }),
    ]);
    expect(card!.label).toBe("Searching your workspace");
  });

  it("falls back to content when there is no title", () => {
    const [card] = projectToolRuns([
      call({ content: "Recalling past context…" }),
    ]);
    expect(card!.label).toBe("Recalling past context");
  });

  it("humanizes the raw tool name when the step carries no prose", () => {
    const [card] = projectToolRuns([
      call({
        toolName: "graph_traverse",
        title: undefined,
        content: undefined,
      }),
    ]);
    expect(card!.label).toBe("Graph traverse");
    expect(card!.label).not.toBe("graph_traverse");
  });

  it("never leaves a label empty when the prose was only punctuation", () => {
    const [card] = projectToolRuns([call({ title: "…" })]);
    expect(card!.label).toBe("Search unified");
  });
});

describe("projectToolRuns — settling a call with its result", () => {
  it("settles the call in place instead of adding a second card", () => {
    const cards = projectToolRuns([call(), result({ toolOutput: [1, 2, 3] })]);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.id).toBe("tool-call-1");
    expect(cards[0]!.status).toBe("done");
    expect(cards[0]!.detail).toBe("3 results");
  });

  it("pairs FIFO per tool name across two calls to the same tool", () => {
    const cards = projectToolRuns([
      call({ id: "c1" }),
      call({ id: "c2" }),
      result({ id: "r1", toolOutput: ["a"] }),
    ]);
    expect(cards.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(cards[0]!.status).toBe("done");
    expect(cards[1]!.status).toBe("running");
  });

  it("does not settle a DIFFERENT tool", () => {
    const cards = projectToolRuns([
      call({ id: "c1", toolName: "search_unified" }),
      result({ id: "r1", toolName: "remember_fact", toolOutput: [] }),
    ]);
    expect(cards).toHaveLength(2);
    expect(cards[0]!.status).toBe("running");
    expect(cards[1]!.status).toBe("done");
  });

  it("keeps a result whose call frame never arrived — the tool DID run", () => {
    const cards = projectToolRuns([result({ toolOutput: [1] })]);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.status).toBe("done");
    expect(cards[0]!.detail).toBe("1 result");
  });

  it("preserves CALL order, not settle order", () => {
    const cards = projectToolRuns([
      call({ id: "c1", toolName: "alpha_tool" }),
      call({ id: "c2", toolName: "beta_tool" }),
      result({ id: "r2", toolName: "beta_tool", toolOutput: [] }),
      result({ id: "r1", toolName: "alpha_tool", toolOutput: [] }),
    ]);
    expect(cards.map((c) => c.id)).toEqual(["c1", "c2"]);
  });
});

describe("projectToolRuns — counts", () => {
  it("counts an array, singular at one", () => {
    expect(
      projectToolRuns([call(), result({ toolOutput: ["a"] })])[0]!.detail
    ).toBe("1 result");
    expect(
      projectToolRuns([call(), result({ toolOutput: ["a", "b"] })])[0]!.detail
    ).toBe("2 results");
    expect(
      projectToolRuns([call(), result({ toolOutput: [] })])[0]!.detail
    ).toBe("0 results");
  });

  it("counts a { results: [] } envelope", () => {
    expect(
      projectToolRuns([call(), result({ toolOutput: { results: [1, 2] } })])[0]!
        .detail
    ).toBe("2 results");
  });

  it("invents NO count for an arbitrary payload", () => {
    expect(
      projectToolRuns([call(), result({ toolOutput: { ok: true } })])[0]!.detail
    ).toBeUndefined();
    expect(
      projectToolRuns([call(), result({ toolOutput: "a string" })])[0]!.detail
    ).toBeUndefined();
    expect(projectToolRuns([call(), result({})])[0]!.detail).toBeUndefined();
  });
});

describe("projectToolRuns — failure", () => {
  it("settles as failed on an error step and shows the reason", () => {
    const cards = projectToolRuns([
      call(),
      {
        id: "e1",
        type: "error",
        toolName: "search_unified",
        error: "Timed out",
      },
    ]);
    expect(cards[0]!.status).toBe("failed");
    expect(cards[0]!.detail).toBe("Timed out");
  });

  it("settles as failed on a result whose status is error", () => {
    const cards = projectToolRuns([
      call(),
      result({ status: "error", error: "Permission denied" }),
    ]);
    expect(cards[0]!.status).toBe("failed");
    expect(cards[0]!.detail).toBe("Permission denied");
  });

  it("says Failed rather than nothing when the error carries no message", () => {
    const cards = projectToolRuns([call(), result({ status: "error" })]);
    expect(cards[0]!.status).toBe("failed");
    expect(cards[0]!.detail).toBe("Failed");
  });

  it("a call that arrives already errored is not left spinning forever", () => {
    const cards = projectToolRuns([call({ status: "error", error: "Nope" })]);
    expect(cards[0]!.status).toBe("failed");
    expect(cards[0]!.detail).toBe("Nope");
  });
});

describe("appendToolRunStep", () => {
  it("appends a new step", () => {
    const out = appendToolRunStep([call({ id: "a" })], call({ id: "b" }));
    expect(out.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("REPLACES a step with the same id, in place", () => {
    const out = appendToolRunStep(
      [call({ id: "a" }), call({ id: "b" })],
      call({ id: "a", status: "error" })
    );
    expect(out).toHaveLength(2);
    expect(out.map((s) => s.id)).toEqual(["a", "b"]);
    expect(out[0]!.status).toBe("error");
  });

  it("does not mutate the array it was given", () => {
    const steps = [call({ id: "a" })];
    appendToolRunStep(steps, call({ id: "a", status: "error" }));
    expect(steps[0]!.status).toBe("running");
    expect(steps).toHaveLength(1);
  });
});

describe("pairToolRunSteps — the pairing a raw-step renderer reads", () => {
  it("hands back the RAW steps, each result paired with the oldest open call", () => {
    const steps = [
      { id: "c1", type: "tool_call", toolName: "search", args: { q: 1 } },
      { id: "c2", type: "tool_call", toolName: "search", args: { q: 2 } },
      { id: "r1", type: "tool_result", toolName: "search", toolOutput: [1] },
    ];
    const pairs = pairToolRunSteps(steps);
    expect(pairs.map((p) => [p.call?.id, p.result?.id ?? null])).toEqual([
      ["c1", "r1"],
      ["c2", null],
    ]);
    // Generic: the caller's own fields survive (no projection in between).
    expect(pairs[0]!.call!.args).toEqual({ q: 1 });
  });

  it("a call that failed at birth never takes a later result; an orphan result stands alone", () => {
    const pairs = pairToolRunSteps([
      {
        id: "c1",
        type: "tool_call",
        toolName: "send",
        status: "error",
        error: "no smtp",
      },
      { id: "r1", type: "tool_result", toolName: "send" },
    ]);
    expect(
      pairs.map((p) => [p.call?.id ?? null, p.result?.id ?? null])
    ).toEqual([
      ["c1", null],
      [null, "r1"],
    ]);
  });
});
