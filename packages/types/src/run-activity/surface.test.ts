/**
 * The cross-surface answers (`surface.ts`). Each fixture is an input where the
 * surfaces' former local rules DISAGREED, so a row rules one of them out.
 */

import { describe, expect, it } from "vitest";
import {
  ACTIVITY_POLL_IDLE_MS,
  ACTIVITY_POLL_LIVE_MS,
  activityCount,
  activityGroupTarget,
  activityPollMs,
  activityStepTarget,
  deriveRunActivity,
  nowLineMark,
  NOW_LINE_MODES,
  stepMark,
  type SessionActivityItem,
  type SessionActivityWire,
} from "./index.js";

let seq = 0;
function item(over: Partial<SessionActivityItem>): SessionActivityItem {
  seq += 1;
  return {
    id: `i${seq}`,
    at: new Date(Date.UTC(2026, 9, 4, 12, 0, seq)),
    kind: "write",
    status: "done",
    turnId: null,
    action: "create",
    objectKind: "task",
    objectId: `obj${seq}`,
    objectTitle: null,
    title: null,
    error: null,
    proposalId: null,
    actor: null,
    ...over,
  };
}

function wire(
  items: SessionActivityItem[],
  over: Partial<SessionActivityWire> = {}
): SessionActivityWire {
  return {
    sessionId: "s1",
    items,
    truncated: false,
    terminal: false,
    live: { turnInFlight: false, since: null, lastAt: null },
    unreadable: [],
    ...over,
  };
}

/** Every step, waiting and history, through the REAL derivation. */
function steps(items: SessionActivityItem[]) {
  const v = deriveRunActivity(wire(items));
  return [...v.waiting, ...v.groups.flatMap((g) => g.steps)];
}

describe("activityStepTarget — where a step opens, one rule", () => {
  it("an ask opens its owed slot by the slot's RAW label (rules out the trimmed step label)", () => {
    const [ask] = steps([
      // objectTitle set too: the wire's `title` IS the slot label and wins.
      item({
        kind: "ask",
        status: "pending",
        title: "Confirm the budget…",
        objectTitle: "Budget",
      }),
    ]);
    expect(ask?.label).toBe("Confirm the budget");
    expect(activityStepTarget(ask!)).toEqual({
      kind: "owed",
      slotLabel: "Confirm the budget…",
    });
  });

  it("a note opens the conversation AT its message (rules out 'open the session')", () => {
    const [note] = steps([
      item({ kind: "note", objectId: "m1", title: "Done drafting" }),
    ]);
    expect(activityStepTarget(note!)).toEqual({
      kind: "conversation",
      messageId: "m1",
    });
  });

  it("a decision opens its proposal; a write its object; a tool the conversation", () => {
    const [d, w, t] = steps([
      item({ kind: "decision", status: "approved", proposalId: "p9" }),
      item({ objectId: "e1", objectTitle: "Ship it" }),
      item({ kind: "tool", action: "search", turnId: "t1" }),
    ]);
    expect(activityStepTarget(d!)).toEqual({ kind: "proposal", id: "p9" });
    expect(activityStepTarget(w!)).toEqual({
      kind: "object",
      objectKind: "task",
      id: "e1",
      title: "Ship it",
    });
    expect(activityStepTarget(t!)).toEqual({
      kind: "conversation",
      messageId: null,
    });
  });

  it("names nothing ⇒ null, never a dead door", () => {
    const [w, l] = steps([
      item({ objectId: null }),
      item({ kind: "lifecycle", action: "close" }),
    ]);
    expect(activityStepTarget(w!)).toBeNull();
    expect(activityStepTarget(l!)).toBeNull();
  });

  it("a group of several opens none of them; a group of one opens its step", () => {
    const v = deriveRunActivity(wire([item({}), item({})]));
    expect(v.groups).toHaveLength(1);
    expect(activityGroupTarget(v.groups[0]!)).toBeNull();
    const one = deriveRunActivity(wire([item({ objectId: "e7" })]));
    expect(activityGroupTarget(one.groups[0]!)).toMatchObject({ id: "e7" });
  });
});

describe("activityCount — one number per session", () => {
  it("counts STEPS, not groups (rules out the browser heading's groups.length)", () => {
    const v = deriveRunActivity(wire([item({}), item({}), item({})]));
    expect(v.groups).toHaveLength(1);
    expect(activityCount(v)).toBe(3);
  });
});

describe("activityPollMs — adaptive, stops when ended", () => {
  const now = Date.UTC(2026, 9, 4, 12, 0, 0);
  it("a finished session is not polled", () => {
    expect(activityPollMs(wire([], { terminal: true }), now)).toBe(false);
  });
  it("fast while a turn is in flight", () => {
    expect(
      activityPollMs(
        wire([], { live: { turnInFlight: true, since: null, lastAt: null } }),
        now
      )
    ).toBe(ACTIVITY_POLL_LIVE_MS);
  });
  it("fast right after activity, slow once quiet (rules out a constant cadence)", () => {
    const at = (ms: number) =>
      wire([], {
        live: { turnInFlight: false, since: null, lastAt: new Date(now - ms) },
      });
    expect(activityPollMs(at(60_000), now)).toBe(ACTIVITY_POLL_LIVE_MS);
    expect(activityPollMs(at(10 * 60_000), now)).toBe(ACTIVITY_POLL_IDLE_MS);
  });
  it("before the first answer: slow", () => {
    expect(activityPollMs(undefined, now)).toBe(ACTIVITY_POLL_IDLE_MS);
  });
});

describe("nowLineMark — one mark per mode", () => {
  it("waiting wears the your-turn mark; live the live-step mark; idle a clock, never a tick", () => {
    expect(nowLineMark("waiting")).toEqual(stepMark("waiting_on_you"));
    expect(nowLineMark("now")).toEqual(stepMark("now"));
    expect(nowLineMark("last").glyph).toBe("clock");
    expect(NOW_LINE_MODES.map((m) => nowLineMark(m).tone)).not.toContain(
      "error"
    );
  });
});
