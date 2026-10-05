import { describe, expect, it } from "vitest";
import {
  deriveTurnActivity,
  formatTurnSummary,
  turnMark,
  turnToolRowLabel,
  TURN_PHASES,
  TURN_TOOL_STATES,
  type TurnActivityInput,
  type TurnActivityStep,
} from "./turn-activity.js";

// Shaped exactly like the IS's ai-step-factory output (ids differ call→result,
// no shared call id; titles carry the IS's own ellipsis).
const call = (
  n: number,
  toolName: string,
  over: Partial<TurnActivityStep> = {}
): TurnActivityStep => ({
  id: `tool-call-${n}-1700000000000-abc`,
  type: "tool_call",
  toolName,
  content: "Searching your workspace…",
  title: "Searching your workspace…",
  status: "running",
  timestamp: new Date(1_000 * n).toISOString(),
  ...over,
});
const result = (
  n: number,
  toolName: string,
  over: Partial<TurnActivityStep> = {}
): TurnActivityStep => ({
  id: `tool-result-${n}-1700000000000-def`,
  type: "tool_result",
  toolName,
  content: "Searching your workspace — 2 result(s)",
  status: "complete",
  toolOutput: [{ id: "a" }, { id: "b" }],
  timestamp: new Date(1_000 * n + 400).toISOString(),
  ...over,
});
const thinking = (id: string, content: string): TurnActivityStep => ({
  id,
  type: "thinking",
  content,
});

describe("deriveTurnActivity — phase", () => {
  it("is working while streaming, complete after, failed / cancelled on error", () => {
    expect(deriveTurnActivity({ steps: [], streaming: true }).phase).toBe(
      "working"
    );
    expect(deriveTurnActivity({ steps: [], streaming: false }).phase).toBe(
      "complete"
    );
    expect(
      deriveTurnActivity({
        steps: [],
        streaming: false,
        error: { message: "x" },
      }).phase
    ).toBe("failed");
    expect(
      deriveTurnActivity({
        steps: [],
        streaming: false,
        error: { cancelled: true },
      }).phase
    ).toBe("cancelled");
  });
});

