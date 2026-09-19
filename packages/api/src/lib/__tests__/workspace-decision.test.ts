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
  applyTiebreakOutcome,
  buildCapturePlacement,
  pendingSwitchFromPlacement,
  routeDecisionOutcome,
  toWorkspaceDecisionRecord,
  workspaceRuleOfferFor,
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

describe("applyTiebreakOutcome (step 1c: ontology left >1 candidates)", () => {
  const ONTOLOGY = [
    { id: "ws-crm", name: "CRM" },
    { id: "ws-sales", name: "Sales" },
  ];
  const nameOf = (id: string | null | undefined) =>
    ({ "ws-fin": "Finance", "ws-crm": "CRM", "ws-sales": "Sales" })[id ?? ""] ??
    null;
  const PRIOR = { decider: "jev" as const, probabilities: { "ws-crm": 0.8 } };

  it("door UNAVAILABLE (null) keeps a prior pick that is one of the candidates", () => {
    // The discriminating row: the old code treated null as an abstain and
    // threw this valid pick away.
    const target = { ...structurerPick(), targetWorkspaceId: "ws-crm" };
    const record = applyTiebreakOutcome(
      target,
      null,
      ONTOLOGY,
      AMBIENT,
      nameOf,
      PRIOR
    );
    expect(target.targetWorkspaceId).toBe("ws-crm");
    expect(record).toBe(PRIOR);
  });

  it("door UNAVAILABLE with a prior pick outside the candidates stays put", () => {
    const target = { ...structurerPick(), targetWorkspaceId: "ws-other" };
    const record = applyTiebreakOutcome(
      target,
      null,
      ONTOLOGY,
      AMBIENT,
      nameOf,
      PRIOR
    );
    expect(target.targetWorkspaceId).toBe(AMBIENT);
    expect(target.targetWorkspaceConfidence).toBeNull();
    expect(record).toBeUndefined();
  });

  it("a genuine abstain stays put and keeps the door's own reason", () => {
    const target = { ...structurerPick(), targetWorkspaceId: "ws-crm" };
    const record = applyTiebreakOutcome(
      target,
      {
        workspaceId: null,
        confidence: 0,
        reason: "No clear fit — closest was CRM",
        decider: "jev",
      },
      ONTOLOGY,
      AMBIENT,
      nameOf,
      PRIOR
    );
    expect(target.targetWorkspaceId).toBe(AMBIENT);
    expect(target.targetWorkspaceName).toBe("Finance");
    expect(target.targetWorkspaceReason).toBe("No clear fit — closest was CRM");
    expect(record?.decider).toBe("jev");
  });

  it("a pick inside the candidates lands with its distribution", () => {
    const target = structurerPick();
    const record = applyTiebreakOutcome(
      target,
      {
        workspaceId: "ws-sales",
        confidence: 0.7,
        reason: "Fits Sales best · CRM next",
        decider: "llm",
      },
      ONTOLOGY,
      AMBIENT,
      nameOf,
      PRIOR
    );
    expect(target).toMatchObject({
      targetWorkspaceId: "ws-sales",
      targetWorkspaceName: "Sales",
      targetWorkspaceConfidence: 0.7,
    });
    expect(record).toEqual({
      decider: "llm",
      candidates: ONTOLOGY,
    });
  });
});

// ── The capture destination rules ───────────────────────────────────────────

const WS_A = "ws-a";
const WS_B = "ws-b";
const NAMES: Record<string, string> = {
  [WS_A]: "Finance",
  [WS_B]: "Ops",
  "ws-c": "CRM",
};
const nameOfWs = (id: string) => NAMES[id] ?? null;

/** The AI picked WS_B while the caller sat in WS_A, confidently. */
const PICK_B = { workspaceId: WS_B, reason: "Fits Ops best", confidence: 0.9 };

