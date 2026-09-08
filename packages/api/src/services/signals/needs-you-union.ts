/**
 * Signal union + dedupe — the PURE core behind `signals.list` / `signals.count`.
 *
 * ONE signal door, two lenses. `needs-you` is the union of three
 * ALREADY-EXISTING reads: the pending proposal CLUSTERS (`proposals.groups`),
 * the UNREAD notifications (`notifCenter.list`) and the OWED SLOTS
 * (`focusSessions.owed`) — deliverables an agent handed back to the human and
 * nobody has closed. None is re-implemented here — the
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
import { normalizeExpectedLabel } from "../focus-sessions/expected-label.js";
import type { ExpectedOutput } from "@synap/playbooks";
import type { ProposalCluster } from "../proposals/fingerprint.js";
import type { ProposalClass } from "../proposals/proposal-class.js";

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
  | "decided-proposal"
  /** One deliverable an agent handed to the human and nobody has closed. */
  | "owed-slot";

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
  /**
   * Decision CLASS of a `proposal-cluster` signal, carried straight off the
   * cluster (which derives it through `proposalClassFields`, the one door).
   * Absent on every other kind — a notification, an event or an owed slot has
   * no class. In particular an owed slot does NOT get a sixth `ProposalClass`
   * invented for it: `class` is a PROPOSAL's decision class, consumed as an
   * ordering over proposals, and an obligation is not a decision. Its absent
   * `lifetimeHours` already carries the only thing a surface needs to know —
   * that it never expires.
   */
  /**
   * The CLASS of thing that would unblock an `owed-slot` — one of the closed
   * six (`credential | permission | capability | policy | decision | physical`).
   * Absent on every other kind, the same way `class` is cluster-only.
   *
   * Carried on the SIGNAL rather than re-fetched, deliberately. The owed door
   * is reached through `floorLens`, which maps an ABSENT workspace to `[]`
   * because `resolveScope` would otherwise fall back to the request header —
   * a rule whose own comment records that it "has shipped broken twice". A
   * surface that fetched the reason itself would have to reproduce that
   * mapping, which is the fork the lens helper exists to prevent.
   */
  blockedReason?: ExpectedOutput["blockedReason"];
  /** One line naming WHICH thing is missing — the resumption cue. `owed-slot` only. */
  why?: string;
  /** The agent's own (unverified) claim it produced this after all. `owed-slot` only. */
  claimedDone?: boolean;
  class?: ProposalClass;
  /**
   * Hours this class stays answerable; `null` when it never expires. Carried
   * WITH `class` and only with it, for the same reason `ProposalClassFields`
   * returns the pair: a surface that shows the ephemeral countdown must never
   * re-derive the lifetime from a table it does not own.
   */
  lifetimeHours?: number | null;
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
    // Forwarded, never re-derived: the cluster already carries the pair from
    // `proposalClassFields`, and every member shares it by construction
    // (proposalType + targetType are both fingerprint inputs).
    class: cluster.class,
    lifetimeHours: cluster.lifetimeHours,
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
 * The minimum an owed slot must expose to become a signal. A DB-free mirror of
 * the fields `listOwedSlots` (`focus-sessions/owed-outputs.ts`) already
 * projects — nothing is re-derived here.
 */
export interface OwedSlotSignalInput {
  sessionId: string;
  /** The DECLARED label. It is the title, verbatim — see below. */
  label: string;
  /** ISO-8601, written by the block door. The ordering key. */
  owedSince: string;
  /**
   * The three disclosure fields, carried from `listOwedSlots` straight through.
   * Optional here because a slot blocked before these existed has none — and an
   * absent reason must render as "no reason recorded", never as a guessed one.
   */
  blockedReason?: ExpectedOutput["blockedReason"];
  why?: string;
  claimedDone?: boolean;
}

/**
 * The sentinel `projectOwedSlots` writes for a slot whose `owedSince` predates
 * the invariant: it must sort as the OLDEST thing there is, not as "now".
 * `new Date("0000-00-00")` is an Invalid Date whose `getTime()` is NaN, and NaN
 * silently loses every comparison in a sort — so the string sentinel is mapped
 * to the epoch rather than parsed.
 */
