/**
 * Review's rows — the needs-you page (`signals.list({ lens: "needs-you" })`,
 * the SAME population and order the browser and relay trays read) shaped
 * into what the console draws: one row per decision, filed under
 * Access · Changes · Asks, with its one verb.
 *
 * PURE. The page only renders what this returns, so the filing, the verbs
 * and the batch rules are tested at the seam.
 *
 *   Access  — who may act: `access-request` rows (a pending issuer, an app's
 *             origin) and proposal clusters of class `access` (an agent or
 *             app connecting, a role, a key). Decided one at a time, in the
 *             drawer: never inline, never batched.
 *   Changes — every other pending proposal cluster. Inline Approve only when
 *             the viewer may approve every member and it takes nothing away;
 *             batchable when the viewer may approve every member.
 *   Asks    — everything else a person owes (an answer, a review, a failed
 *             run to look at). Not decided here: the row opens it.
 *
 * Words come from the vocabulary door; nothing here names a kind by hand.
 */

import { DESTRUCTIVE_ACTIONS } from "@synap/governance-policy";
import {
  lensRowOfNeedsYou,
  type LensDoor,
  type LensNeedsYouSignal,
} from "@synap-core/types/lens";

export type ReviewGroup = "access" | "changes" | "asks";

/** A Review view: one group, all of them, or decided proposals. */
export type ReviewFilter = "all" | ReviewGroup | "history";

export const REVIEW_FILTERS: readonly ReviewFilter[] = [
  "all",
  "access",
  "changes",
  "asks",
  "history",
];

/** `?type=` → the view; anything unknown is "all". */
export function reviewFilterOf(param: string | null | undefined): ReviewFilter {
  return REVIEW_FILTERS.find((f) => f === param) ?? "all";
}

/** The fields of a needs-you signal Review reads (structural). */
export interface ReviewSignal extends LensNeedsYouSignal {
  /** Decision class (`access` = who may act). Clusters and access requests. */
  class?: string | null;
  /** A cluster's sampled member proposal ids (≤ 20; `count` may exceed). */
  proposalIds?: string[] | null;
  /** The most specific readable container — a session or project, named. */
  source?: { kind: string; id: string; label: string } | null;
}

/**
 * What `proposals.list` says about one pending proposal — the reviewer's own
 * verdict and the names the pod resolved. Keyed by proposal id.
 */
export interface ProposalFacts {
  id: string;
  proposalType: string;
  targetType: string;
  viewerCanReview: boolean;
  appName?: string | null;
  agentName?: string | null;
  authorName?: string | null;
  workspaceName?: string | null;
  data?: unknown;
}

/** What the row's one verb opens. */
export type ReviewDetail =
  | { kind: "proposal"; proposalId: string }
  | { kind: "issuer"; issuerId: string }
  | { kind: "app-request"; requestId: string }
  /** An ask: decided where it lives, so the row opens it there. */
  | { kind: "open"; door: LensDoor };

export interface ReviewRow {
  /** Stable key: the signal id. */
  key: string;
  group: ReviewGroup;
  /** Object kind for the noun chip + icon (`agent`, `issuer`, `track`…). */
  nounKind: string;
  title: string;
  /** Who asked — an agent's or app's NAME, never an id. Null = unknown. */
  who: string | null;
  /** Where — a space, project or session name, or an access request's origin. */
  where: string | null;
  /** A short state chip ("Needs your answer"), when the ask has one. */
  reason: string | null;
  /** How many identical things the row stands for (a cluster's N). */
  count: number;
  occurredAt: string | null;
  /** When it stops being answerable (ISO), or null when it never expires. */
  expiresAt: string | null;
  /** Null when the row has nothing to open. */
  detail: ReviewDetail | null;
  /** May be approved from the row itself. */
  inlineApprove: boolean;
  /** Every member proposal, when the row may join a batch; else null. */
  batchIds: string[] | null;
  /** Every id a `?focus=` may name this row by. */
  ids: string[];
}

