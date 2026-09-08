/**
 * Unit tests for the `signals.list` / `signals.count` union + dedupe.
 *
 * NO DATABASE, NO MOCKS. The union is a pure function over rows the router
 * fetches from doors that already exist, precisely so its membership rules can
 * be pinned without a live DB (the DB-backed router tests in this package
 * ECONNREFUSED without one, which is exactly what these rules must not depend
 * on).
 */

import { describe, it, expect } from "vitest";
import type { ProposalCluster } from "../services/proposals/fingerprint.js";
import { proposalClassFields } from "../services/proposals/proposal-class.js";
import {
  unionNeedsYou,
  countNeedsYou,
  dedupeNotifications,
  targetFromNotification,
  signalFromCluster,
  signalFromOwedSlot,
  type NotificationSignalInput,
  type OwedSlotSignalInput,
} from "../services/signals/needs-you-union.js";
import { normalizeExpectedLabel } from "../services/focus-sessions/expected-label.js";

function cluster(over: Partial<ProposalCluster> = {}): ProposalCluster {
  const proposalType = over.proposalType ?? "create";
  const targetType = over.targetType ?? "entity";
  return {
    fingerprint: "fp-1",
    proposalType,
    targetType,
    targetLabel: "Acme Corp",
    // Derived through the ONE door, never hand-written: a fixture that pins
    // its own class values would keep passing after the real classifier moved.
    ...proposalClassFields(proposalType, targetType),
    count: 3,
    sampleProposalIds: ["prop-1", "prop-2", "prop-3"],
    sources: [],
    latestAt: new Date("2026-09-04T10:00:00Z"),
    workspaceIds: ["ws-1"],
    reasonCounts: {},
    attentionFloorCount: 0,
    ...over,
  };
}

function notif(
  over: Partial<NotificationSignalInput> = {}
): NotificationSignalInput {
  return {
    id: "n-1",
    title: "Sync finished",
    category: "system",
    sourceType: "system",
    sourceId: null,
    createdAt: new Date("2026-09-04T09:00:00Z"),
    ...over,
  };
}

describe("needs-you union", () => {
  it("counts a proposal ONCE when it also has its own notification", () => {
    // The exact double-count the door exists to kill: one pending proposal
    // produces a cluster AND a `proposal.created` notification addressed to
    // the reviewer.
    const clusters = [cluster()];
    const notifications = [
      notif({ id: "n-p", sourceType: "proposal", sourceId: "prop-1" }),
    ];

    const signals = unionNeedsYou({ clusters, notifications, owedSlots: [] });
    expect(signals).toHaveLength(1);
    expect(signals[0].kind).toBe("proposal-cluster");

    const counted = countNeedsYou({
      distinctClusters: 1,
      clustersTruncated: false,
      clusters,
      notifications,
      notificationsTruncated: false,
      owedSlots: [],
      owedTruncated: false,
    });
    expect(counted.needsYou).toBe(1);
  });

  it("drops a proposal-backed notification stamped with another sourceType", () => {
    // Rule 2: sourceId matches a proposal a cluster already represents.
    const clusters = [cluster()];
    const kept = dedupeNotifications(
      [notif({ id: "n-x", sourceType: "system", sourceId: "prop-2" })],
      clusters
    );
    expect(kept).toHaveLength(0);
  });

  it("keeps a non-proposal unread notification", () => {
    const clusters = [cluster()];
    const notifications = [
      notif({ id: "n-c", sourceType: "connector", sourceId: "conn-9" }),
    ];

    const signals = unionNeedsYou({ clusters, notifications, owedSlots: [] });
    expect(signals.map((s) => s.kind)).toEqual([
      "proposal-cluster",
      "notification",
    ]);

    const counted = countNeedsYou({
      distinctClusters: 1,
      clustersTruncated: false,
      clusters,
      notifications,
      notificationsTruncated: false,
      owedSlots: [],
      owedTruncated: false,
    });
    expect(counted.needsYou).toBe(2);
    expect(counted.distinct).toBe(2);
  });

  it("orders the union newest-first across both sources", () => {
    const older = cluster({
      fingerprint: "fp-old",
      latestAt: new Date("2026-09-01T00:00:00Z"),
    });
    const newer = notif({
      id: "n-new",
      createdAt: new Date("2026-09-04T23:00:00Z"),
    });
    const signals = unionNeedsYou({
      clusters: [older],
      notifications: [newer],
      owedSlots: [],
    });
    expect(signals.map((s) => s.id)).toEqual([
      "notification:n-new",
      "cluster:fp-old",
    ]);
  });

  it("a decided proposal is absent from needs-you", () => {
    // `proposals.groups` only ever returns PENDING/APPROVAL_FAILED rows, so a
    // decided proposal reaches the union as neither a cluster nor (once its
    // notification is actioned) an unread notification. Both inputs empty ⇒
    // no signal, and the badge reads zero.
    const signals = unionNeedsYou({
      clusters: [],
      notifications: [],
      owedSlots: [],
    });
    expect(signals).toEqual([]);
    expect(
      countNeedsYou({
        distinctClusters: 0,
        clustersTruncated: false,
        clusters: [],
        notifications: [],
        notificationsTruncated: false,
        owedSlots: [],
        owedTruncated: false,
      })
    ).toEqual({ needsYou: 0, distinct: 0, truncated: false, blocked: 0 });
  });

  it("carries truncation through rather than flattening it to an exact total", () => {
    const counted = countNeedsYou({
      distinctClusters: 50,
      clustersTruncated: true,
      clusters: [],
      notifications: [],
      notificationsTruncated: false,
      owedSlots: [],
      owedTruncated: false,
    });
    expect(counted.truncated).toBe(true);
  });
});

