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
 * The two noises measured in the founder's headline on 31 Oct (92 rows):
 * 7 `session.unblocked` notices no one asked (category `system`) and 15
 * `session.criterion_escalated` "Needs your call" rows repeating a session
 * whose owed slot was already in the headline. Each case drives the REAL
 * registry row through the union AND the count, so a role reverted in the
 * registry (or a bucket dropped in `partitionNotifications`) turns it red.
 */
describe("needs-you headline noise: system notices and repeats of an owed slot", () => {
  const owedSlot = (sessionId: string) => ({
    sessionId,
    label: `Check: ${sessionId} criterion`,
    owedSince: new Date("2026-09-25T09:00:00.000Z").toISOString(),
    blockedReason: "decision" as const,
    needsYouClass: "needs_you" as const,
  });
  const read = (
    notifications: NotificationSignalInput[],
    owedSlots: ReturnType<typeof owedSlot>[] = []
  ) => ({
    rows: unionNeedsYou({ clusters: [], notifications, owedSlots }),
    count: countNeedsYou({
      distinctClusters: 0,
      clustersTruncated: false,
      clusters: [],
      notifications,
      notificationsTruncated: false,
      owedSlots,
      owedTruncated: false,
    }),
  });

  it("a system 'is unblocked' notification lands in from_system, never the headline", () => {
    expect(needsYouRole("session.unblocked")).toBe("from_system");
    const unblocked = { ...row("session.unblocked"), category: "system" };
    const { rows, count: c } = read([unblocked]);

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

  it("a 'Needs your call' notification whose session has an owed-slot row folds into it, still counted once", () => {
    expect(needsYouRole("session.criterion_escalated")).toBe("session-ask");
    const escalated = row("session.criterion_escalated", S);
    const { rows, count: c } = read([escalated], [owedSlot(S)]);

    // One row for the session: its owed slot. The notification is not a
    // second headline row.
    expect(rows.map((r) => [r.kind, r.target?.id])).toEqual([["owed-slot", S]]);
    expect(c.notifications).toBe(0);
    // The session's need is still in the headline, counted once.
    expect(c.blocked).toBe(1);
    expect(c.needsYou).toBe(1);
  });

  it("a 'Needs your call' notification with no owed slot on its session stays in the headline", () => {
    const escalated = row("session.criterion_escalated", "sess-bare");
    // Another session's slot does not fold it.
    const { rows, count: c } = read([escalated], [owedSlot(S)]);

    expect(
      rows.map((r) => [r.kind, r.target?.id, r.needsYouClass ?? null]).sort()
    ).toEqual(
      [
        ["notification", "sess-bare", null],
        ["owed-slot", S, "needs_you"],
      ].sort()
    );
    expect(c.notifications).toBe(1);
    expect(c.needsYou).toBe(2);
  });
});