function owedInstant(owedSince: string): Date {
  const parsed = new Date(owedSince);
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
}

/**
 * One owed slot → one signal.
 *
 * ONE ROW PER SLOT, never a cluster: a session owing three deliverables owes
 * three separately actionable things, and collapsing them would hide two behind
 * a count nobody can act on. `count: 1` says exactly that.
 *
 * The ID keys on {@link normalizeExpectedLabel} — the SAME casefold every slot
 * door matches on — so the id a surface round-trips into `attestOutput` can
 * never name a slot the matcher cannot find.
 *
 * TITLE IS THE LABEL, VERBATIM. It is the human string the agent declared, the
 * same way a notification's title is the column the registry already evaluated.
 * It is not a domain token, so it must not be run through the vocabulary — and
 * it must certainly not be `charAt(0).toUpperCase()`'d at this call site.
 */
export function signalFromOwedSlot(row: OwedSlotSignalInput): Signal {
  return {
    id: `slot:${row.sessionId}:${normalizeExpectedLabel(row.label) ?? ""}`,
    kind: "owed-slot",
    title: row.label,
    count: 1,
    occurredAt: owedInstant(row.owedSince),
    target: { kind: "session", id: row.sessionId },
    // Agent-originated work, so `ai` — the same category the registry gives
    // agent completions. Deliberately NOT `governance`: that category means a
    // pending permission DECISION, and an owed slot is an obligation, not a
    // decision. Miscategorising it would let a governance-only filter show a
    // number the governance queue cannot explain.
    category: "ai",
    // The three-layer disclosure a surface renders (chip, why-prose, the
    // agent's claim) is carried HERE rather than re-fetched — see the field
    // docs on `Signal`. Spread-free and explicit so an added `OwedSlot` field
    // is a deliberate choice to project, never an accident.
    ...(row.blockedReason ? { blockedReason: row.blockedReason } : {}),
    ...(row.why ? { why: row.why } : {}),
    ...(row.claimedDone !== undefined ? { claimedDone: row.claimedDone } : {}),
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
 * The `needs-you` union: owed slots, then clusters + deduped unread
 * notifications. Pure — feed it the three doors' rows and it decides membership
 * and order.
 *
 * ── WHY OWED SLOTS DO NOT PARTICIPATE IN THE DEDUPE ─────────────────────────
 * The dedupe set is a set of PROPOSAL ids, and it stays that way. The block
 * door (`block-output.ts`) creates NO notification, so there is no owed-slot
 * double-count to kill. And keying owed slots into that set by `sourceId` would
 * introduce one: `session.unblocked` is written with `sourceType: "system"` and
 * `sourceId` = the SESSION id (`notifications/session-unblock-reactor.ts`), so a
 * session that both owes you a deliverable and just had its last blocker clear
 * would have the unblock notification silently dropped. Those are two different
 * pieces of news about one session and both are yours to see.
 *
 * ── ORDERING: OWED SLOTS FIRST, OLDEST FIRST ────────────────────────────────
 * The rest of the tray is newest-first because a proposal decays — a fresh one
 * is the live one. An owed slot NEVER expires (that is the whole point of the
 * absent `lifetimeHours`), so for it age IS severity: a deliverable nobody has
 * closed in three weeks is the most urgent row on the board, not the least. The
 * two orderings are therefore opposite, which is why the group is sorted
 * separately and concatenated rather than merged on `occurredAt` — one sort
 * comparator cannot express both and would bury exactly the rows this feature
 * exists to surface.
 */
export function unionNeedsYou(args: {
  clusters: ProposalCluster[];
  notifications: NotificationSignalInput[];
  /** Required, not optional: a caller that forgets the third source ships a
   *  tray that silently under-reports, which is the defect, not a default. */
  owedSlots: OwedSlotSignalInput[];
}): Signal[] {
  const owed = args.owedSlots
    .map(signalFromOwedSlot)
    .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  const rest = [
    ...args.clusters.map(signalFromCluster),
    ...dedupeNotifications(args.notifications, args.clusters).map(
      signalFromNotification
    ),
  ].sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
  return [...owed, ...rest];
}

/**
 * How many rows of the page are RESERVED for decisions (clusters +
 * notifications) when there are that many to show.
 *
 * THE BUG THIS EXISTS FOR. `unionNeedsYou` puts every owed slot first — correct,
 * and settled: an owed slot never expires, so age is severity and the oldest
 * blocker is the most urgent row on the board. But the page was then a single
 * `slice(0, limit)` across the concatenation, which makes the two sources share
 * ONE cap: an UNBOUNDED, never-decaying source ahead of a bounded, decaying one.
 * At 37 live owed slots against a limit of 50 the browser already showed nothing
 * but owed slots; past 50 the pending-proposal queue is UNREACHABLE from the
 * tray while the badge keeps counting it. A queue you are told about and cannot
 * open is worse than one that is merely long.
 *
 * The ordering is untouched — owed slots still come first, oldest first, and a
 * reserved row is not a re-ordering. Only the CUT changes: each source keeps a
 * floor inside the page, so neither can evict the other entirely.
 *
 * WHY 10. The browser tray renders 7 rows without scrolling, so 10 guarantees
 * the whole visible tray cannot be one source plus a scroll to reach the other.
 * It is a floor, never an allocation: with fewer than 10 decisions the unused
 * rows go straight back to owed slots, and with none the page is all owed.
 */
export const RESERVED_DECISION_ROWS = 10;

/**
 * Page the union so neither source can starve the other. Pure.
 *
 * Splits on the signal's OWN `kind` rather than taking the two lists again —
 * the caller must not be able to page a different set from the one it ordered,
 * and re-deriving membership here would be a second answer to "what is an owed
 * slot". The reserve is capped at HALF the page so a small `limit` cannot
 * invert the settled ordering: at `limit: 1` the one row is still the oldest
 * blocker, not a proposal.
 */
export function pageNeedsYou(signals: Signal[], limit: number): Signal[] {
  const owed = signals.filter((s) => s.kind === "owed-slot");
  const rest = signals.filter((s) => s.kind !== "owed-slot");
  const reserved = Math.min(
    RESERVED_DECISION_ROWS,
    Math.floor(limit / 2),
    rest.length
  );
  const owedTake = Math.min(owed.length, Math.max(0, limit - reserved));
  const restTake = Math.min(rest.length, Math.max(0, limit - owedTake));
  return [...owed.slice(0, owedTake), ...rest.slice(0, restTake)];
}

/**
 * ONE number for both badges (tray and bell), plus the BREAKDOWN the badge
 * itself renders.
 *
 * `needsYou` is the full union total and is exactly `unionNeedsYou(...).length`
 * before any page slice — the count door and the list door must never disagree
 * about how many things need you.
 *
 * `blocked` is the owed-slot subset, carried separately because the badge shows
 * THAT number and not the total (founder-settled): a badge that added pending
 * proposals to blocked deliverables is textbook badge inflation — one number
 * standing for two populations with different urgencies and different verbs. A
 * client renders "Needs you (needsYou)" with a `blocked` badge from this ONE
 * query; nothing has to run a second count, and the counting rule is not forked
 * to produce the second number.
 *
 * `distinct` is the cluster count BEFORE any page slice — `proposals.groups`
 * computes it, and its `scanTruncated` flag says whether it is a total or a
 * FLOOR. That truncation is carried through here rather than being flattened
 * away, so a caller can never render a floor as if it were exact. The owed half
 * has the same hazard: `listOwedSlots` caps at `limit`, so a full page is a
 * floor too.
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
  /** Owed slots, already page-limited by the caller. */
  owedSlots: OwedSlotSignalInput[];
  /** The owed page hit its limit, so its count is a floor too. */
  owedTruncated: boolean;
}): {
  needsYou: number;
  distinct: number;
  truncated: boolean;
  blocked: number;
} {
  const notifCount = dedupeNotifications(
    args.notifications,
    args.clusters
  ).length;
  const blocked = args.owedSlots.length;
  const total = args.distinctClusters + notifCount + blocked;
  return {
    needsYou: total,
    distinct: total,
    truncated:
      args.clustersTruncated ||
      args.notificationsTruncated ||
      args.owedTruncated,
    blocked,
  };
}
