/**
 * Signal union + dedupe — the PURE core behind `signals.list` / `signals.count`.
 *
 * ONE signal door, two lenses. `needs-you` is the union of two ALREADY-EXISTING
 * reads: the pending proposal CLUSTERS (`proposals.groups`) and the UNREAD
 * notifications (`notifCenter.list`). Neither is re-implemented here — the
 * router calls both doors through their own routers and hands the rows to this
 * file, which is DB-free by construction and unit-testable without a database.
 *
 * THE DEDUPE RULE, and why it exists. Approving a proposal produces BOTH a
 * pending `proposals` row AND a `proposal.created` notification addressed to
 * the reviewer. Counting both is how one decision becomes two badges that never
 * agree. So a proposal is represented by its CLUSTER and only by its cluster:
 *
 *   1. every notification with `sourceType === "proposal"` is dropped, and
 *   2. every notification whose `sourceId` matches a proposal id already
 *      sampled by a cluster is dropped (belt-and-braces: it catches a
 *      proposal-backed notification stamped with some other sourceType).
 *
 * Rule 2 is a subset-check, not a guarantee: `sampleProposalIds` is capped
 * (`DEFAULT_SAMPLE_CAP` = 20 in fingerprint.ts), so a cluster larger than the
 * cap cannot expose every member id. Rule 1 is the load-bearing one and does
 * not depend on the sample at all.
 *
 * TITLES ARE NEVER GENERATED HERE. A notification's title is the column the
 * registry template already evaluated. A cluster's title goes through
 * `buildObjectActionTitle` — the vocabulary SSOT (`@synap-core/types/vocabulary`),
 * the same door every other proposal surface uses — so a signal card and a
 * proposal card can never render the same change with two different verbs.
 */

import { buildObjectActionTitle } from "@synap-core/types/vocabulary";
import type { ProposalCluster } from "../proposals/fingerprint.js";

/** What a signal points AT — an object-nav address the browser can dispatch. */
export interface SignalTarget {
  /** An `objectNavTarget` kind: `proposal`, `channel`, `entity`, `automation`… */
  kind: string;
  id: string;
}

export type SignalKind =
  /** A collapsed group of identical-shape pending proposals. */
  | "proposal-cluster"
  /** One unread, non-proposal notification. */
  | "notification"
  /** A past `events` row (history lens). */
  | "event"
  /** A proposal that has been approved / rejected / expired (history lens). */
  | "decided-proposal";

/** One row in either lens. Deliberately identical in both, so the tray and the
 *  history feed render from ONE shape. */
export interface Signal {
  id: string;
  kind: SignalKind;
  /** Human title, taken from data on the row — never composed ad hoc. */
  title: string;
  /** How many underlying things this row stands for (1 unless a cluster). */
  count: number;
  occurredAt: Date;
  /** Object-nav address, or null when the source has no addressable target. */
  target: SignalTarget | null;
  /** Notification category vocabulary: governance | data | ai | system | inbox. */
  category: string;
}

/**
 * The minimum a notification row must expose to become a signal. Mirrors the
 * `notifications` columns the reader already selects — no DB dependency.
 */
export interface NotificationSignalInput {
  id: string;
  title: string;
  category: string;
  sourceType: string;
  sourceId: string | null;
  createdAt: Date;
}

/**
 * `notifications.source_type` → object-nav kind.
 *
 * Only source types whose `sourceId` is provably an id of the mapped kind are
 * listed. Everything else resolves to `null` (no click-through) rather than
 * being guessed into a route that cannot load — the same graceful no-op
 * `objectNavTarget` already returns for unmapped kinds. `connector` is absent
 * on purpose: its `sourceId` is a CONNECTION id, which is not addressable by
 * any nav kind today.
 */
export const NOTIFICATION_TARGET_KIND: Readonly<Record<string, string>> = {
  proposal: "proposal",
  entity: "entity",
  automation: "automation",
  agent: "run",
  proactive_message: "channel",
  ai_proactive: "channel",
};

