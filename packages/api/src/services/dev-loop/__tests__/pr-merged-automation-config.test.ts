/**
 * The stored config the catalog lane ships for "PR merged → grade the merged
 * criterion → move the Ship-a-change step to deploy" (plan v5 T2; the dogfood
 * run starts on `dev.deployed`, in the catalog's own flows) passes the
 * author-time flow gate the automation door runs — so storing it is a
 * proposal, never a refusal. Kept equal to
 * `wt-cb0d-briefs/lanes/be-loop-automation-config.json`.
 */

import { describe, it, expect } from "vitest";
import { validateFlowDefinition } from "../../automations/validate-flow.js";

const PR_MERGED_FLOW = {
  nodes: [
    {
      id: "t",
      type: "trigger",
      position: {
        x: 0,
        y: 0,
      },
      data: {
        label: "A PR merged",
        triggerType: "event",
        config: {
          eventPattern: "dev.pr_merged",
        },
      },
    },
    {
      id: "has-session",
      type: "guard",
      position: {
        x: 0,
        y: 120,
      },
      data: {
        label: "The PR names its session",
        checks: [
          {
            path: "trigger.payload.data.sessionId",
            minLength: 36,
            message:
              "The PR body names no Pod session: nothing to advance (the merge sweeper still completed any outcome whose ref is this PR).",
          },
        ],
      },
    },
    {
      id: "merged-evidence",
      type: "output",
      position: {
        x: 0,
        y: 240,
      },
      data: {
        label: "Grade the merged criterion",
        outputType: "post_evidence",
        config: {
          sessionId: "{{trigger.payload.data.sessionId}}",
          evidence: {
            merged: {
              passed: "true",
              detail: "Merged: {{trigger.payload.data.url}}",
            },
          },
        },
      },
    },
    {
      id: "advance",
      type: "output",
      position: {
        x: 0,
        y: 360,
      },
      data: {
        label: "Move the step to deploy",
        outputType: "session_update",
        config: {
          sessionId: "{{trigger.payload.data.sessionId}}",
          currentStage: "deploy",
        },
      },
    },
  ],
  edges: [
    {
      id: "e1",
      source: "t",
      target: "has-session",
    },
    {
      id: "e2",
      source: "has-session",
      target: "merged-evidence",
    },
    {
      id: "e3",
      source: "merged-evidence",
      target: "advance",
    },
  ],
};

describe("the PR-merged automation config", () => {
  it("passes the flow gate", () => {
    const r = validateFlowDefinition(PR_MERGED_FLOW);
    expect(r.errors).toEqual([]);
    expect(r.valid).toBe(true);
  });

  it("uses the outcome verb this lane added (post_evidence)", () => {
    const types = PR_MERGED_FLOW.nodes
      .filter((n) => n.type === "output")
      .map((n) => (n.data as { outputType?: string }).outputType);
    expect(types).toEqual(["post_evidence", "session_update"]);
  });
});