describe("deriveTurnActivity — tool states", () => {
  it("pairs call→result through the one rule and settles in place, labels in both moods", () => {
    const a = deriveTurnActivity({
      steps: [call(1, "search_unified"), result(1, "search_unified")],
      streaming: false,
    });
    expect(a.items).toEqual([
      {
        kind: "tool",
        id: "tool-call-1-1700000000000-abc",
        toolName: "search_unified",
        state: "done",
        label: { progressive: "Searching your pod", past: "Searched your pod", imperative: "Search your pod" },
        detail: "2 results",
        durationMs: 400,
      },
    ]);
  });

  it("an open call is running while live, unsettled once the turn ended, cancelled on Stop", () => {
    const steps = [call(1, "web_search")];
    const state = (over: object) =>
      (
        deriveTurnActivity({ steps, streaming: false, ...over }).items[0] as {
          state: string;
        }
      ).state;
    expect(state({ streaming: true })).toBe("running");
    expect(state({})).toBe("unsettled");
    expect(state({ error: { cancelled: true } })).toBe("cancelled");
    expect(
      (
        deriveTurnActivity({
          steps: [call(1, "web_search", { status: "pending" })],
          streaming: true,
        }).items[0] as { state: string }
      ).state
    ).toBe("pending");
  });

  it("a failed result or a failed call is failed, with the reason as detail", () => {
    const a = deriveTurnActivity({
      steps: [
        call(1, "web_fetch"),
        result(1, "web_fetch", {
          type: "error",
          status: "error",
          error: "403",
        }),
        call(2, "get_document", { status: "error", error: "not found" }),
      ],
      streaming: false,
    });
    expect(
      a.items.map((i) => (i.kind === "tool" ? [i.state, i.detail] : null))
    ).toEqual([
      ["failed", "403"],
      ["failed", "not found"],
    ]);
    expect(a.summary.failedCount).toBe(2);
  });

  it("a result that FILED a proposal awaits approval — then follows the proposal's bucket", () => {
    const steps = [
      call(1, "create_entity"),
      result(1, "create_entity", {
        toolOutput: { status: "proposed", proposalId: "p1" },
      }),
    ];
    const at = (bucket?: "applied" | "rejected" | "failed") => {
      const item = deriveTurnActivity({
        steps,
        streaming: false,
        ...(bucket ? { proposalBuckets: { p1: bucket } } : {}),
      }).items[0];
      return item?.kind === "tool" ? [item.state, item.proposalId] : null;
    };
    expect(at()).toEqual(["awaiting_approval", "p1"]);
    expect(at("applied")).toEqual(["done", "p1"]);
    expect(at("rejected")).toEqual(["denied", "p1"]);
    expect(at("failed")).toEqual(["failed", "p1"]);
    const a = deriveTurnActivity({
      steps,
      streaming: false,
      proposals: [{ proposalId: "p1" }],
    });
    expect(a.summary.proposalCount).toBe(1); // deduped across stream + tool output
    expect(a.summary.awaitingCount).toBe(1);
  });

  it("a row speaks past only when the act happened — a filed proposal reads imperative", () => {
    const steps = [
      call(1, "create_entity"),
      result(1, "create_entity", {
        toolOutput: { status: "proposed", proposalId: "p1" },
      }),
    ];
    const rowLabel = (bucket?: "applied" | "rejected") => {
      const item = deriveTurnActivity({
        steps,
        streaming: false,
        ...(bucket ? { proposalBuckets: { p1: bucket } } : {}),
      }).items[0];
      return item?.kind === "tool" ? turnToolRowLabel(item) : null;
    };
    // Waiting on you / rejected: the entity was NOT created.
    expect(rowLabel()).toBe("Create entity");
    expect(rowLabel("rejected")).toBe("Create entity");
    // Approved and applied: now it was.
    expect(rowLabel("applied")).toBe("Created entity");
    const live = deriveTurnActivity({ steps: [call(1, "create_entity")], streaming: true }).items[0];
    expect(live?.kind === "tool" ? turnToolRowLabel(live) : null).toBe("Creating entity");
  });

  it("a FAILED bucket read reads its filed proposal as unknown — never calm awaiting", () => {
    const steps = [
      call(1, "create_entity"),
      result(1, "create_entity", {
        toolOutput: { status: "proposed", proposalId: "p1" },
      }),
    ];
    const read = (over: Partial<TurnActivityInput>) =>
      deriveTurnActivity({ steps, streaming: false, ...over });
    const failed = read({ proposalBucketsUnavailable: true });
    const tool = failed.items[0];
    expect(tool?.kind === "tool" ? tool.state : null).toBe("unknown");
    expect(failed.summary.awaitingCount).toBe(0);
    // A bucket that WAS read still wins over the failed flag (partial knowledge).
    const known = read({ proposalBucketsUnavailable: true, proposalBuckets: { p1: "applied" } }).items[0];
    expect(known?.kind === "tool" ? known.state : null).toBe("done");
    // An unclassified status is not "your turn" either.
    const odd = read({ proposalBuckets: { p1: "unknown" } }).items[0];
    expect(odd?.kind === "tool" ? odd.state : null).toBe("unknown");
    expect(turnMark("unknown")).toEqual({ tone: "textMuted", glyph: "question" });
  });

  it("an unknown tool keeps the producer title before humanizing", () => {
    const a = deriveTurnActivity({
      steps: [call(1, "frobnicate_thing", { title: "Frobbing the widgets…" })],
      streaming: true,
    });
    expect(a.items[0]).toMatchObject({
      label: {
        progressive: "Frobbing the widgets",
        past: "Frobbing the widgets",
      },
    });
    const bare = deriveTurnActivity({
      steps: [call(1, "frobnicate_thing", { title: undefined, content: "" })],
      streaming: true,
    });
    expect(bare.items[0]).toMatchObject({
      label: { progressive: "Frobnicate thing" },
    });
  });

  it("derives a target from the call input when it names one", () => {
    const a = deriveTurnActivity({
      steps: [
        call(1, "web_search", { toolInput: { query: "  q3   roadmap " } }),
      ],
      streaming: true,
    });
    expect(a.items[0]).toMatchObject({ target: "q3 roadmap" });
  });
});

