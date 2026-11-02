/**
 * The registry `needsYou` roles in the PURE union, with no database. The
 * DB-backed proof through the real procedures is
 * `routers/signals.needs-you-session-pointer.pglite.test.ts`. This file pins
 * the rules that test cannot reach: an UNMEASURED question read never hides a
 * pointer row, and an unknown type stays an ordinary item.
 *
 * `session.room_update` was retired (founder decision F, 2026-09-25): its
 * producer and its registry row (`needsYou: "informational"`) were both
 * removed, so an agent's room `update` post now creates no notification at
 * all. The type string is kept here only as a concrete example of a RETIRED
 * type falling back to the ordinary "item" role — proving it is no longer
 * specially suppressed, not that it is still produced.
 */
import { describe, it, expect } from "vitest";
import {
  countNeedsYou,
  unionNeedsYou,
  unionSuggestions,
  type NotificationSignalInput,
} from "../needs-you-union.js";
import {
  NOTIFICATION_REGISTRY,
  needsYouRole,
} from "../../../notifications/registry.js";

const S = "sess-1";
const row = (type: string, sourceId = S): NotificationSignalInput => ({
  id: `n-${type}`,
  type,
  title: type,
  category: "ai",
  sourceType: "session",
  sourceId,
  createdAt: new Date("2026-09-25T10:00:00Z"),
});
const count = (
  notifications: NotificationSignalInput[],
  openQuestionSessionIds?: ReadonlySet<string>
) =>
  countNeedsYou({
    distinctClusters: 0,
    clustersTruncated: false,
    clusters: [],
    notifications,
    notificationsTruncated: false,
    owedSlots: [],
    owedTruncated: false,
    openQuestionSessionIds,
  }).needsYou;

