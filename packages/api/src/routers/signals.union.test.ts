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
  type NotificationSignalInput,
} from "../services/signals/needs-you-union.js";

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

    const signals = unionNeedsYou({ clusters, notifications });
    expect(signals).toHaveLength(1);
    expect(signals[0].kind).toBe("proposal-cluster");

    const counted = countNeedsYou({
      distinctClusters: 1,
      clustersTruncated: false,
      clusters,
      notifications,
      notificationsTruncated: false,
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

    const signals = unionNeedsYou({ clusters, notifications });
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
    const signals = unionNeedsYou({ clusters: [], notifications: [] });
    expect(signals).toEqual([]);
    expect(
      countNeedsYou({
        distinctClusters: 0,
        clustersTruncated: false,
        clusters: [],
        notifications: [],
        notificationsTruncated: false,
      })
    ).toEqual({ needsYou: 0, distinct: 0, truncated: false });
  });

  it("carries truncation through rather than flattening it to an exact total", () => {
    const counted = countNeedsYou({
      distinctClusters: 50,
      clustersTruncated: true,
      clusters: [],
      notifications: [],
      notificationsTruncated: false,
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
});
