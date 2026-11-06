/**
 * The stored config for "a PR recorded on a Fix a finding session merges →
 * its stage is `merged`" and "the pod deploys a build containing it →
 * `verified`" (finding 8c08b138, wave "Work moves its things" S3) passes the
 * author-time flow gate the automation door runs, and uses only the doors
 * this lane added: `whenPlaybookId` on `session_update` and the
 * `sessionIds` the pod stamps on `dev.deployed`. These are the exact
 * definitions handed to the founder to store (DISABLED) once the doors are
 * live; keep them equal to the card on the lane's session.
 */

import { describe, it, expect } from "vitest";
import { validateFlowDefinition } from "../../automations/validate-flow.js";

const FIX_A_FINDING = "18abd1ea-290e-4bd7-b9e6-97cb5a82477b";

const FIX_A_FINDING_MERGED_FLOW = {
  nodes: [
    {
      id: "t",
      type: "trigger",
      position: { x: 0, y: 0 },
      data: {
        label: "A PR merged",
        triggerType: "event",
        config: { eventPattern: "dev.pr_merged" },
      },
    },
    {
      id: "has-session",
      type: "guard",
      position: { x: 0, y: 120 },
      data: {
        label: "The PR is one session's, and landed on the default branch",
        checks: [
          {
            path: "trigger.payload.data.sessionId",
            minLength: 36,
            message:
              "No one session recorded this PR: nothing to move (the merge sweeper still completed its outcome).",
          },
          {
            path: "trigger.payload.data.intoDefault",
            equals: true,
            message:
              "Merged into a branch that is not the default one: not delivered yet.",
          },
        ],
      },
    },
    {
      id: "to-merged",
      type: "output",
      position: { x: 0, y: 240 },
      data: {
        label: "Move a Fix a finding session to merged",
        outputType: "session_update",
        config: {
          sessionId: "{{trigger.payload.data.sessionId}}",
          whenPlaybookId: FIX_A_FINDING,
          currentStage: "merged",
        },
      },
    },
  ],
  edges: [
    { id: "e1", source: "t", target: "has-session" },
    { id: "e2", source: "has-session", target: "to-merged" },
  ],
};

const FIX_A_FINDING_VERIFIED_FLOW = {
  nodes: [
    {
      id: "t",
      type: "trigger",
      position: { x: 0, y: 0 },
      data: {
        label: "A build is live",
        triggerType: "event",
        config: { eventPattern: "dev.deployed" },
      },
    },
    {
      id: "each-session",
      type: "loop",
      position: { x: 0, y: 120 },
      data: {
        label: "Each open session whose PR this build carries",
        iteratorExpression: "trigger.payload.data.sessionIds",
        itemVariable: "sessionId",
      },
    },
    {
      id: "to-verified",
      type: "output",
      position: { x: 0, y: 240 },
      data: {
        label: "Move a Fix a finding session to verified",
        outputType: "session_update",
        config: {
          sessionId: "{{loop.item}}",
          whenPlaybookId: FIX_A_FINDING,
          currentStage: "verified",
        },
      },
    },
  ],
  edges: [
    { id: "e1", source: "t", target: "each-session" },
    { id: "e2", source: "each-session", target: "to-verified" },
  ],
};

describe("the Fix a finding stage automations", () => {
  it.each([
    ["merged", FIX_A_FINDING_MERGED_FLOW],
    ["verified", FIX_A_FINDING_VERIFIED_FLOW],
  ])("the %s flow passes the flow gate", (_name, flow) => {
    const r = validateFlowDefinition(flow);
    expect(r.errors).toEqual([]);
    expect(r.valid).toBe(true);
  });

  it("both act only on sessions following Fix a finding", () => {
    for (const flow of [
      FIX_A_FINDING_MERGED_FLOW,
      FIX_A_FINDING_VERIFIED_FLOW,
    ]) {
      const step = flow.nodes.find((n) => n.type === "output")!;
      expect(
        (step.data as { config: Record<string, unknown> }).config
      ).toMatchObject({ whenPlaybookId: FIX_A_FINDING });
    }
  });
});
