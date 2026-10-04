/**
 * The needs-you duplicate causes that live in the PURE union (lens grammar,
 * 2026-10-04), each with a fixture row that DISCRIMINATES the fixed rule from
 * the old one, plus the status banner and the container predicate.
 * The DB-backed halves are in `routers/signals.lens-page.pglite.test.ts`.
 */
import { describe, it, expect } from "vitest";
import {
  countNeedsYou,
  foldNotifications,
  signalFromNotification,
  statusBanner,
  unionNeedsYou,
  type NotificationSignalInput,
} from "../needs-you-union.js";
import { inContainerLens, notificationRef } from "../lens-containers.js";

const at = (m: number) => new Date(Date.UTC(2026, 9, 4, 10, m));
const n = (
  id: string,
  over: Partial<NotificationSignalInput> = {}
): NotificationSignalInput => ({
  id,
  type: "connector.sync.failed",
  title: "Gmail sync failed",
  category: "data",
  sourceType: "connector",
  sourceId: null,
  createdAt: at(0),
  ...over,
});

describe("cause 2 — target-less notifications fold on (type, source, title)", () => {
  it("the same target-less news raised three times is ONE row ×3", () => {
    const folded = foldNotifications([
      n("a"),
      n("b", { createdAt: at(5) }),
      n("c"),
    ]);
    expect(folded).toHaveLength(1);
    expect(folded[0]!.repeatCount).toBe(3);
    expect(folded[0]!.row.id).toBe("b"); // the newest instance leads
  });

  it("different titles are different news and stay apart", () => {
    expect(
      foldNotifications([n("a"), n("b", { title: "Outlook sync failed" })])
    ).toHaveLength(2);
  });

  it("the badge counts the fold, like the list", () => {
    const rows = [n("a"), n("b"), n("c")];
    const listed = unionNeedsYou({
      clusters: [],
      notifications: rows,
      owedSlots: [],
    });
    const counted = countNeedsYou({
      distinctClusters: 0,
      clustersTruncated: false,
      clusters: [],
      notifications: rows,
      notificationsTruncated: false,
      owedSlots: [],
      owedTruncated: false,
    });
    expect(listed).toHaveLength(1);
    expect(counted.notifications).toBe(1);
  });
});

describe("cause 3 — a pointer folds on the MEASURED owed state, not the capped page", () => {
  const pointer = n("p", {
    type: "session.needs_you",
    title: "Session needs you",
    category: "ai",
    sourceType: "session",
    sourceId: "s-old",
  });
  it("folds when the session was measured owed though its slot is past the page", () => {
    // The owed page is empty (its slots fell past the cap); without the
    // measurement the pointer would stand alone beside the slot it announces.
    const base = {
      clusters: [],
      notifications: [pointer],
      owedSlots: [],
      openQuestionSessionIds: new Set<string>(["s-old"]),
    };
    expect(unionNeedsYou(base)).toHaveLength(1);
    expect(
      unionNeedsYou({ ...base, measuredOwedSessionIds: new Set(["s-old"]) })
    ).toEqual([]);
  });
});

describe("cause 1 — a resolved container puts the notification in its session's block", () => {
  it("named session ⇒ session group key + source door; none ⇒ a row of its own", () => {
    const row = n("m", {
      type: "chat.mention",
      sourceType: "session",
      sourceId: "s1",
    });
    const withContainer = signalFromNotification(row, at(9), 1, {
      sessionId: "s1",
      sessionTitle: "Ship billing",
      projectId: "p1",
      trackId: null,
    });
    expect(withContainer).toMatchObject({
      groupKey: "session:s1",
      sessionTitle: "Ship billing",
      sessionProjectId: "p1",
      source: { kind: "session", id: "s1", label: "Ship billing" },
    });
    expect(signalFromNotification(row, at(9)).groupKey).toBeNull();
  });

  it("refs: a session target, a type that opens its own session, a room message", () => {
    expect(
      notificationRef(n("a", { sourceType: "session", sourceId: "s" }))
    ).toEqual({
      kind: "session",
      sessionId: "s",
    });
    expect(
      notificationRef(
        n("b", {
          type: "session.unblocked",
          sourceType: "system",
          sourceId: "s",
        })
      )
    ).toEqual({ kind: "session", sessionId: "s" });
    expect(
      notificationRef(
        n("c", { sourceType: "proactive_message", sourceId: "m" })
      )
    ).toEqual({ kind: "message", messageId: "m" });
    // A plain system row whose type opens no session names nothing.
    expect(
      notificationRef(n("d", { sourceType: "system", sourceId: "x" }))
    ).toBeNull();
  });

  it("the container predicate nests: session ⊂ track ⊂ project", () => {
    const c = {
      sessionId: "s",
      sessionTitle: null,
      projectId: "p",
      trackId: "t",
    };
    expect(inContainerLens(c, {})).toBe(true);
    expect(inContainerLens(c, { projectId: "p" })).toBe(true);
    expect(inContainerLens(c, { trackId: "t" })).toBe(true);
    expect(inContainerLens(c, { sessionId: "s" })).toBe(true);
    expect(inContainerLens(c, { projectId: "other" })).toBe(false);
    expect(inContainerLens(undefined, { projectId: "p" })).toBe(false);
    expect(inContainerLens(undefined, {})).toBe(true);
  });
});

describe("system health — ONE banner, never needs-you", () => {
  const degraded = (id: string, m: number, sourceId: string | null = null) =>
    n(id, {
      type: "system.intelligence_degraded",
      title: `Hub degraded (${m})`,
      category: "system",
      sourceType: "system",
      sourceId,
      createdAt: at(m),
    });

  it("folds per (type, source), leads with the newest issue", () => {
    const b = statusBanner([
      degraded("a", 1),
      degraded("b", 4),
      degraded("c", 2),
    ]);
    expect(b).toMatchObject({
      title: "Hub degraded (4)",
      issues: [{ repeatCount: 3, notificationIds: ["a", "b", "c"] }],
    });
    // Two DIFFERENT services degraded are two issues in one banner.
    expect(
      statusBanner([degraded("a", 1, "is-1"), degraded("b", 2, "is-2")])!.issues
    ).toHaveLength(2);
    expect(statusBanner([n("x")])).toBeNull();
  });

  it("a health row is neither a needs-you row nor counted", () => {
    const rows = [degraded("a", 1), degraded("b", 2)];
    expect(
      unionNeedsYou({ clusters: [], notifications: rows, owedSlots: [] })
    ).toEqual([]);
    expect(
      countNeedsYou({
        distinctClusters: 0,
        clustersTruncated: false,
        clusters: [],
        notifications: rows,
        notificationsTruncated: false,
        owedSlots: [],
        owedTruncated: false,
      }).needsYou
    ).toBe(0);
  });
});
