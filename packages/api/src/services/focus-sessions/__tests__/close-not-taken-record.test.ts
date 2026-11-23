/**
 * The skip record (decision arms, P5) is the close door's alone: a caller's
 * report can never carry `notTaken`, because the dependency rule reads it as
 * "skipped" and frees the step's dependents. Pure: the report the door writes.
 */
import { describe, it, expect } from "vitest";
import { withoutCallerCloseRecord } from "../complete-session.js";
import { notTakenRecorded } from "../session-closed-as.js";

const record = {
  decisionId: "d-1",
  option: "bootstrap",
  chosenOption: "raise",
  at: "2026-11-22T00:00:00.000Z",
};

describe("withoutCallerCloseRecord — the door's own records only", () => {
  it("drops a caller-sent notTaken (rules out 'an agent frees dependents by writing a report')", () => {
    expect(
      withoutCallerCloseRecord({ summary: "x", notTaken: record }, undefined)
    ).toEqual({ summary: "x" });
  });

  it("writes the door's own notTaken, beside the caller's fields", () => {
    expect(
      withoutCallerCloseRecord({ summary: "x" }, undefined, record)
    ).toEqual({ summary: "x", notTaken: record });
    expect(withoutCallerCloseRecord(undefined, undefined, record)).toEqual({
      notTaken: record,
    });
  });

  it("CONTROL: no record, no caller report, nothing written; null still clears", () => {
    expect(withoutCallerCloseRecord(undefined, undefined)).toBeUndefined();
    expect(withoutCallerCloseRecord(null, undefined, record)).toBeNull();
  });
});

describe("notTakenRecorded — a work-graph node's `skipped`", () => {
  it("a cancelled step with the door's record is skipped", () => {
    expect(
      notTakenRecorded({
        status: "cancelled",
        verificationReport: { notTaken: record },
      })
    ).toBe(true);
  });
  it("CONTROL: a plain cancel, another status, or a malformed record is not (rules out 'every cancel reads skipped')", () => {
    expect(
      notTakenRecorded({ status: "cancelled", verificationReport: null })
    ).toBe(false);
    expect(
      notTakenRecorded({
        status: "closed",
        verificationReport: { notTaken: record },
      })
    ).toBe(false);
    expect(
      notTakenRecorded({
        status: "cancelled",
        verificationReport: { notTaken: "yes" },
      })
    ).toBe(false);
  });
});
