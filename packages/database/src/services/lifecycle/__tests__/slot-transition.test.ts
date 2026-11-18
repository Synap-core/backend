/**
 * The slot transition: a slot's status is DERIVED (`slotStatusOf`), so a door
 * owes a `slot` transition only for a slot whose derived status changed between
 * what it locked and what it wrote. Pure.
 */
import { describe, it, expect } from "vitest";
import { slotTransitionsOf } from "../slot-transition.js";

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