/** Which group a needs-you signal files under. */
export function reviewGroupOf(
  s: Pick<ReviewSignal, "kind" | "class">
): ReviewGroup {
  if (s.kind === "access-request") return "access";
  if (s.kind === "proposal-cluster")
    return s.class === "access" ? "access" : "changes";
  return "asks";
}

/**
 * A proposal that TAKES SOMETHING AWAY — the governance floor's destructive
 * actions, plus the removal verbs below that floor. Read off the proposal's
 * own type and, for a capability run, the verb it executes
 * (`entity.delete`). Such a change is never approved from a list row.
 */
const REMOVAL_ACTIONS: ReadonlySet<string> = new Set([
  ...DESTRUCTIVE_ACTIONS,
  "remove",
  "revoke",
  "retire",
  "propose_retire",
]);

export function isRemoval(
  f: Pick<ProposalFacts, "proposalType" | "data">
): boolean {
  const action = (token: string) =>
    REMOVAL_ACTIONS.has(token.slice(token.lastIndexOf(".") + 1));
  if (action(f.proposalType)) return true;
  const data = f.data as { verbId?: unknown } | null | undefined;
  return typeof data?.verbId === "string" && action(data.verbId);
}

function iso(at: string | Date | null | undefined): string | null {
  if (!at) return null;
  const d = at instanceof Date ? at : new Date(at);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/** The members a cluster row decides, when the sample IS the whole cluster. */
function wholeCluster(s: ReviewSignal): string[] | null {
  const ids = s.proposalIds?.length
    ? s.proposalIds
    : s.target?.kind === "proposal"
      ? [s.target.id]
      : [];
  return ids.length > 0 && ids.length === Math.max(1, s.count) ? ids : null;
}

function proposalRow(
  s: ReviewSignal,
  group: ReviewGroup,
  facts: ReadonlyMap<string, ProposalFacts>
): Omit<ReviewRow, "key" | "group" | "title" | "occurredAt" | "count"> {
  const sampleId = s.target?.kind === "proposal" ? s.target.id : null;
  const sample = sampleId ? facts.get(sampleId) : undefined;
  const members = wholeCluster(s);
  // The viewer's OWN verdict on every member — the bar `approve` enforces.
  const approvable =
    members !== null &&
    members.every((id) => facts.get(id)?.viewerCanReview === true);
  const changes = group === "changes";
  return {
    nounKind: sample?.targetType || "proposal",
    who: sample?.appName || sample?.agentName || sample?.authorName || null,
    where: sample?.workspaceName || s.source?.label || null,
    reason: null,
    expiresAt: null,
    detail: sampleId ? { kind: "proposal", proposalId: sampleId } : null,
    inlineApprove:
      changes && approvable && sample !== undefined && !isRemoval(sample),
    batchIds: changes && approvable ? members : null,
    ids: [s.id, ...(s.proposalIds ?? (sampleId ? [sampleId] : []))],
  };
}

function accessRow(
  s: ReviewSignal
): Omit<ReviewRow, "key" | "group" | "title" | "occurredAt" | "count"> {
  const target = s.target;
  return {
    nounKind: s.access?.subject ?? "application",
    // The asker is named in the title; the row says where it asks from.
    who: null,
    where: s.access?.from ?? null,
    reason: null,
    expiresAt: null,
    detail:
      target?.kind === "issuer"
        ? { kind: "issuer", issuerId: target.id }
        : target?.kind === "connection-request"
          ? { kind: "app-request", requestId: target.id }
          : null,
    inlineApprove: false,
    batchIds: null,
    ids: [s.id, ...(target ? [target.id] : [])],
  };
}

function askRow(
  s: ReviewSignal
): Omit<ReviewRow, "key" | "group" | "title" | "occurredAt" | "count"> {
  // The shared lens row decides an ask's noun, chip and door — the same
  // words browser and relay draw for it.
  const lens = lensRowOfNeedsYou(
    { kind: "item", key: s.id, signal: s, session: null },
    "blocking"
  );
  return {
    nounKind: lens.objectKind,
    who: null,
    where: s.source?.label || s.sessionTitle || null,
    reason: lens.reason,
    expiresAt: null,
    detail: lens.door ? { kind: "open", door: lens.door } : null,
    inlineApprove: false,
    batchIds: null,
    ids: [s.id, ...(s.target ? [s.target.id] : [])],
  };
}

/**
 * The page's rows, in the SERVER's order (newest first across kinds), one per
 * signal — a session owing several things is several rows here: Review
 * decides each, it does not summarise.
 */
export function reviewRows(
  signals: readonly ReviewSignal[],
  facts: ReadonlyMap<string, ProposalFacts>
): ReviewRow[] {
  return signals.map((s) => {
    const group = reviewGroupOf(s);
    const shape =
      s.kind === "access-request"
        ? accessRow(s)
        : s.kind === "proposal-cluster"
          ? proposalRow(s, group, facts)
          : askRow(s);
    const occurredAt = iso(s.occurredAt);
    const expiresAt =
      s.lifetimeHours != null && occurredAt
        ? new Date(
            Date.parse(occurredAt) + s.lifetimeHours * 3_600_000
          ).toISOString()
        : null;
    return {
      ...shape,
      key: s.id,
      group,
      title: s.title,
      occurredAt,
      expiresAt,
      count: Math.max(1, s.count),
    };
  });
}

/** Rows per chip: All and each group. */
export function reviewCounts(
  rows: readonly ReviewRow[]
): Record<"all" | ReviewGroup, number> {
  const out = { all: rows.length, access: 0, changes: 0, asks: 0 };
  for (const r of rows) out[r.group] += 1;
  return out;
}

/** The rows a needs-you view shows ("history" is not a needs-you view). */
export function rowsInView(
  rows: readonly ReviewRow[],
  filter: Exclude<ReviewFilter, "history">
): ReviewRow[] {
  return filter === "all" ? [...rows] : rows.filter((r) => r.group === filter);
}

/** The row a `?focus=<id>` names — by signal, target or member proposal id. */
export function focusedRow(
  rows: readonly ReviewRow[],
  focusId: string | null
): ReviewRow | null {
  if (!focusId) return null;
  return rows.find((r) => r.ids.includes(focusId)) ?? null;
}

/** The most proposals one batch call takes (`proposals.batchApprove`). */
export const BATCH_MAX = 50;

/**
 * What a batch over the selected rows acts on: only batchable rows (never an
 * access row, never one the viewer may not approve whole), their member ids
 * flattened. `tooMany` past the batch door's limit.
 */
export function batchOf(
  rows: readonly ReviewRow[],
  selected: ReadonlySet<string>
): { rows: ReviewRow[]; proposalIds: string[]; tooMany: boolean } {
  const picked = rows.filter((r) => selected.has(r.key) && r.batchIds);
  const proposalIds = picked.flatMap((r) => r.batchIds ?? []);
  return {
    rows: picked,
    proposalIds,
    tooMany: proposalIds.length > BATCH_MAX,
  };
}

/** One per-proposal outcome of `proposals.batchApprove`. */
export interface BatchItemResult {
  proposalId: string;
  success: boolean;
  error?: string;
}

/**
 * A batch approve's outcome, per ROW: a row is approved when every member
 * landed; a failed member names its row's title and the pod's own reason.
 */
export function summarizeBatch(
  rows: readonly ReviewRow[],
  results: readonly BatchItemResult[]
): { approved: number; failures: Array<{ title: string; error: string }> } {
  const byId = new Map(results.map((r) => [r.proposalId, r]));
  let approved = 0;
  const failures: Array<{ title: string; error: string }> = [];
  for (const row of rows) {
    const failed = (row.batchIds ?? [])
      .map((id) => byId.get(id))
      .find((r) => r && !r.success);
    if (failed) {
      failures.push({
        title: row.title,
        error: failed.error?.trim() || "It could not be approved.",
      });
    } else approved += 1;
  }
  return { approved, failures };
}
