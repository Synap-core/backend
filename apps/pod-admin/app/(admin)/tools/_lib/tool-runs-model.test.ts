import { describe, expect, it } from "vitest";
import { actionLabelFor, capabilityFlows, runningNow } from "./tool-runs-model";

describe("actionLabelFor — an action run's name in words", () => {
  const label = actionLabelFor([{ verbId: "gmail_send", label: "Send email" }]);
  it("the capability's own label for its verb wins", () => {
    expect(label("gmail_send")).toBe("Send email");
  });
  it("anything else goes through the vocabulary, never the raw token", () => {
    expect(label("create_document")).toBe("Created document");
    expect(label("frobnicate_thing")).toBe("Frobnicate thing");
  });
});

describe("runningNow — what runs now, newest first", () => {
  const flows = [
    { flowType: "automation" as const, flowId: "a1", name: "Inbox sweep" },
  ];
  const label = actionLabelFor([{ verbId: "chart_csv", label: "Chart a CSV" }]);

  it("keeps only running runs, from the actions and the flows (wrong rule: the latest runs are what is running)", () => {
    const rows = runningNow({
      actionRuns: [
        {
          id: "r1",
          flowName: "chart_csv",
          status: "running",
          startedAt: "2026-10-30T10:00:00Z",
        },
        {
          id: "r2",
          flowName: "chart_csv",
          status: "completed",
          startedAt: "2026-10-30T11:00:00Z",
        },
      ],
      flows,
      histories: [
        {
          flowType: "automation",
          flowId: "a1",
          runs: [
            { id: "f1", status: "running", startedAt: "2026-10-30T12:00:00Z" },
            { id: "f2", status: "failed", startedAt: "2026-10-30T09:00:00Z" },
          ],
        },
      ],
      actionLabel: label,
    });
    expect(rows).toEqual([
      {
        key: "automation:f1",
        flowType: "automation",
        id: "f1",
        name: "Inbox sweep",
        startedAt: "2026-10-30T12:00:00Z",
      },
      {
        key: "capability:r1",
        flowType: "capability",
        id: "r1",
        name: "Chart a CSV",
        startedAt: "2026-10-30T10:00:00Z",
      },
    ]);
  });

  it("nothing running is an empty list (the page then omits the section)", () => {
    expect(
      runningNow({ actionRuns: [], flows, histories: [], actionLabel: label })
    ).toEqual([]);
  });
});

describe("capabilityFlows", () => {
  it("the rules and templates among a capability's parts", () => {
    expect(
      capabilityFlows([
        { kind: "skill", id: "s1" },
        { kind: "automation", id: "a1", name: "Sweep" },
        { kind: "playbook", id: "p1", name: "Triage" },
        { kind: "tool", id: "t1" },
      ])
    ).toEqual([
      { flowType: "automation", flowId: "a1", name: "Sweep" },
      { flowType: "playbook", flowId: "p1", name: "Triage" },
    ]);
  });
});