describe("deriveTurnActivity — timeline", () => {
  it("keeps reasoning and tools in arrival order and hides lifecycle noise", () => {
    const a = deriveTurnActivity({
      steps: [
        thinking("t0", "🧠 Assembling context..."),
        thinking("t1", "The user wants last week's notes"),
        call(1, "search_unified"),
        thinking("t2", "Calling get_document"),
        result(1, "search_unified"),
        { id: "e1", type: "error", content: "", error: "Provider timeout" },
      ],
      streaming: false,
    });
    expect(a.items.map((i) => `${i.kind}:${i.id}`)).toEqual([
      "reasoning:t1",
      "tool:tool-call-1-1700000000000-abc",
      "error:e1",
    ]);
    expect(a.summary.reasoningCount).toBe(1);
  });
});

describe("deriveTurnActivity — working label and summary", () => {
  it("names the current tool, else Writing / Thinking; null once settled", () => {
    expect(
      deriveTurnActivity({ steps: [call(1, "web_search")], streaming: true })
        .workingLabel
    ).toBe("Searching the web");
    expect(
      deriveTurnActivity({ steps: [], streaming: true }).workingLabel
    ).toBe("Thinking");
    expect(
      deriveTurnActivity({ steps: [], streaming: true, answering: true })
        .workingLabel
    ).toBe("Writing");
    expect(
      deriveTurnActivity({ steps: [call(1, "web_search")], streaming: false })
        .workingLabel
    ).toBeNull();
  });

  it("measures the span from start to completion; null when unmeasured", () => {
    const a = deriveTurnActivity({
      steps: [call(1, "web_search"), result(1, "web_search")],
      streaming: false,
      startedAt: new Date(0),
      completedAt: new Date(12_300),
    });
    expect(a.summary.thinkingMs).toBe(12_300);
    expect(
      deriveTurnActivity({ steps: [thinking("t", "Hmm")], streaming: false })
        .summary.thinkingMs
    ).toBeNull();
  });

  it("formats the collapsed line from data", () => {
    expect(
      formatTurnSummary({
        thinkingMs: 12_300,
        toolCount: 3,
        failedCount: 1,
        proposalCount: 2,
        awaitingCount: 0,
        reasoningCount: 0,
      })
    ).toBe("Thought 12s · ran 3 tools · 1 failed · 2 proposals");
    expect(
      formatTurnSummary({
        thinkingMs: null,
        toolCount: 1,
        failedCount: 0,
        proposalCount: 1,
        awaitingCount: 0,
        reasoningCount: 0,
      })
    ).toBe("Ran 1 tool · 1 proposal");
    expect(
      formatTurnSummary({
        thinkingMs: null,
        toolCount: 0,
        failedCount: 0,
        proposalCount: 0,
        awaitingCount: 0,
        reasoningCount: 2,
      })
    ).toBe("");
    expect(
      formatTurnSummary({
        thinkingMs: 125_000,
        toolCount: 0,
        failedCount: 0,
        proposalCount: 0,
        awaitingCount: 0,
        reasoningCount: 0,
      })
    ).toBe("Thought 2m");
  });
});

describe("turnMark", () => {
  it("is total over phases and tool states", () => {
    for (const s of [...TURN_PHASES, ...TURN_TOOL_STATES]) {
      expect(turnMark(s).tone).toBeTruthy();
      expect(turnMark(s).glyph).toBeTruthy();
    }
  });

  it("AI yellow marks only live work; a failure is never AI", () => {
    const ai = [...TURN_PHASES, ...TURN_TOOL_STATES].filter(
      (s) => turnMark(s).tone === "ai"
    );
    expect(ai.sort()).toEqual(["running", "working"]);
    expect(turnMark("failed")).toEqual({ tone: "error", glyph: "alert" });
    expect(turnMark("awaiting_approval")).toEqual({
      tone: "primary",
      glyph: "person",
    });
  });
});
