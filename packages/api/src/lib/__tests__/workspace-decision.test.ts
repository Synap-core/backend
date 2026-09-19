/**
 * The IS workspace-decision door's answer → a capture's workspace pick, and
 * its distribution → the route decision event.
 *
 * NOT COVERED here: the call sites in `routers/capture.ts` (awaiting the
 * parallel decision, the step-1c deterministic override clearing the record,
 * `capture.execute` spreading the record into the event). Those are proven
 * only by the typecheck; this file pins the pure rules they delegate to.
 */

import { describe, it, expect } from "vitest";
import {
  applyDecisionModelPick,
  toWorkspaceDecisionRecord,
  type WorkspacePickFields,
} from "../workspace-decision.js";
import { workspaceDecisionEventData } from "../ai-events.js";

const CANDIDATES = [
  { id: "ws-fin", name: "Finance", description: "money" },
  { id: "ws-crm", name: "CRM" },
];
const AMBIENT = "ws-fin";

function structurerPick(): WorkspacePickFields {
  return {
    targetWorkspaceId: "ws-fin",
    targetWorkspaceName: "Finance",
    targetWorkspaceReason: "structurer guess",
    targetWorkspaceConfidence: 0.7,
  };
}

describe("applyDecisionModelPick", () => {
  it("a JEV pick replaces the structurer's pick and carries its distribution", () => {
    const target = structurerPick();
    const record = applyDecisionModelPick(
      target,
      {
        workspaceId: "ws-crm",
        confidence: 0.83,
        reason: 'Best fit: "CRM" (83%)',
        decider: "jev",
        model: "jev-1.13",
        probabilities: { "ws-fin": 0.12, "ws-crm": 0.83, none: 0.05 },
      },
      CANDIDATES,
      AMBIENT
    );
    expect(target).toEqual({
      targetWorkspaceId: "ws-crm",
      targetWorkspaceName: "CRM",
      targetWorkspaceReason: 'Best fit: "CRM" (83%)',
      targetWorkspaceConfidence: 0.83,
    });
    expect(record).toEqual({
      decider: "jev",
      model: "jev-1.13",
      probabilities: { "ws-fin": 0.12, "ws-crm": 0.83, none: 0.05 },
      candidates: [
        { id: "ws-fin", name: "Finance" },
        { id: "ws-crm", name: "CRM" },
      ],
    });
  });

  it("a JEV abstain keeps the capture in the ambient workspace with no confidence", () => {
    const target = structurerPick();
    target.targetWorkspaceId = "ws-crm";
    const record = applyDecisionModelPick(
      target,
      {
        workspaceId: null,
        confidence: 0,
        reason: "No workspace clearly fits",
        decider: "jev",
        probabilities: { "ws-fin": 0.2, "ws-crm": 0.3, none: 0.5 },
      },
      CANDIDATES,
      AMBIENT
    );
    expect(target.targetWorkspaceId).toBe(AMBIENT);
    expect(target.targetWorkspaceName).toBe("Finance");
    expect(target.targetWorkspaceConfidence).toBeNull();
    expect(record?.probabilities?.none).toBe(0.5);
  });

  it("an id outside the candidate set is an abstain, never a move", () => {
    const target = structurerPick();
    applyDecisionModelPick(
      target,
      { workspaceId: "ws-other", confidence: 0.9, reason: "?", decider: "jev" },
      CANDIDATES,
      AMBIENT
    );
    expect(target.targetWorkspaceId).toBe(AMBIENT);
    expect(target.targetWorkspaceConfidence).toBeNull();
  });

  it("an LLM answer (or none) leaves the structurer's pick untouched", () => {
    for (const decision of [
      {
        workspaceId: "ws-crm",
        confidence: 0.9,
        reason: "llm",
        decider: "llm" as const,
      },
      null,
      undefined,
    ]) {
      const target = structurerPick();
      expect(
        applyDecisionModelPick(target, decision, CANDIDATES, AMBIENT)
      ).toBeUndefined();
      expect(target).toEqual(structurerPick());
    }
  });
});

describe("toWorkspaceDecisionRecord", () => {
  it("records no distribution for the IS's deterministic (<2 candidate) answers", () => {
    expect(
      toWorkspaceDecisionRecord(
        { workspaceId: "ws-crm", confidence: 1, reason: "only one" },
        CANDIDATES
      )
    ).toBeUndefined();
  });
});

describe("workspaceDecisionEventData", () => {
  it("never overwrites the route event's own fields when spread into it", () => {
    const event = {
      chosenWorkspaceId: "ws-crm",
      confidence: null,
      reason: "r",
      ...workspaceDecisionEventData({
        decider: "jev",
        model: "jev-1.13",
        probabilities: { "ws-crm": 0.8, none: 0.2 },
        candidates: [{ id: "ws-crm", name: "CRM" }],
      }),
    };
    expect(event.confidence).toBeNull();
    expect(event.reason).toBe("r");
    expect(event.chosenWorkspaceId).toBe("ws-crm");
    expect(event).toMatchObject({
      decider: "jev",
      decisionModel: "jev-1.13",
      probabilities: { "ws-crm": 0.8, none: 0.2 },
      candidates: [{ id: "ws-crm", name: "CRM" }],
    });
  });

  it("an absent distribution adds no fields (absent, not empty)", () => {
    expect(workspaceDecisionEventData(undefined)).toEqual({});
    expect(workspaceDecisionEventData(null)).toEqual({});
  });
});