function owed(over: Partial<OwedSlotSignalInput> = {}): OwedSlotSignalInput {
  return {
    sessionId: "sess-1",
    label: "Stripe restricted key",
    owedSince: "2026-09-02T08:00:00Z",
    ...over,
  };
}

describe("owed slots in the needs-you union", () => {
  it("sorts owed slots ABOVE every cluster and notification, however fresh", () => {
    // The tray is newest-first everywhere else. An owed slot never expires, so
    // it must not be ranked by recency against rows that do — a three-week-old
    // obligation belongs above a proposal filed a minute ago.
    const signals = unionNeedsYou({
      clusters: [cluster({ latestAt: new Date("2026-09-08T23:59:00Z") })],
      notifications: [notif({ createdAt: new Date("2026-09-08T23:58:00Z") })],
      owedSlots: [owed({ owedSince: "2026-08-15T00:00:00Z" })],
    });
    expect(signals.map((s) => s.kind)).toEqual([
      "owed-slot",
      "proposal-cluster",
      "notification",
    ]);
  });

  it("orders owed slots OLDEST first — the opposite of the rest of the tray", () => {
    const signals = unionNeedsYou({
      clusters: [],
      notifications: [],
      owedSlots: [
        owed({ sessionId: "s-new", owedSince: "2026-09-07T00:00:00Z" }),
        owed({ sessionId: "s-old", owedSince: "2026-07-04T00:00:00Z" }),
        owed({ sessionId: "s-mid", owedSince: "2026-08-01T00:00:00Z" }),
      ],
    });
    expect(signals.map((s) => s.target?.id)).toEqual([
      "s-old",
      "s-mid",
      "s-new",
    ]);
  });

  it("keeps a session's slots as SEPARATE rows, never a cluster", () => {
    // Three deliverables on one session are three things to do, each with its
    // own verb. Collapsing them to `count: 3` hides two behind a number.
    const signals = unionNeedsYou({
      clusters: [],
      notifications: [],
      owedSlots: [
        owed({ label: "Stripe key" }),
        owed({ label: "DNS record" }),
        owed({ label: "Signed MSA" }),
      ],
    });
    expect(signals).toHaveLength(3);
    expect(signals.every((s) => s.count === 1)).toBe(true);
    expect(new Set(signals.map((s) => s.id)).size).toBe(3);
  });

  it("does NOT drop a session.unblocked notification for a session that also owes", () => {
    // That notification is written `sourceType: "system"` with `sourceId` = the
    // SESSION id (session-unblock-reactor.ts). Keying owed slots into the
    // proposal dedupe set by sourceId would silently swallow it — two different
    // pieces of news about one session, both the user's to see.
    const signals = unionNeedsYou({
      clusters: [],
      notifications: [
        notif({
          id: "n-unblock",
          sourceType: "system",
          sourceId: "sess-1",
          title: "Migration plan is unblocked",
        }),
      ],
      owedSlots: [owed({ sessionId: "sess-1" })],
    });
    expect(signals.map((s) => s.kind)).toEqual(["owed-slot", "notification"]);
  });

  it("addresses the session and ids through the ONE casefold", () => {
    const signal = signalFromOwedSlot(
      owed({ sessionId: "sess-9", label: "  Stripe Restricted Key  " })
    );
    expect(signal.target).toEqual({ kind: "session", id: "sess-9" });
    // The id keys on the same normalization `attestOutput` matches with, so a
    // surface can round-trip it back into the slot doors.
    expect(signal.id).toBe(
      `slot:sess-9:${normalizeExpectedLabel("  Stripe Restricted Key  ")}`
    );
    // The TITLE is the declared label verbatim — not casefolded, not
    // capitalized at the call site.
    expect(signal.title).toBe("  Stripe Restricted Key  ");
  });

  it("carries NO class and NO lifetime — an obligation is not a decision", () => {
    const signal = signalFromOwedSlot(owed());
    expect(signal.class).toBeUndefined();
    expect(signal.lifetimeHours).toBeUndefined();
  });

  it("sorts an unstamped slot as the OLDEST, never as now", () => {
    // `projectOwedSlots` writes "0000-00-00" for a slot that predates the
    // `owedSince` invariant. `new Date(...)` of that is an Invalid Date whose
    // getTime() is NaN, and NaN loses every sort comparison silently — the
    // anomaly would sink instead of surfacing.
    const signals = unionNeedsYou({
      clusters: [],
      notifications: [],
      owedSlots: [
        owed({ sessionId: "s-stamped", owedSince: "2020-01-01T00:00:00Z" }),
        owed({ sessionId: "s-unstamped", owedSince: "0000-00-00" }),
      ],
    });
    expect(signals[0].target?.id).toBe("s-unstamped");
    expect(Number.isNaN(signals[0].occurredAt.getTime())).toBe(false);
  });

  it("counts owed slots into the total AND breaks them out as `blocked`", () => {
    // The badge shows `blocked` only (founder-settled); the header shows the
    // total. Both come from ONE query and one counting rule.
    const counted = countNeedsYou({
      distinctClusters: 4,
      clustersTruncated: false,
      clusters: [],
      notifications: [notif({ sourceType: "connector", sourceId: "c-1" })],
      notificationsTruncated: false,
      owedSlots: [owed({ sessionId: "a" }), owed({ sessionId: "b" })],
      owedTruncated: false,
    });
    expect(counted.needsYou).toBe(7);
    expect(counted.blocked).toBe(2);
  });

  it("the count equals the list length — the badge cannot disagree with its rows", () => {
    const clusters = [cluster()];
    const notifications = [notif({ sourceType: "connector", sourceId: "c-1" })];
    const owedSlots = [owed({ sessionId: "a" }), owed({ sessionId: "b" })];
    const listed = unionNeedsYou({ clusters, notifications, owedSlots });
    const counted = countNeedsYou({
      distinctClusters: clusters.length,
      clustersTruncated: false,
      clusters,
      notifications,
      notificationsTruncated: false,
      owedSlots,
      owedTruncated: false,
    });
    expect(counted.needsYou).toBe(listed.length);
  });

  it("a truncated owed page makes the number a FLOOR", () => {
    const counted = countNeedsYou({
      distinctClusters: 0,
      clustersTruncated: false,
      clusters: [],
      notifications: [],
      notificationsTruncated: false,
      owedSlots: [owed()],
      owedTruncated: true,
    });
    expect(counted.truncated).toBe(true);
  });
});

