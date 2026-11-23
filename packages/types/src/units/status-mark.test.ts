import { describe, expect, it } from "vitest";
import {
  LIFECYCLE_CATEGORY_TONE,
  resolveRunUnitState,
  resolveStatusTone,
} from "./state.js";
import {
  LIVE_RUN_FEED_STATUSES,
  STATUS_MACHINES,
  statusMark,
  type StatusMachine,
} from "./status-mark.js";

const AMBER = LIFECYCLE_CATEGORY_TONE.paused;

describe("statusMark", () => {
  it("marks every declared status of every machine with its category", () => {
    const machines = Object.keys(STATUS_MACHINES) as StatusMachine[];
    expect(machines.length).toBeGreaterThanOrEqual(8);
    for (const machine of machines) {
      const declaration = STATUS_MACHINES[machine] as Record<
        string,
        { category: string }
      >;
      for (const [status, { category }] of Object.entries(declaration)) {
        const mark = statusMark(machine, status)!;
        expect(mark.category, `${machine}.${status}`).toBe(category);
        expect(mark.label, `${machine}.${status}`).not.toBe("");
        expect(mark.label, `${machine}.${status}`).not.toBe(status);
        expect(mark.glyph, `${machine}.${status}`).toBeTruthy();
      }
    }
  });

  it("a run that has not ended wears whose turn it is, glyph and tone", () => {
    for (const word of [
      "queued",
      "running",
      "waiting_on_you",
      "blocked",
      "blocked_by_policy",
      "paused",
      "stale",
      "proposed",
    ]) {
      const view = resolveRunUnitState(word);
      expect(statusMark("run", word), word).toMatchObject({
        outcome: null,
        tone: view.tone,
        glyph: view.glyph,
        turn: view.state,
      });
    }
    // Nobody picked it up: the person's turn, never an error.
    expect(statusMark("run", "blocked")).toMatchObject({
      turn: "needs_you",
      glyph: "person",
    });
    expect(statusMark("run", "queued")!.turn).toBe("not_started");
    // A policy hold, a pause and the person's turn wear three marks.
    const tones = [
      "blocked_by_policy",
      "paused",
      "waiting_on_you",
      "running",
    ].map((w) => statusMark("run", w)!.tone);
    expect(new Set(tones).size).toBe(4);
    expect(resolveStatusTone("blocked")).toBe(AMBER);
  });

  it("a run that changed nothing or reached its limit is amber, not a crash", () => {
    expect(
      statusMark("run", "failed", { stopReason: "no_effect" })
    ).toMatchObject({
      outcome: "no_effect",
      label: "No change",
      tone: AMBER,
      glyph: "dashed-circle",
      turn: null,
    });
    expect(statusMark("run", "failed", { stopReason: "budget" })).toMatchObject(
      { outcome: "not_done", label: "Stopped at its limit", tone: AMBER }
    );
    // Its stages kept ending early: a fault of the run.
    expect(
      statusMark("run", "failed", { stopReason: "stages_left" })
    ).toMatchObject({
      outcome: "failed",
      label: "Failed",
      tone: "error",
      glyph: "alert",
    });
  });

  it("an automation stopped on error and a proposal that could not apply are faults", () => {
    expect(statusMark("automation", "error")).toMatchObject({
      outcome: "failed",
      label: "Stopped on error",
      tone: "error",
      glyph: "alert",
    });
    expect(statusMark("proposal", "approval_failed")).toMatchObject({
      outcome: "failed",
      tone: "error",
    });
    expect(statusMark("automation", "paused")).toMatchObject({
      tone: AMBER,
      glyph: "pause",
    });
  });

  it("a precondition skip and a cancel end calm; a failure is red", () => {
    expect(statusMark("run", "skipped")).toMatchObject({
      outcome: "cancelled",
      label: "Skipped",
      tone: "textMuted",
    });
    expect(statusMark("run", "cancelled")).toMatchObject({
      outcome: "cancelled",
      tone: "textMuted",
      glyph: "stopped",
    });
    expect(statusMark("session", "failed")).toMatchObject({
      outcome: "failed",
      tone: "error",
    });
    expect(statusMark("automation", "archived")!.outcome).toBe("cancelled");
  });

  it("a session closed with required work open is not drawn as delivered", () => {
    expect(
      statusMark("session", "closed", { closedNotDone: true })
    ).toMatchObject({
      category: "done",
      outcome: "not_done",
      label: "Not done",
      tone: AMBER,
      glyph: "stopped",
    });
    expect(
      statusMark("session", "closed", { closedNotDone: false })
    ).toMatchObject({
      outcome: "done",
      tone: LIFECYCLE_CATEGORY_TONE.done,
      glyph: "check",
    });
    // The fact belongs to sessions: another machine's done is done.
    expect(
      statusMark("run", "completed", { closedNotDone: true })!.outcome
    ).toBe("done");
  });

  it("Cancel takes every run word still going, the feed's paused included", () => {
    expect(LIVE_RUN_FEED_STATUSES).toEqual(
      expect.arrayContaining([
        "queued",
        "running",
        "blocked",
        "paused",
        "stale",
      ])
    );
    expect(LIVE_RUN_FEED_STATUSES).not.toContain("proposed");
    expect(LIVE_RUN_FEED_STATUSES).not.toContain("completed");
  });

  it("an undeclared word is muted and humanized, never guessed", () => {
    expect(statusMark("run", "half_way")).toMatchObject({
      category: null,
      outcome: null,
      label: "Half way",
      tone: "textMuted",
      glyph: "question",
    });
    expect(statusMark("run", "  ")).toBeNull();
    expect(statusMark("run", null)).toBeNull();
  });

  it("speaks the reader's language", () => {
    expect(
      statusMark("run", "failed", { stopReason: "no_effect", locale: "fr" })!
        .label
    ).toBe("Aucun changement");
  });
});
