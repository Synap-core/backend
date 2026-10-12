/**
 * A batch run proposal's title (`data.summary`, composed by
 * `batchRunWords` in @synap/jobs through the vocabulary door) is what the
 * pod's display hands EVERY renderer — browser and relay read `summary`, they
 * build no title of their own for a playbook run. Pinned here because the
 * display only KEEPS a stored summary that names the object; one that did not
 * would be silently replaced by the generic `Run Template "<name>"`, losing
 * the count.
 */
import { describe, it, expect } from "vitest";
import { batchRunWords } from "@synap/jobs/utils/automation-governance.js";
import { proposalDisplaySummary } from "../display.js";

describe("a batch run proposal reads well in the existing renderers", () => {
  it("the display keeps the batch title, count and all", () => {
    const { summary } = batchRunWords({
      count: 12,
      subjectKind: "lead",
      playbookName: "Qualify a lead",
    });
    expect(summary).toBe('Run Template "Qualify a lead" for 12 new leads');
    expect(
      proposalDisplaySummary({
        proposalType: "run",
        // A stored row: `run` / `playbook` are outside the typed CRUD unions,
        // exactly as `buildRequestFromProposal` reads them off the row.
        request: {
          summary,
          changeType: "run",
          targetType: "playbook",
          data: {},
        } as never,
        targetName: "Qualify a lead",
      })
    ).toBe(summary);
  });
});
