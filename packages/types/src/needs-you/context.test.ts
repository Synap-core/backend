/**
 * The needs-you context strip. The outputs read is built by the REAL
 * projection (`projectSessionOutcomes`) from stored slot + criterion shapes —
 * nothing hand-built between the stored session and the strip — so a change to
 * how inputs point at outcomes breaks here, not on a screen.
 */
import { describe, expect, it } from "vitest";
import { CRITERION_SLOT_KIND } from "../focus-sessions/criterion-slot";
import { projectSessionOutcomes } from "../units/outcome";
import { LOOKED_AT_ROW_CAP } from "../ask/card";
import {
  needsYouContextFromOwedSlot,
  needsYouContextFromProposal,
  type NeedsYouSessionRead,
} from "./index";

const criteria = [
  {
    key: "plan-approved",
    statement: "You approved the plan",
    check: { kind: "human" as const },
    stageKey: "plan",
  },
];

const gradeSlot = {
  label: "Grade: plan approved",
  kind: CRITERION_SLOT_KIND,
  criterionKey: "plan-approved",
  owner: "human",
  status: "pending",
  blockedReason: "decision",
  ask: {
    mode: "confirm",
    lookedAt: [
      { kind: "document", id: "d1", title: "Grants audit" },
      { kind: "entity", id: "e1", title: "key grants table" },
      { kind: "view", id: "v1" },
    ],
  },
};

const decisionSlot = {
  label: "Pick a vendor",
  kind: "decision",
  owner: "human",
  status: "pending",
  blockedReason: "decision",
  ask: { mode: "confirm" },
};

const agentSlot = {
  label: "Review checklist",
  kind: "document",
  owner: "agent",
  status: "pending",
};

const outputs = projectSessionOutcomes({
  expectedOutputs: [gradeSlot, decisionSlot, agentSlot],
  criteria,
});

const session: NeedsYouSessionRead = {
  id: "s1",
  title: "Grants audit",
  stages: [
    { key: "plan", name: "Plan" },
    { key: "build", name: "Build" },
  ],
  trackStage: "audit",
};

const aiCanDo = {
  status: "ok" as const,
  items: [{ label: "Review checklist" }],
};

describe("needsYouContextFromOwedSlot", () => {
  it("a criterion slot unblocks its criterion, named with its step", () => {
    const ctx = needsYouContextFromOwedSlot({
      slot: gradeSlot,
      outputs: { status: "ok", value: outputs },
      session: { status: "ok", value: session },
      aiCanDo,
    });
    expect(ctx.unblocks).toEqual({
      criterionKey: "plan-approved",
      label: "You approved the plan",
      step: { key: "plan", name: "Plan" },
      sessionId: "s1",
    });
    expect(ctx.meanwhile).toBe("Review checklist");
    expect(ctx.lookedAt).toHaveLength(LOOKED_AT_ROW_CAP);
    expect(ctx.lookedAt[0]).toEqual({
      kind: "document",
      id: "d1",
      title: "Grants audit",
    });
    expect(ctx.lookedAtTotal).toBe(3);
    // Track stage key with no track read: humanized, never a raw token.
    expect(ctx.from).toEqual({
      sessionId: "s1",
      title: "Grants audit",
      step: { key: "audit", name: "Audit" },
    });
    expect(ctx.unreadable).toEqual([]);
  });

  it("names the track step from the track read when the caller has it", () => {
    const ctx = needsYouContextFromOwedSlot({
      slot: gradeSlot,
      outputs: { status: "ok", value: outputs },
      session: {
        status: "ok",
        value: {
          ...session,
          trackStages: [{ key: "audit", name: "Review the audit" }],
        },
      },
    });
    expect(ctx.from?.step).toEqual({ key: "audit", name: "Review the audit" });
  });

  it("an ordinary decision slot blocks only itself: no Unblocks line", () => {
    const ctx = needsYouContextFromOwedSlot({
      slot: decisionSlot,
      outputs: { status: "ok", value: outputs },
      session: { status: "ok", value: session },
    });
    expect(ctx.unblocks).toBeNull();
    expect(ctx.lookedAt).toEqual([]);
    expect(ctx.lookedAtTotal).toBe(0);
  });

  it("a failed read is named, never folded into an absent line", () => {
    const ctx = needsYouContextFromOwedSlot({
      slot: gradeSlot,
      outputs: { status: "unavailable" },
      session: { status: "unavailable" },
      aiCanDo: { status: "unavailable", reason: "x" },
    });
    expect(ctx.unblocks).toBeNull();
    expect(ctx.meanwhile).toBeNull();
    expect(ctx.from).toBeNull();
    expect(ctx.unreadable).toEqual(["unblocks", "meanwhile", "from"]);
  });

  it("meanwhile never restates the slot being answered", () => {
    const ctx = needsYouContextFromOwedSlot({
      slot: decisionSlot,
      outputs: { status: "ok", value: outputs },
      session: { status: "ok", value: session },
      aiCanDo: { status: "ok", items: [{ label: "pick a vendor " }] },
    });
    expect(ctx.meanwhile).toBeNull();
    expect(ctx.unreadable).toEqual([]);
  });
});

describe("needsYouContextFromProposal", () => {
  it("unblocks the declared slot it claims (key first, then label)", () => {
    const byLabel = needsYouContextFromProposal({
      proposal: {
        sessionId: "s1",
        sessionGoal: "Grants audit goal",
        data: { expectedLabel: " review CHECKLIST" },
      },
      outputs: { status: "ok", value: outputs },
      session: { status: "ok", value: session },
      aiCanDo,
    });
    expect(byLabel.unblocks?.label).toBe("Review checklist");
    expect(byLabel.unblocks?.sessionId).toBe("s1");
    // The slot it delivers is not "meanwhile" work.
    expect(byLabel.meanwhile).toBeNull();
    expect(byLabel.from?.title).toBe("Grants audit");
    expect(byLabel.lookedAt).toEqual([]);

    const plan = outputs.outcomes.find((o) => o.key === "plan-approved")!;
    const byKey = needsYouContextFromProposal({
      proposal: {
        sessionId: "s1",
        data: { expectedKey: plan.key, expectedLabel: "nope" },
      },
      outputs: { status: "ok", value: outputs },
      session: { status: "ok", value: session },
    });
    expect(byKey.unblocks?.criterionKey).toBe("plan-approved");
    expect(byKey.unblocks?.step).toEqual({ key: "plan", name: "Plan" });
  });

  it("falls back to the proposal's session name when the session was not read", () => {
    const ctx = needsYouContextFromProposal({
      proposal: { sessionId: "s1", sessionGoal: "Grants audit goal" },
    });
    expect(ctx.from).toEqual({
      sessionId: "s1",
      title: "Grants audit goal",
      step: null,
    });
    expect(ctx.unblocks).toBeNull();
  });

  it("a private session is never named: no From, no Unblocks", () => {
    const ctx = needsYouContextFromProposal({
      proposal: {
        sessionId: "s1",
        sessionPrivate: true,
        data: { expectedLabel: "Review checklist" },
      },
      outputs: { status: "ok", value: outputs },
      session: { status: "ok", value: session },
      aiCanDo,
    });
    expect(ctx.from).toBeNull();
    expect(ctx.unblocks).toBeNull();
    expect(ctx.meanwhile).toBeNull();
  });

  it("no session: every line absent, nothing unreadable", () => {
    expect(needsYouContextFromProposal({ proposal: {} })).toEqual({
      unblocks: null,
      meanwhile: null,
      lookedAt: [],
      lookedAtTotal: 0,
      from: null,
      unreadable: [],
    });
  });
});
