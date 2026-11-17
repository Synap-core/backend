import { describe, expect, it } from "vitest";
import type { StatusOfWorkItem } from "@synap-core/types/units";
import {
  gatesWaiting,
  holdLine,
  nextMoveLine,
  stagesLeftLine,
  workStages,
  workToShow,
} from "./work-model";

const stopped = (over: Partial<StatusOfWorkItem> = {}): StatusOfWorkItem => ({
  sessionId: "s-stopped",
  name: "Make a film — Bees",
  kind: "run",
  status: "failed",
  label: "Failed",
  category: "lost",
  tone: "error",
  on: "subject",
  playbookId: "pb",
  roomId: null,
  run: {
    id: "run-1",
    status: "failed",
    label: "Failed",
    category: "lost",
    stopReason: "stages_left",
    error: "Stopped at Script with 2 stages left",
    startedAt: "2026-11-16T09:00:00.000Z",
    completedAt: "2026-11-16T10:00:00.000Z",
  },
  stages: {
    status: "ok",
    current: "script",
    items: [
      { key: "brief", name: "Brief", position: "done", entry: null },
      { key: "script", name: "Script", position: "current", entry: null },
      { key: "draft", name: "Draft", position: "left", entry: null },
      { key: "publish", name: "Publish", position: "left", entry: null },
    ],
  },
  gates: {
    status: "ok",
    items: [
      {
        stageKey: "draft",
        stageName: "Draft",
        kind: "human",
        state: "pending",
        proposalId: "p-1",
        decidedByHuman: false,
      },
      {
        stageKey: "publish",
        stageName: "Publish",
        kind: "check",
        state: "by_criteria",
        decidedByHuman: false,
      },
    ],
  },
  asks: { status: "ok", total: 0, items: [] },
  proposals: { status: "ok", total: 0, items: [] },
  holder: { kind: "nobody", waitKind: null, since: null, agentName: null },
  live: { status: "ok", state: "idle", lastActivityAt: null },
  stopped: {
    at: { key: "script", name: "Script" },
    left: [
      { key: "draft", name: "Draft" },
      { key: "publish", name: "Publish" },
    ],
    label: "Stopped at Script",
  },
  lastCompletion: null,
  nextMove: {
    kind: "stopped_early",
    actor: "user",
    label: "Stopped at Script",
    reason: "The run ended.",
  },
  continue: {
    at: { key: "script", name: "Script" },
    left: [],
    label: "Continue at Script",
  },
  link: "x",
  ...over,
});

const quiet = (over: Partial<StatusOfWorkItem> = {}): StatusOfWorkItem =>
  stopped({
    sessionId: "s-quiet",
    status: "active",
    stopped: null,
    continue: undefined,
    stages: { status: "ok", current: null, items: [] },
    gates: { status: "ok", items: [] },
    nextMove: {
      kind: "none",
      actor: "none",
      label: "Nothing waiting",
      reason: "",
    },
    ...over,
  });

describe("work-model — what the work section draws", () => {
  it("a run that stopped early never reads 'Nothing waiting'", () => {
    const line = nextMoveLine(
      stopped({
        nextMove: {
          kind: "none",
          actor: "none",
          label: "Nothing waiting",
          reason: "",
        },
      })
    );
    expect(line?.label).toBe("Stopped at Script");
    expect(line?.yours).toBe(true);
  });

  it("an item with nothing to say is left out, and no item omits the section", () => {
    expect(workToShow({ items: [quiet()], truncated: false })).toEqual({
      kind: "none",
    });
    expect(workToShow(undefined)).toEqual({ kind: "none" });
  });

  it("a failed read is its own state, never 'nothing'", () => {
    expect(workToShow({ status: "unavailable" })).toEqual({ kind: "failed" });
  });

  it("stopped runs lead", () => {
    const shown = workToShow({
      items: [quiet({ gates: stopped().gates }), stopped()],
      truncated: true,
    });
    expect(
      shown.kind === "items" && shown.items.map((i) => i.sessionId)
    ).toEqual(["s-stopped", "s-quiet"]);
    expect(shown.kind === "items" && shown.truncated).toBe(true);
  });

  it("joins each stage with its gate; only a person's pending gate waits", () => {
    const stages = workStages(stopped())!;
    expect(
      stages.map((s) => [s.key, s.position, s.gate?.state ?? null])
    ).toEqual([
      ["brief", "done", null],
      ["script", "current", null],
      ["draft", "left", "pending"],
      ["publish", "left", "by_criteria"],
    ]);
    expect(gatesWaiting(stopped()).map((g) => g.proposalId)).toEqual(["p-1"]);
    expect(stagesLeftLine(stopped())).toBe("2 stages left: Draft, Publish");
  });

  it("an unread stage list is null (the section says so), not empty", () => {
    expect(
      workStages(stopped({ stages: { status: "unavailable", reason: "x" } }))
    ).toBeNull();
  });

  it("says a hold in words", () => {
    expect(
      holdLine({
        on: "person",
        reason: "the brief",
        resumeTo: "active",
        since: "2026-11-16T09:00:00.000Z",
      })
    ).toBe("On hold · waiting on person · the brief");
    expect(holdLine({ on: "unspecified", resumeTo: null, since: "x" })).toBe(
      "On hold"
    );
  });
});
