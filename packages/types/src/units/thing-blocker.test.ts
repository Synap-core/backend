/**
 * `deriveThingBlocker` (plan e7f753db §9): a thing is blocked by every wait
 * but a hold (blockers are an overlay; a hold moves the column), the lead
 * wait is the one whose ball comes first, it unlocks the declared `to` or
 * else the next main-path status, and what clears it is the declared door or
 * a person's answer.
 */
import { describe, expect, it } from "vitest";
import type { LifecycleOption } from "../lifecycle/option.js";
import { deriveThingBlocker } from "./thing-blocker.js";
import type { WaitingOnSource } from "./goal.js";

const LEAD: { options: LifecycleOption[] } = {
  options: [
    { key: "new", label: "New", category: "open" },
    { key: "researching", label: "Researching", category: "active" },
    { key: "contacted", label: "Contacted", category: "active" },
    { key: "on_hold", label: "On hold", category: "paused" },
    { key: "won", label: "Won", category: "done" },
    { key: "lost", label: "Lost", category: "lost" },
  ],
};

const slotRef = { kind: "slot" as const, id: "s1", label: "LinkedIn invite" };

describe("deriveThingBlocker", () => {
  it("nothing waits: not blocked", () => {
    expect(deriveThingBlocker([], LEAD, "researching")).toEqual({
      blocked: false,
      count: 0,
      why: null,
      ball: null,
      unlocks: null,
      clearedBy: null,
      ref: null,
    });
  });

  it("a hold never blocks: it is a park that moves the column", () => {
    const b = deriveThingBlocker(
      [{ kind: "hold", on: "person" }],
      LEAD,
      "on_hold"
    );
    expect(b.blocked).toBe(false);
  });

  it("a person's owed slot blocks: their ball, cleared by their answer, unlocks the next status", () => {
    const b = deriveThingBlocker(
      [{ kind: "owed_slot", blockedReason: "decision", ref: slotRef }],
      LEAD,
      "researching"
    );
    expect(b).toMatchObject({
      blocked: true,
      count: 1,
      why: {
        reason: "input",
        waitKind: "decide",
        blockedReason: "decision",
        blockerKey: null,
      },
      ball: "me",
      unlocks: { to: "contacted", label: "Contacted" },
      clearedBy: { answer: true },
      ref: slotRef,
    });
  });

  it("an agent's blocking slot: the agent's ball, its declared door and key, the declared `to`", () => {
    const source: WaitingOnSource = {
      kind: "owed_slot",
      owner: "agent",
      blockerKey: "not_connected",
      blocks: { to: "won" },
      clearedBy: { intent: "request_connection" },
      ref: slotRef,
    };
    const b = deriveThingBlocker([source], LEAD, "researching");
    expect(b).toMatchObject({
      blocked: true,
      why: {
        reason: "another_work",
        waitKind: "agent_work",
        blockerKey: "not_connected",
      },
      ball: "agent",
      unlocks: { to: "won", label: "Won" },
      clearedBy: { intent: "request_connection" },
    });
  });

  it("an agent's slot with no declared door names none (never a guessed answer)", () => {
    const b = deriveThingBlocker(
      [{ kind: "owed_slot", owner: "agent", blocks: {} }],
      LEAD,
      "researching"
    );
    expect(b.clearedBy).toBeNull();
  });

  it("each clearedBy kind passes through as declared", () => {
    for (const clearedBy of [
      { answer: true as const },
      { intent: "request_connection" },
      { playbookId: "11111111-1111-4111-8111-111111111111" },
      { capability: "linkedin.invite" },
    ]) {
      const b = deriveThingBlocker(
        [{ kind: "owed_slot", clearedBy }],
        LEAD,
        "researching"
      );
      expect(b.clearedBy).toEqual(clearedBy);
    }
  });

  it("a `to` the lifecycle does not declare falls back to the next status", () => {
    const b = deriveThingBlocker(
      [{ kind: "owed_slot", blocks: { to: "teleported" } }],
      LEAD,
      "researching"
    );
    expect(b.unlocks).toEqual({ to: "contacted", label: "Contacted" });
  });

  it("the lead wait is the first ball (yours before an agent's), in source order within a ball", () => {
    const b = deriveThingBlocker(
      [
        { kind: "owed_slot", owner: "agent", blocks: {} },
        { kind: "pending_proposal", ref: { kind: "proposal", label: "P1" } },
        { kind: "owed_slot", blockedReason: "credential" },
      ],
      LEAD,
      "researching"
    );
    expect(b.count).toBe(3);
    expect(b.ball).toBe("me");
    expect(b.why?.waitKind).toBe("approval");
    expect(b.ref?.label).toBe("P1");
    // A proposal is cleared by its review: no declared door.
    expect(b.clearedBy).toBeNull();
  });

  it("a proposal carries its blocker key; a held send waits on THEM, not your review", () => {
    const draft = deriveThingBlocker(
      [{ kind: "pending_proposal", blockerKey: "messaging.external.send" }],
      LEAD,
      "researching"
    );
    expect(draft).toMatchObject({
      ball: "me",
      why: {
        reason: "approval",
        waitKind: "approval",
        blockerKey: "messaging.external.send",
      },
    });
    const held = deriveThingBlocker(
      [{ kind: "pending_proposal", blockerKey: "not_connected", held: true }],
      LEAD,
      "researching"
    );
    expect(held).toMatchObject({
      ball: "them",
      why: {
        reason: "external",
        waitKind: "their_reply",
        blockerKey: "not_connected",
      },
      clearedBy: null,
    });
    // Beside a ready draft, the ready one leads: your ball comes first.
    const both = deriveThingBlocker(
      [
        { kind: "pending_proposal", blockerKey: "not_connected", held: true },
        { kind: "pending_proposal", blockerKey: "messaging.external.send" },
      ],
      LEAD,
      "researching"
    );
    expect(both.ball).toBe("me");
    expect(both.count).toBe(2);
  });

  it("no lifecycle, an off-path status or no step left: blocked, nothing to unlock", () => {
    const owed: WaitingOnSource[] = [{ kind: "owed_slot" }];
    expect(deriveThingBlocker(owed, null, "researching").unlocks).toBeNull();
    expect(deriveThingBlocker(owed, LEAD, "lost").unlocks).toBeNull();
    expect(deriveThingBlocker(owed, LEAD, "won").unlocks).toBeNull();
    expect(deriveThingBlocker(owed, LEAD, "won").blocked).toBe(true);
  });

  it("a hold beside a real wait: blocked by the wait, the hold not counted", () => {
    const b = deriveThingBlocker(
      [{ kind: "hold", on: "person" }, { kind: "blocked_by" }],
      LEAD,
      "researching"
    );
    expect(b.count).toBe(1);
    expect(b.ball).toBe("thing");
  });
});
