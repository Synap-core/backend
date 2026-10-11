import { describe, expect, it } from "vitest";
import { deriveTrackStages } from "./track.js";
import {
  TRACK_MOVE_ON_REQUIRES_MET_CRITERIA,
  trackHeaderFact,
  trackMoveOn,
  trackSelectedStepKey,
  trackStepCard,
  trackStepEvidenceSessionId,
  trackStepRail,
  type TrackStepEvidence,
} from "./track-step.js";

const SNAPSHOT = [
  { key: "audit", name: "Audit" },
  {
    key: "decide",
    name: "Decide",
    goal: "Pick the direction",
    gate: { kind: "check" },
    criteria: [
      { key: "options", statement: "Three options compared" },
      { key: "owner_ok", statement: "Owner signed off" },
      { key: "nice_to_have", statement: "Risks listed", required: false },
      { key: "no_statement" },
    ],
  },
  { key: "build", name: "Build" },
];

const stagesAt = (current: string | null, counts?: Record<string, number>) =>
  deriveTrackStages(SNAPSHOT, current, counts);

const HISTORY = [
  { stageKey: "audit", fromStage: null, enteredAt: "2026-10-01T00:00:00Z", actor: "u1" },
  { stageKey: "decide", fromStage: "audit", enteredAt: "2026-10-02T00:00:00Z", actor: "u1" },
  { stageKey: "audit", fromStage: "decide", enteredAt: "2026-10-03T00:00:00Z", actor: "u2" },
  { stageKey: "decide", fromStage: "audit", enteredAt: "2026-10-04T00:00:00Z", actor: "agent-7" },
];

const ALL_PASS: TrackStepEvidence = {
  status: "ok",
  evaluations: [
    { criterionKey: "options", verdict: "pass" },
    { criterionKey: "owner_ok", verdict: "pass" },
    { criterionKey: "no_statement", verdict: "pass" },
  ],
};

describe("trackStepRail / trackSelectedStepKey", () => {
  it("numbers the steps, marks the current one with the shared tone", () => {
    const rail = trackStepRail(stagesAt("decide"));
    expect(rail.map((r) => [r.number, r.position, r.tone, r.isCurrent])).toEqual([
      [1, "done", "success", false],
      [2, "active", "primary", true],
      [3, "not_started", "textMuted", false],
    ]);
    expect(rail.filter((r) => r.isSelected).map((r) => r.key)).toEqual(["decide"]);
  });

  it("selects a requested pinned step; an unknown request falls to the current step", () => {
    const stages = stagesAt("decide");
    expect(trackStepRail(stages, "audit").find((r) => r.isSelected)?.key).toBe("audit");
    expect(trackSelectedStepKey(stages, "nope")).toBe("decide");
    expect(trackSelectedStepKey(stagesAt(null), null)).toBe("audit");
    expect(trackSelectedStepKey([], "audit")).toBeNull();
  });
});

describe("trackStepEvidenceSessionId", () => {
  const row = (
    id: string,
    status: string,
    trackStage: string | null,
    closedAt: string | null,
    updatedAt: string
  ) => ({ id, status, trackStage, closedAt, updatedAt });

  it("prefers the latest CLOSED session over a newer open one", () => {
    const rows = [
      row("open-new", "active", "decide", null, "2026-10-09T00:00:00Z"),
      row("closed-old", "closed", "decide", "2026-10-03T00:00:00Z", "2026-10-03T00:00:00Z"),
      row("closed-new", "closed", "decide", "2026-10-05T00:00:00Z", "2026-10-05T00:00:00Z"),
    ];
    expect(trackStepEvidenceSessionId(rows, "decide")).toBe("closed-new");
  });

  it("falls to the latest open session; never cancelled/failed; never another step's", () => {
    const rows = [
      row("cancelled", "cancelled", "decide", null, "2026-10-09T00:00:00Z"),
      row("failed", "failed", "decide", null, "2026-10-09T00:00:00Z"),
      row("elsewhere", "closed", "audit", "2026-10-09T00:00:00Z", "2026-10-09T00:00:00Z"),
      row("open-old", "active", "decide", null, "2026-10-02T00:00:00Z"),
      row("open-new", "paused", "decide", null, "2026-10-04T00:00:00Z"),
    ];
    expect(trackStepEvidenceSessionId(rows, "decide")).toBe("open-new");
    expect(trackStepEvidenceSessionId(rows.slice(0, 3), "decide")).toBeNull();
  });
});

