import { describe, expect, it } from "vitest";
import type { StatusOfWorkItem } from "@synap-core/types/units";
import {
  afterGateDecision,
  continueButton,
  continueEmphasis,
  gateProposalIds,
  gatesWaiting,
  holdLine,
  nextMoveLine,
  offersContinue,
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
        canReview: true,
      },
      {
        stageKey: "publish",
        stageName: "Publish",
        kind: "check",
        state: "by_criteria",
        decidedByHuman: false,
        canReview: false,
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
    canAct: true,
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
  it("a run that stopped early reads the pod's own stopped_early move, never 'Nothing waiting'", () => {
    const line = nextMoveLine(stopped());
    expect(line).toEqual({
      label: "Stopped at Script",
      reason: "The run ended.",
      yours: true,
    });
    // The pod's word is drawn as the pod says it: no client override.
    expect(nextMoveLine(quiet())).toBeNull();
  });

  it("M1: Send back stays 'sent back' (the review path calls rejected, then decided)", () => {
    expect(
      afterGateDecision(afterGateDecision(null, "rejected"), "decided")
    ).toBe("sent_back");
    expect(afterGateDecision(null, "decided")).toBe("approved");
  });

  it("M3: Continue is the loud button only when nothing else waits on the reader", () => {
    // A gate this reader may decide waits: decide it first.
    expect(continueEmphasis(stopped())).toBe("flat");
    const noGate = stopped({ gates: { status: "ok", items: [] } });
    expect(continueEmphasis(noGate)).toBe("solid");
    // A gate someone else decides does not hold the reader back.
    const theirs = stopped();
    if (theirs.gates.status === "ok") theirs.gates.items[0]!.canReview = false;
    expect(continueEmphasis(theirs)).toBe("solid");
    // An owed ask waits on them.
    expect(
      continueEmphasis(
        stopped({
          gates: { status: "ok", items: [] },
          asks: {
            status: "ok",
            total: 1,
            items: [
              { label: "Which cut?", kind: "decision", noun: "Decision" },
            ],
          },
        })
      )
    ).toBe("flat");
  });

  it("M2 / M4: the session page reads the offer and the gate cards from the same read", () => {
    const read = { items: [stopped(), quiet()], truncated: false };
    expect(offersContinue(read)).toBe(true);
    expect([...gateProposalIds(read)]).toEqual(["p-1"]);
    const theirs = stopped();
    theirs.continue = { ...theirs.continue!, canAct: false };
    expect(offersContinue({ items: [theirs], truncated: false })).toBe(false);
    expect(offersContinue({ status: "unavailable" })).toBe(false);
    expect(gateProposalIds(undefined).size).toBe(0);
  });

  it("S4: the stage the run stopped on is marked stopped, not current", () => {
    expect(workStages(stopped())?.map((s) => [s.key, s.stoppedHere])).toEqual([
      ["brief", false],
      ["script", true],
      ["draft", false],
      ["publish", false],
    ]);
    expect(workStages(quiet())).toEqual([]);
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

  it("offers Continue only when the read says THIS reader may (the door's own check)", () => {
    expect(continueButton(stopped())?.label).toBe("Continue at Script");
    const theirs = stopped();
    theirs.continue = { ...theirs.continue!, canAct: false };
    expect(continueButton(theirs)).toBeNull();
    expect(continueButton(quiet())).toBeNull();
  });

  it("a gate waiting on someone else is still said, with no decision for this reader", () => {
    const item = stopped();
    if (item.gates.status === "ok") item.gates.items[0]!.canReview = false;
    expect(gatesWaiting(item).map((g) => [g.proposalId, g.canReview])).toEqual([
      ["p-1", false],
    ]);
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
