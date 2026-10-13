/**
 * A batch run proposal STARTS ONE SESSION PER SUBJECT, so the pod's display
 * names it by the sessions it creates (`buildRunSessionStartTitle`) — not by
 * the rule's stored `Run Template "<name>" for N new leads` sentence
 * (`batchRunWords` in @synap/jobs), which named the mechanism. Browser and
 * relay read `summary`, so this is the title EVERY renderer shows; the count
 * must survive whether or not the subjects' names resolved.
 */
import { describe, it, expect } from "vitest";
import { batchRunWords } from "@synap/jobs/utils/automation-governance.js";
import { proposalDisplaySummary } from "../display.js";

const subjectIds = Array.from({ length: 12 }, (_, i) => `subject-${i}`);

function displayOf(runSubjectNames?: Array<string | undefined>) {
  const { summary } = batchRunWords({
    count: 12,
    subjectKind: "lead",
    playbookName: "Qualify a lead",
  });
  return proposalDisplaySummary({
    proposalType: "run",
    // A stored row: `run` / `playbook` are outside the typed CRUD unions,
    // exactly as `buildRequestFromProposal` reads them off the row.
    request: {
      summary,
      changeType: "run",
      targetType: "playbook",
      data: { subjectId: subjectIds[0], subjectIds },
    } as never,
    targetName: "Qualify a lead",
    ...(runSubjectNames ? { runSubjectNames } : {}),
  });
}

describe("a batch run proposal reads as the sessions it starts", () => {
  it("names the first subject and how many more", () => {
    expect(displayOf(["Ada", undefined, "Grace"])).toBe(
      "Qualify a lead · Ada + 11 more"
    );
  });

  it("keeps the count when no subject resolved", () => {
    expect(displayOf()).toBe("Qualify a lead · 12 sessions");
  });
});