/** Object-nav address for a notification, or null when it has none. */
export function targetFromNotification(
  sourceType: string,
  sourceId: string | null
): SignalTarget | null {
  if (!sourceId) return null;
  const kind = NOTIFICATION_TARGET_KIND[sourceType];
  return kind ? { kind, id: sourceId } : null;
}

/** One cluster → one signal. Title via the vocabulary SSOT, imperative mood
 *  (the card describes what approving it WILL do, not what happened). */
export function signalFromCluster(cluster: ProposalCluster): Signal {
  const sampleId = cluster.sampleProposalIds[0] ?? null;
  return {
    id: `cluster:${cluster.fingerprint}`,
    kind: "proposal-cluster",
    title: buildObjectActionTitle({
      action: cluster.proposalType,
      objectKind: cluster.targetType,
      objectName: cluster.targetLabel,
      mood: "imperative",
    }),
    count: cluster.count,
    occurredAt: cluster.latestAt,
    target: sampleId ? { kind: "proposal", id: sampleId } : null,
    // Clusters are always a governance decision — that is what a pending
    // proposal IS. Same category vocabulary the notifications table uses.
    category: "governance",
  };
}

/** One unread notification → one signal. */
export function signalFromNotification(row: NotificationSignalInput): Signal {
  return {
    id: `notification:${row.id}`,
    kind: "notification",
    title: row.title,
    count: 1,
    occurredAt: row.createdAt,
    target: targetFromNotification(row.sourceType, row.sourceId),
    category: row.category,
  };
}

/**
 * The notifications that survive the dedupe: not proposal-sourced, and not
 * pointing at a proposal a cluster already represents. Exported separately from
 * {@link unionNeedsYou} because `signals.count` needs the SAME filtered set
 * without paying for the mapping.
 */
export function dedupeNotifications(
  rows: NotificationSignalInput[],
  clusters: ProposalCluster[]
): NotificationSignalInput[] {
  const clusteredProposalIds = new Set<string>();
  for (const c of clusters) {
    for (const id of c.sampleProposalIds) clusteredProposalIds.add(id);
  }
  return rows.filter((r) => {
    if (r.sourceType === "proposal") return false;
    if (r.sourceId && clusteredProposalIds.has(r.sourceId)) return false;
    return true;
  });
}

/**
 * The `needs-you` union: clusters + deduped unread notifications, newest first.
 * Pure — feed it the two doors' rows and it decides membership and order.
 */
export function unionNeedsYou(args: {
  clusters: ProposalCluster[];
  notifications: NotificationSignalInput[];
}): Signal[] {
  const signals = [
    ...args.clusters.map(signalFromCluster),
    ...dedupeNotifications(args.notifications, args.clusters).map(
      signalFromNotification
    ),
  ];
  return signals.sort(
    (a, b) => b.occurredAt.getTime() - a.occurredAt.getTime()
  );
}

/**
 * ONE number for both badges (tray and bell). `distinct` is the cluster count
 * BEFORE any page slice — `proposals.groups` computes it, and its
 * `scanTruncated` flag says whether it is a total or a FLOOR. That truncation
 * is carried through here rather than being flattened away, so a caller can
 * never render a floor as if it were exact.
 */
export function countNeedsYou(args: {
  /** `proposals.groups`.distinct — distinct pending fingerprints. */
  distinctClusters: number;
  /** `proposals.groups`.scanTruncated. */
  clustersTruncated: boolean;
  /** Unread notifications, already page-limited by the caller. */
  notifications: NotificationSignalInput[];
  clusters: ProposalCluster[];
  /** The notification page hit its limit, so its count is a floor too. */
  notificationsTruncated: boolean;
}): { needsYou: number; distinct: number; truncated: boolean } {
  const notifCount = dedupeNotifications(
    args.notifications,
    args.clusters
  ).length;
  const total = args.distinctClusters + notifCount;
  return {
    needsYou: total,
    distinct: total,
    truncated: args.clustersTruncated || args.notificationsTruncated,
  };
}
