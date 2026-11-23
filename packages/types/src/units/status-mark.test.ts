import { describe, expect, it } from "vitest";
import { LIFECYCLE_CATEGORY_TONE, resolveStatusTone } from "./state.js";
import {
  STATUS_MACHINES,
  statusMark,
  type StatusMachine,
} from "./status-mark.js";

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
      }
    }
  });

  it("a run nobody picked up is a hold, never an error", () => {
    const mark = statusMark("run", "blocked")!;
    expect(mark.category).toBe("paused");
    expect(mark.tone).toBe(LIFECYCLE_CATEGORY_TONE.paused);
    expect(mark.tone).not.toBe("error");
    expect(resolveStatusTone("blocked")).toBe(LIFECYCLE_CATEGORY_TONE.paused);
    expect(statusMark("run", "blocked_by_policy")!.tone).toBe(
      LIFECYCLE_CATEGORY_TONE.paused
    );
  });

  it("a queued run has not started", () => {
    const mark = statusMark("run", "queued")!;
    expect(mark).toMatchObject({
      category: "open",
      outcome: null,
      label: "Queued",
    });
    expect(mark.tone).toBe(LIFECYCLE_CATEGORY_TONE.open);
  });

  it("a failed run whose turn changed nothing reads as no change, not a crash", () => {
    const noEffect = statusMark("run", "failed", { stopReason: "no_effect" })!;
    // One tone table: the same tone as the write receipt's "No change".
    expect(noEffect.tone).toBe(resolveStatusTone("no_effect"));
    expect(noEffect).toMatchObject({
      outcome: "no_effect",
      label: "No change",
    });
    expect(noEffect.tone).not.toBe("error");
    const failed = statusMark("run", "failed", { stopReason: "budget" })!;
    expect(failed).toMatchObject({
      outcome: "failed",
      label: "Failed",
      tone: "error",
    });
  });

  it("a run skipped by its precondition did nothing; it did not succeed", () => {
    expect(statusMark("run", "skipped")).toMatchObject({
      outcome: "no_effect",
      label: "Skipped",
    });
    expect(statusMark("run", "skipped")!.tone).not.toBe(
      LIFECYCLE_CATEGORY_TONE.done
    );
  });

  it("a cancel ends calm; a failure is red", () => {
    expect(statusMark("run", "cancelled")).toMatchObject({
      outcome: "cancelled",
      tone: "textMuted",
    });
    expect(statusMark("session", "failed")).toMatchObject({
      outcome: "failed",
      tone: "error",
    });
    expect(statusMark("automation", "archived")!.outcome).toBe("cancelled");
  });

  it("a session closed with required work open is not drawn as delivered", () => {
    const notDone = statusMark("session", "closed", { closedNotDone: true })!;
    expect(notDone).toMatchObject({
      category: "done",
      outcome: "not_done",
      label: "Not done",
    });
    expect(notDone.tone).not.toBe(LIFECYCLE_CATEGORY_TONE.done);
    const done = statusMark("session", "closed", { closedNotDone: false })!;
    expect(done).toMatchObject({
      outcome: "done",
      tone: LIFECYCLE_CATEGORY_TONE.done,
    });
    // The fact belongs to sessions: another machine's done is done.
    expect(
      statusMark("run", "completed", { closedNotDone: true })!.outcome
    ).toBe("done");
  });

  it("an undeclared word is muted and humanized, never guessed", () => {
    expect(statusMark("run", "half_way")).toMatchObject({
      category: null,
      outcome: null,
      label: "Half way",
      tone: "textMuted",
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
