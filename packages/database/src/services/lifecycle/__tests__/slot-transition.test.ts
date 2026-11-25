/**
 * The slot transition: a slot's status is DERIVED (`slotStatusOf`), so a door
 * owes a `slot` transition only for a slot whose derived status changed between
 * what it locked and what it wrote. Pure.
 */
import { describe, it, expect } from "vitest";
import {
  gradesComeDueOf,
  slotTransitionsOf,
  stampOwedSinceOnDue,
} from "../slot-transition.js";

const SESSION = {
  id: "s-1",
  userId: "u-owner",
  workspaceId: "w-1",
  projectId: "p-1",
  trackId: null,
};
const of = (
  before: Array<Record<string, unknown>>,
  after: Array<Record<string, unknown>>
) =>
  slotTransitionsOf({
    session: SESSION,
    before,
    after,
    actor: { kind: "agent", userId: "u-owner", agentUserId: "a-1" },
    reason: "why",
  });

describe("slotTransitionsOf", () => {
  it("a hand-over to the person owes pending → owed, named <session>/<key>", () => {
    const [t, ...rest] = of(
      [{ key: "brief", label: "Brief", owner: "agent" }],
      [{ key: "brief", label: "Brief", owner: "human" }]
    );
    expect(rest).toEqual([]);
    expect(t).toMatchObject({
      subjectType: "slot",
      subjectId: "s-1/brief",
      slotKey: "brief",
      sessionId: "s-1",
      from: "pending",
      to: "owed",
      fromCategory: "open",
      category: "open",
      actorKind: "agent",
      agentUserId: "a-1",
      userId: "u-owner",
      workspaceId: "w-1",
      projectId: "p-1",
      reason: "why",
    });
  });

  it("a move a rule caused carries its cause", () => {
    const cause = {
      reactionId: "rule-1",
      transitionId: "t-src",
      chainId: "t-src",
      depth: 1,
    };
    const [t] = slotTransitionsOf({
      session: SESSION,
      before: [{ key: "k" }],
      after: [{ key: "k", status: "done" }],
      actor: { kind: "system" },
      cause,
    });
    expect(t).toMatchObject({ to: "done", cause });
    expect(
      of([{ key: "k" }], [{ key: "k", status: "done" }])[0]
    ).not.toHaveProperty("cause");
  });

  it("an answer handed back owes owed → answered (done); a delivery done", () => {
    expect(
      of(
        [{ key: "k", owner: "human" }],
        [{ key: "k", answer: { text: "yes", answeredAt: "x" } }]
      ).map((t) => [t.from, t.to, t.category])
    ).toEqual([["owed", "answered", "done"]]);
    expect(
      of([{ key: "k" }], [{ key: "k", status: "done" }]).map((t) => t.to)
    ).toEqual(["done"]);
  });

  it("a retirement owes → retired (lost)", () => {
    expect(
      of(
        [{ key: "k", owner: "human" }],
        [{ key: "k", owner: "human", retiredAt: "2026-11-17" }]
      ).map((t) => [t.to, t.category])
    ).toEqual([["retired", "lost"]]);
  });

  it("a birth, a removal and a change that moves no status owe nothing", () => {
    expect(of([], [{ key: "new" }])).toEqual([]);
    expect(of([{ key: "gone" }], [])).toEqual([]);
    expect(
      of(
        [{ key: "k", label: "A", why: "x" }],
        [{ key: "k", label: "B", why: "y" }]
      )
    ).toEqual([]);
  });

  it("matches by label when a slot has no key", () => {
    expect(
      of([{ label: "Brief" }], [{ label: "Brief", owner: "human" }]).map(
        (t) => t.subjectId
      )
    ).toEqual(["s-1/Brief"]);
  });
});

describe("a declared grade comes due when its output is made (finding f3c864cc)", () => {
  const DECLARED = "2026-01-01T00:00:00.000Z";
  const NOW = "2026-11-24T00:29:12.000Z";
  const output = { key: "checklist", label: "Checklist", owner: "agent" };
  const grade = {
    key: "check-checklist",
    label: "Check: The checklist reads right",
    kind: "criterion",
    outputKey: "checklist",
    owner: "human",
    owedSince: DECLARED,
  };
  const before = [output, grade];
  const made = [{ ...output, status: "done" }, grade];

  it("names the grade whose output this write made", () => {
    expect(gradesComeDueOf(before, made)).toEqual(["check-checklist"]);
    // A claim makes the output too.
    expect(
      gradesComeDueOf(before, [{ ...output, claimedDone: true }, grade])
    ).toEqual(["check-checklist"]);
  });

  it("names nothing when the output was already made, or is still not", () => {
    expect(gradesComeDueOf(made, made)).toEqual([]);
    expect(
      gradesComeDueOf(before, [{ ...output, why: "drafting" }, grade])
    ).toEqual([]);
  });

  it("stamps owedSince forward on a due grade, never back", () => {
    const stamped = stampOwedSinceOnDue(made, ["check-checklist"], NOW);
    expect(stamped?.[1]).toMatchObject({ owedSince: NOW });
    // A later stamp stays.
    expect(
      stampOwedSinceOnDue(made, ["check-checklist"], "2025-01-01T00:00:00.000Z")
    ).toBeNull();
  });

  it("leaves a list the write has not reached alone (the grade still waits there)", () => {
    expect(stampOwedSinceOnDue(before, ["check-checklist"], NOW)).toBeNull();
  });
});