describe("signal targets", () => {
  it("maps a known sourceType to an object-nav address", () => {
    expect(targetFromNotification("entity", "e-1")).toEqual({
      kind: "entity",
      id: "e-1",
    });
    expect(targetFromNotification("automation", "a-1")).toEqual({
      kind: "automation",
      id: "a-1",
    });
  });

  it("returns null rather than guessing a route for an unmapped sourceType", () => {
    expect(targetFromNotification("connector", "conn-1")).toBeNull();
    expect(targetFromNotification("entity", null)).toBeNull();
  });

  it("addresses a cluster by its sample proposal", () => {
    expect(signalFromCluster(cluster()).target).toEqual({
      kind: "proposal",
      id: "prop-1",
    });
  });

  it("titles a cluster through the vocabulary door, never a raw token", () => {
    const title = signalFromCluster(cluster()).title;
    expect(title).not.toContain("create");
    expect(title).toContain("Acme Corp");
  });

  it("carries the cluster's class AND lifetime onto the signal", () => {
    // An ephemeral cluster (a capability run) must reach the tray with the
    // countdown it needs; re-deriving the lifetime downstream is how a second
    // copy of CLASS_LIFETIME_HOURS gets written.
    const ephemeral = signalFromCluster(
      cluster({ proposalType: "capability.run", targetType: "capability" })
    );
    expect(ephemeral.class).toBe("ephemeral");
    expect(ephemeral.lifetimeHours).toBe(
      proposalClassFields("capability.run", "capability").lifetimeHours
    );

    // A never-expiring class carries an explicit null, not an absent field.
    const objectWork = signalFromCluster(cluster());
    expect(objectWork.class).toBe("objectWork");
    expect(objectWork.lifetimeHours).toBeNull();
  });

  it("leaves class/lifetime absent on a non-cluster signal", () => {
    const [signal] = unionNeedsYou({
      clusters: [],
      notifications: [notif()],
      owedSlots: [],
    });
    expect(signal.kind).toBe("notification");
    expect(signal.class).toBeUndefined();
    expect(signal.lifetimeHours).toBeUndefined();
  });
});