describe("buildCapturePlacement", () => {
  it("a deterministic rung pins, and is NEVER demoted to a suggestion", () => {
    // The discriminating case: a deterministic placement WITH a competing AI
    // pick. A rule that merely preferred `deterministic` over ambient would
    // also pass on a no-pick row; only this one rules out "suggest anyway".
    const placement = buildCapturePlacement({
      ambientWorkspaceId: WS_A,
      deterministic: { workspaceId: WS_B },
      aiPick: { workspaceId: "ws-c", reason: "r", confidence: 0.99 },
      decision: undefined,
      nameOf: nameOfWs,
      routableIds: [WS_A, WS_B, "ws-c"],
    });
    expect(placement).toEqual({
      workspaceId: WS_B,
      workspaceName: "Ops",
      deterministic: true,
    });
    expect(placement.suggestion).toBeUndefined();
  });

  it("a confident pick the caller can reach is offered, ranked, suggestion first", () => {
    const placement = buildCapturePlacement({
      ambientWorkspaceId: WS_A,
      deterministic: null,
      aiPick: PICK_B,
      decision: {
        decider: "jev",
        probabilities: { [WS_A]: 0.05, [WS_B]: 0.6, "ws-c": 0.3, none: 0.05 },
        candidates: [
          { id: WS_A, name: "Finance" },
          { id: WS_B, name: "Ops" },
          { id: "ws-c", name: "CRM" },
        ],
      },
      nameOf: nameOfWs,
      routableIds: [WS_A, WS_B, "ws-c"],
    });
    expect(placement.workspaceId).toBe(WS_A);
    expect(placement.deterministic).toBe(false);
    expect(placement.suggestion?.workspaceId).toBe(WS_B);
    // Suggestion first, then by weight — `none` (abstain) is never a row.
    expect(placement.suggestion?.alternatives).toEqual([
      { workspaceId: WS_B, workspaceName: "Ops", weight: 0.6 },
      { workspaceId: "ws-c", workspaceName: "CRM", weight: 0.3 },
      { workspaceId: WS_A, workspaceName: "Finance", weight: 0.05 },
    ]);
  });

  const noOffer = [
    {
      name: "the pick IS the ambient workspace",
      input: {
        aiPick: { ...PICK_B, workspaceId: WS_A },
        routableIds: [WS_A, WS_B],
      },
    },
    {
      name: "the pick is outside the caller's routable set (membership floor)",
      input: { aiPick: PICK_B, routableIds: [WS_A] },
    },
    {
      name: "the pick is too weak for execute's rung-5 gate",
      input: {
        aiPick: { ...PICK_B, confidence: 0.1 },
        routableIds: [WS_A, WS_B],
      },
    },
    {
      name: "there is no pick at all",
      input: {
        aiPick: { workspaceId: null, reason: null, confidence: null },
        routableIds: [WS_A, WS_B],
      },
    },
  ];
  it.each(noOffer)("no suggestion when $name", ({ input }) => {
    const placement = buildCapturePlacement({
      ambientWorkspaceId: WS_A,
      deterministic: null,
      decision: undefined,
      nameOf: nameOfWs,
      ...input,
    });
    expect(placement.suggestion).toBeUndefined();
    expect(placement.workspaceId).toBe(WS_A);
  });

  it("an offered pick with no distribution carries no 'Why?' rows", () => {
    const placement = buildCapturePlacement({
      ambientWorkspaceId: WS_A,
      deterministic: null,
      aiPick: PICK_B,
      decision: { decider: "llm" },
      nameOf: nameOfWs,
      routableIds: [WS_A, WS_B],
    });
    expect(placement.suggestion?.workspaceId).toBe(WS_B);
    expect(placement.suggestion?.alternatives).toEqual([]);
  });

  it("pendingSwitchFromPlacement carries the suggestion, or nothing", () => {
    const placement = buildCapturePlacement({
      ambientWorkspaceId: WS_A,
      deterministic: null,
      aiPick: PICK_B,
      decision: undefined,
      nameOf: nameOfWs,
      routableIds: [WS_A, WS_B],
    });
    expect(pendingSwitchFromPlacement(placement, 0.9)).toEqual({
      suggestedWorkspaceId: WS_B,
      suggestedWorkspaceName: "Ops",
      reason: "Fits Ops best",
      confidence: 0.9,
    });
    expect(
      pendingSwitchFromPlacement(
        { workspaceId: WS_A, workspaceName: "Finance", deterministic: true },
        1
      )
    ).toBeUndefined();
    expect(pendingSwitchFromPlacement(null, 1)).toBeUndefined();
  });
});