describe("registry needsYou roles in the union", () => {
  it("session.needs_you is the session-pointer role (read from the row, not restated)", () => {
    expect(needsYouRole("session.needs_you")).toBe("session-pointer");
    // Non-vacuity: the registry is the scanned set, and it is not empty.
    expect(NOTIFICATION_REGISTRY.length).toBeGreaterThan(20);
  });

  it("every ai.proactive.* type is a suggestion (the set is DERIVED from the registry)", () => {
    const proactive = NOTIFICATION_REGISTRY.filter((d) =>
      d.type.startsWith("ai.proactive.")
    );
    expect(proactive.length).toBeGreaterThanOrEqual(7);
    for (const d of proactive)
      expect([d.type, d.needsYou]).toEqual([d.type, "suggestion"]);
    expect(needsYouRole("agent.insight")).toBe("suggestion");
  });

  it("a suggestion never counts toward needs-you, and ships as its own number", () => {
    const r = countNeedsYou({
      distinctClusters: 0,
      clustersTruncated: false,
      clusters: [],
      notifications: [row("ai.proactive.nudge"), row("inbox.email")],
      notificationsTruncated: false,
      owedSlots: [],
      owedTruncated: false,
      openQuestionSessionIds: new Set(),
    });
    expect(r.needsYou).toBe(1);
    expect(r.notifications).toBe(1);
    expect(r.suggestions).toBe(1);
    expect(
      unionSuggestions([row("ai.proactive.nudge"), row("inbox.email")]).map(
        (s) => s.title
      )
    ).toEqual(["ai.proactive.nudge"]);
  });

  it("a criterion's escalation alert counts only while its session waits on the person", () => {
    // Founder, 31 Oct 2026: a session closed with its criterion graded Pass
    // still showed "Needs your call: …" in needs-you, with nothing to act on.
    expect(needsYouRole("session.criterion_escalated")).toBe("session-pointer");
    // Graded and nothing else open: the alert is history, not a need.
    expect(count([row("session.criterion_escalated")], new Set())).toBe(0);
    // The criterion's slot is still owed: the alert folds into that one row.
    const r = countNeedsYou({
      distinctClusters: 0,
      clustersTruncated: false,
      clusters: [],
      notifications: [row("session.criterion_escalated")],
      notificationsTruncated: false,
      owedSlots: [],
      owedTruncated: false,
      openQuestionSessionIds: new Set(),
      measuredOwedSessionIds: new Set([S]),
    });
    expect(r.notifications).toBe(0);
  });

  it("a session's pointer alerts count once and list as its own row", () => {
    // Open question, no owed slot: both pointers stand for that one need.
    // Folded per type, the session counted twice and kept a "Needs your
    // call" row about a criterion already graded beside its own row.
    const needsYou = row("session.needs_you");
    const escalated = {
      ...row("session.criterion_escalated"),
      createdAt: new Date("2026-09-25T11:00:00Z"),
    };
    const open = new Set([S]);
    expect(count([needsYou, escalated], open)).toBe(1);
    const listed = unionNeedsYou({
      clusters: [],
      notifications: [escalated, needsYou],
      owedSlots: [],
      openQuestionSessionIds: open,
    });
    expect(listed.map((s) => s.notificationType)).toEqual([
      "session.needs_you",
    ]);
    // Another session's pointer stays its own row.
    const other = { ...row("session.needs_you", "b"), id: "n-b" };
    expect(count([needsYou, escalated, other], new Set([S, "b"]))).toBe(2);
  });

  it("an UNMEASURED question read keeps a pointer row counting, never hides it", () => {
    expect(count([row("session.needs_you")])).toBe(1);
    expect(count([row("session.needs_you")], new Set())).toBe(0);
  });

  it("an unknown or missing type is an ordinary item", () => {
    expect(needsYouRole("retired.type")).toBe("item");
    expect(needsYouRole(undefined)).toBe("item");
    expect(count([row("retired.type")], new Set())).toBe(1);
  });

  it("a DELIBERATELY retired type (session.room_update) is informational — it never counts or lists", () => {
    // W2 calm: legacy unread rows of a retired producer inflated the badge
    // forever. Named in RETIRED_NOTIFICATION_TYPES, never inferred.
    expect(needsYouRole("session.room_update")).toBe("informational");
    expect(count([row("session.room_update")], new Set())).toBe(0);
  });

  it("list and count agree on the same population", () => {
    const notifications = [
      row("session.needs_you", "a"),
      row("session.needs_you", "b"),
    ];
    const open = new Set(["a"]);
    const listed = unionNeedsYou({
      clusters: [],
      notifications,
      owedSlots: [],
      openQuestionSessionIds: open,
    });
    expect(listed.map((s) => s.target?.id)).toEqual(["a"]);
    expect(count(notifications, open)).toBe(listed.length);
  });
});

/**
 * Noise measured in the founder's headline on 31 Oct (92 rows): 7
 * `session.unblocked` notices no one asked (category `system`). The REAL
 * registry row is driven through the union AND the count, so the role
 * reverted in the registry (or the bucket dropped in `partitionNotifications`)
 * turns it red. The other noise of that day, `session.criterion_escalated`
 * repeating an owed slot, is backend#605's (registry role `session-pointer`).
 */
describe("needs-you headline noise: a system notice is From the system", () => {
  it("a system 'is unblocked' notification lands in from_system, never the headline", () => {
    expect(needsYouRole("session.unblocked")).toBe("from_system");
    const unblocked = { ...row("session.unblocked"), category: "system" };
    const rows = unionNeedsYou({
      clusters: [],
      notifications: [unblocked],
      owedSlots: [],
    });
    const c = countNeedsYou({
      distinctClusters: 0,
      clustersTruncated: false,
      clusters: [],
      notifications: [unblocked],
      notificationsTruncated: false,
      owedSlots: [],
      owedTruncated: false,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "notification",
      needsYouClass: "from_system",
      reviewLater: true,
    });
    expect(c.needsYou).toBe(0);
    expect(c.notifications).toBe(0);
    // Countable, never lost: the fold counts the row the list draws.
    expect(c.folds.fromSystem).toBe(1);
    expect(c.reviewLater).toBe(1);
  });
});