describe("trackStepCard", () => {
  it("grades each pinned criterion from the evidence verdict", () => {
    const card = trackStepCard(stagesAt("decide"), "decide", HISTORY, {
      status: "ok",
      evaluations: [
        { criterionKey: "options", verdict: "pass" },
        { criterionKey: "owner_ok", verdict: "fail" },
        { criterionKey: "nice_to_have", verdict: "unmeasured" },
      ],
    })!;
    expect(card.criteria).toEqual([
      { key: "options", label: "Three options compared", required: true, state: "met" },
      { key: "owner_ok", label: "Owner signed off", required: true, state: "unmet" },
      { key: "nice_to_have", label: "Risks listed", required: false, state: "unmeasured" },
      { key: "no_statement", label: "No statement", required: true, state: "unmeasured" },
    ]);
    expect(card.criteriaRead).toBe("measured");
    expect(card.goal).toBe("Pick the direction");
    expect(card.gate).toBe("check");
    expect(card.number).toBe(2);
  });

  it("a FAILED read is `unavailable` with its reason — not `no_session`", () => {
    const failed = trackStepCard(stagesAt("decide"), "decide", HISTORY, {
      status: "unavailable",
      reason: "boom",
    })!;
    expect(failed.criteriaRead).toBe("unavailable");
    expect(failed.criteriaReason).toBe("boom");
    expect(failed.criteria.every((c) => c.state === "unmeasured")).toBe(true);
    const none = trackStepCard(stagesAt("decide"), "decide", HISTORY, null)!;
    expect(none.criteriaRead).toBe("no_session");
    expect(none.criteriaReason).toBeNull();
  });

  it("entered by = the LATEST history entry for the step, with the from-step's name", () => {
    const card = trackStepCard(stagesAt("decide"), "decide", HISTORY, null)!;
    expect(card.enteredBy).toEqual({
      actor: "agent-7",
      at: "2026-10-04T00:00:00Z",
      fromStage: { key: "audit", name: "Audit" },
    });
    const first = trackStepCard(stagesAt("decide"), "audit", HISTORY.slice(0, 2), null)!;
    expect(first.enteredBy?.fromStage).toBeNull();
  });

  it("a step not yet reached has no `enteredBy`, even with an old entry", () => {
    // The track moved back to audit; decide's old entry is history, not now.
    const card = trackStepCard(stagesAt("audit"), "decide", HISTORY.slice(0, 3), null)!;
    expect(card.position).toBe("not_started");
    expect(card.enteredBy).toBeNull();
  });

  it("sessionsCount is the pod's count, `null` when not counted (never 0)", () => {
    expect(trackStepCard(stagesAt("decide"), "decide", [], null)!.sessionsCount).toBeNull();
    expect(
      trackStepCard(stagesAt("decide", { decide: 3 }), "decide", [], null)!.sessionsCount
    ).toBe(3);
    expect(
      trackStepCard(stagesAt("decide", {}), "build", [], null)!.sessionsCount
    ).toBe(0);
  });

  it("an unknown step key is `null`", () => {
    expect(trackStepCard(stagesAt("decide"), "nope", [], null)).toBeNull();
  });
});

describe("trackMoveOn (D6a)", () => {
  const card = (evidence: TrackStepEvidence, at = "decide", step = at) =>
    trackStepCard(stagesAt(at), step, HISTORY, evidence)!;
  const active = { status: "active" };

  it("the policy constant is D6a", () => {
    expect(TRACK_MOVE_ON_REQUIRES_MET_CRITERIA).toBe(true);
  });

  it("enabled once every REQUIRED criterion is met — an optional unmet one does not hold it", () => {
    const move = trackMoveOn(stagesAt("decide"), card(ALL_PASS), active);
    expect(move).toEqual({
      next: { key: "build", name: "Build" },
      offered: true,
      enabled: true,
      missing: [],
      block: null,
    });
  });

  it("disabled with the missing labels — unmeasured counts as missing, optional never", () => {
    const move = trackMoveOn(
      stagesAt("decide"),
      card({
        status: "ok",
        evaluations: [
          { criterionKey: "options", verdict: "pass" },
          { criterionKey: "owner_ok", verdict: "fail" },
        ],
      }),
      active
    );
    expect(move.enabled).toBe(false);
    expect(move.offered).toBe(true);
    expect(move.block).toBe("criteria_unmet");
    expect(move.missing).toEqual(["Owner signed off", "No statement"]);
  });

  it("an unreadable grade blocks as `criteria_unreadable`, not `criteria_unmet`", () => {
    const move = trackMoveOn(
      stagesAt("decide"),
      card({ status: "unavailable", reason: "x" }),
      active
    );
    expect(move.enabled).toBe(false);
    expect(move.block).toBe("criteria_unreadable");
  });

  it("a step with no criteria is met vacuously", () => {
    const move = trackMoveOn(stagesAt("audit"), card(null, "audit"), active);
    expect(move.enabled).toBe(true);
    expect(move.next).toEqual({ key: "decide", name: "Decide" });
  });

  it("last step: `next` null, not offered", () => {
    const move = trackMoveOn(stagesAt("build"), card(null, "build"), active);
    expect(move.next).toBeNull();
    expect(move.offered).toBe(false);
    expect(move.block).toBe("last_step");
  });

  it("not offered on a step the track does not stand on, nor on a closed track", () => {
    expect(trackMoveOn(stagesAt("decide"), card(null, "decide", "audit"), active).block).toBe(
      "not_current"
    );
    for (const status of ["completed", "archived"]) {
      const move = trackMoveOn(stagesAt("decide"), card(ALL_PASS), { status });
      expect(move.offered).toBe(false);
      expect(move.block).toBe("track_closed");
    }
  });

  it("a PAUSED track may still move on (the pod allows it)", () => {
    expect(trackMoveOn(stagesAt("decide"), card(ALL_PASS), { status: "paused" }).enabled).toBe(
      true
    );
  });
});

describe("trackHeaderFact", () => {
  it("the stated KPI is the fact", () => {
    expect(
      trackHeaderFact({
        kpi: { label: "Signups", unit: "signups", target: 50, current: 14 },
        stages: stagesAt("decide"),
      })
    ).toEqual({ kind: "kpi", text: "14 of 50 signups" });
    expect(
      trackHeaderFact({ kpi: { label: "Signups", target: 50, current: 0 }, stages: [] })
    ).toEqual({ kind: "kpi", text: "0 of 50 Signups" });
  });

  it("a KPI with no stated current falls to the step fact, through the vocabulary noun", () => {
    expect(
      trackHeaderFact({ kpi: { label: "Signups", target: 50 }, stages: stagesAt("decide") })
    ).toEqual({ kind: "step", text: "Step 2 of 3 · Decide" });
  });

  it("neither a KPI nor a current step: `null` (omit)", () => {
    expect(trackHeaderFact({ kpi: null, stages: stagesAt(null) })).toBeNull();
  });
});