describe("routeDecisionOutcome", () => {
  it("records nothing without an AI pick", () => {
    expect(
      routeDecisionOutcome({
        pinnedWorkspaceId: WS_B,
        aiWorkspaceId: null,
        choice: "accepted",
        pendingSuggestionId: null,
        landedWorkspaceId: WS_B,
      })
    ).toBeNull();
  });

  it("a pin with NO choice is a deliberate placement, not an AI decision", () => {
    // The case that separates "record every pin" from the real rule: a pin
    // arriving with no suggestion in play must not credit the AI with a hit.
    expect(
      routeDecisionOutcome({
        pinnedWorkspaceId: WS_B,
        aiWorkspaceId: WS_A,
        choice: null,
        pendingSuggestionId: null,
        landedWorkspaceId: WS_B,
      })
    ).toBeNull();
  });

  it("a pin that IS the suggestion is applied, with no correction", () => {
    expect(
      routeDecisionOutcome({
        pinnedWorkspaceId: WS_B,
        aiWorkspaceId: WS_B,
        choice: "accepted",
        pendingSuggestionId: WS_B,
        landedWorkspaceId: WS_B,
      })
    ).toEqual({
      chosenWorkspaceId: WS_B,
      applied: true,
      choice: "accepted",
      correction: null,
    });
  });

  it("a pin elsewhere is exactly ONE correction, AI pick → pin", () => {
    expect(
      routeDecisionOutcome({
        pinnedWorkspaceId: WS_A,
        aiWorkspaceId: WS_B,
        choice: "changed",
        pendingSuggestionId: WS_B,
        landedWorkspaceId: WS_A,
      })
    ).toEqual({
      chosenWorkspaceId: WS_B,
      applied: false,
      choice: "changed",
      correction: { fromWorkspaceId: WS_B, toWorkspaceId: WS_A },
    });
  });

  it("an unpinned capture records the SUGGESTION and is never applied", () => {
    // `applied` false is load-bearing: rung 5 proposes, so the data stayed put.
    expect(
      routeDecisionOutcome({
        pinnedWorkspaceId: null,
        aiWorkspaceId: WS_B,
        choice: null,
        pendingSuggestionId: WS_B,
        landedWorkspaceId: WS_A,
      })
    ).toEqual({
      chosenWorkspaceId: WS_B,
      applied: false,
      choice: null,
      correction: null,
    });
  });

  it("an unpinned capture with no suggestion records where it landed", () => {
    expect(
      routeDecisionOutcome({
        pinnedWorkspaceId: null,
        aiWorkspaceId: WS_B,
        choice: null,
        pendingSuggestionId: null,
        landedWorkspaceId: WS_A,
      })
    ).toEqual({
      chosenWorkspaceId: WS_A,
      applied: false,
      choice: null,
      correction: null,
    });
  });
});

describe("workspaceRuleOfferFor", () => {
  const correction = { fromWorkspaceId: WS_B, toWorkspaceId: WS_A };

  it("offers 'always file <kind> here' on a single-kind reroute — never installable", () => {
    expect(
      workspaceRuleOfferFor({
        correction,
        profileSlugs: ["task", "task"],
        nameOf: nameOfWs,
      })
    ).toEqual({
      profileSlug: "task",
      workspaceId: WS_A,
      workspaceName: "Finance",
      installable: false,
      reason: expect.stringContaining("no rule store"),
    });
  });

  it("says nothing when there was no reroute, or no single kind to name", () => {
    expect(
      workspaceRuleOfferFor({
        correction: null,
        profileSlugs: ["task"],
        nameOf: nameOfWs,
      })
    ).toBeUndefined();
    expect(
      workspaceRuleOfferFor({
        correction,
        profileSlugs: ["task", "person"],
        nameOf: nameOfWs,
      })
    ).toBeUndefined();
    expect(
      workspaceRuleOfferFor({ correction, profileSlugs: [], nameOf: nameOfWs })
    ).toBeUndefined();
  });

  it("an unreadable workspace name is null, never a raw id", () => {
    expect(
      workspaceRuleOfferFor({
        correction,
        profileSlugs: ["task"],
        nameOf: () => null,
      })
    ).toMatchObject({ workspaceName: null });
  });
});
