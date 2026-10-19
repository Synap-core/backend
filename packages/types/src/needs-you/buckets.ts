/**
 * needs-you BUCKETS — the ONE rule that files a needs-you row under one of the
 * four filters of the Inbox (founder decision 3A, 2026-10-19): Decisions ·
 * Questions · Routine changes · Broken. Shared by every surface (browser
 * triage today, relay `/blocked` later); never a per-surface classifier.
 *
 * A PARTITION: every row lands in exactly one bucket, so the four counts add
 * up to the list's total. The order of the tests below is the rule:
 *
 *   1. `broken`   — a work-broke notification ({@link isFailureSignal}): a run
 *                   or an automation FAILED. Failed work only — pod or system
 *                   health is the status banner, never a row (lens `classes`).
 *   2. `routine`  — ONE pending proposal the shared classifier calls safe to
 *                   decide at a glance (`isSwipeSafe`: routine impact,
 *                   reversible, an allow-listed kind). The ONLY bucket a
 *                   surface may batch-approve. FAILS CLOSED: the needs-you row
 *                   does not carry the proposal's fields, so the caller hands
 *                   them in (`intentOf`); no intent, an unmeasured
 *                   revertability, or a "×N" cluster (one sample id standing
 *                   for N) is a `decision`, never routine.
 *   3. `decision` — a verdict only the person can give: any other pending
 *                   proposal, an access request, an owed slot blocked on a
 *                   person's choice (`blockedReason: decision`).
 *   4. `question` — everything else that asks the person something: an owed
 *                   slot (an answer, a credential, an action), a session
 *                   awaiting review, a capture, any other notification. The
 *                   unknown kind lands here too — the bucket that never
 *                   batches and never reads as broken.
 *
 * The triage ORDER ("sorted by what blocks the most") is
 * {@link orderNeedsYouByBlocking}. It is the Inbox's reading only: a lens
 * section keeps the server's order (`needsYouRows` never sorts).
 */

import { FAILURE_NOTIFICATION_TYPES } from "../lens/classes.js";
import { isSwipeSafe, type ProposalIntentInput } from "../proposals/intent.js";

/** The four Inbox filters, in the order the filter control lists them. */
export const NEEDS_YOU_BUCKETS = [
  "decision",
  "question",
  "routine",
  "broken",
] as const;

export type NeedsYouBucket = (typeof NEEDS_YOU_BUCKETS)[number];

/** The fields of a needs-you `Signal` the bucket rule reads (structural). */
export interface BucketableSignal {
  id: string;
  kind: string;
  /** Units the row stands for — a cluster's proposals (1 otherwise). */
  count: number;
  /** `session:<id>` when the row belongs to a session's work. */
  groupKey?: string | null;
  /** `owed-slot`: what would unblock it. */
  blockedReason?: string | null;
  /** `notification`: the registry type — the failure test reads it. */
  notificationType?: string | null;
  /** Object-nav address — a decision row's `proposal` target. */
  target?: { kind: string; id: string } | null;
}

/** A work-broke notification ({@link FAILURE_NOTIFICATION_TYPES}): a failed run, not an ask. */
export function isFailureSignal(
  s: Pick<BucketableSignal, "kind" | "notificationType">
): boolean {
  return (
    s.kind === "notification" &&
    s.notificationType != null &&
    FAILURE_NOTIFICATION_TYPES.has(s.notificationType)
  );
}

/**
 * The ONE proposal a needs-you row stands for, or null — a `proposal-cluster`
 * row addressed to a proposal. A "×N" cluster still names one (its sample);
 * the routine test refuses it separately, because approving the sample would
 * decide one of N and read as deciding all.
 */
export function needsYouProposalId(
  s: Pick<BucketableSignal, "kind" | "target">
): string | null {
  return s.kind === "proposal-cluster" && s.target?.kind === "proposal"
    ? s.target.id
    : null;
}

export interface NeedsYouBucketOptions<T> {
  /**
   * The proposal's classifier input for a decision row (`proposals.list`
   * threaded through the surface's ONE input builder), or null/undefined when
   * the surface has not loaded it. Absent ⇒ never routine.
   */
  intentOf?: (signal: T) => ProposalIntentInput | null | undefined;
}

/** The blocked reason that is a choice only a person can make. */
const PERSON_DECISION_REASON = "decision";

/** Which of the four filters ONE row belongs to. See the module rule. */
export function needsYouBucketOf<T extends BucketableSignal>(
  signal: T,
  opts: NeedsYouBucketOptions<T> = {}
): NeedsYouBucket {
  if (isFailureSignal(signal)) return "broken";
  if (signal.kind === "proposal-cluster") {
    const intent = needsYouProposalId(signal) ? opts.intentOf?.(signal) : null;
    // Exactly one, or not single: a NaN / missing / null count (an untyped
    // wire row, an older pod) must not read as single — fails closed.
    const single = signal.count === 1;
    return single && intent && isSwipeSafe(intent) ? "routine" : "decision";
  }
  if (signal.kind === "access-request") return "decision";
  if (
    signal.kind === "owed-slot" &&
    signal.blockedReason?.trim().toLowerCase() === PERSON_DECISION_REASON
  ) {
    return "decision";
  }
  return "question";
}

/**
 * Rank of each bucket in the triage order — what blocks the most first:
 * a verdict an agent waits on, then an ask, then failed work (nothing waits
 * on it, but nothing moves until someone looks), and the routine changes last
 * (they are the batch row at the foot of the list).
 */
const BUCKET_RANK: Record<NeedsYouBucket, number> = {
  decision: 0,
  question: 1,
  broken: 2,
  routine: 3,
};

const SESSION_PREFIX = "session:";

/** The row belongs to a session's work: an agent's session is stopped on it. */
function blocksASession(s: BucketableSignal): boolean {
  return Boolean(s.groupKey?.startsWith(SESSION_PREFIX));
}

/** One row of the Inbox, with the bucket it files under. */
export interface NeedsYouBucketed<T> {
  signal: T;
  bucket: NeedsYouBucket;
}

/**
 * Sort by what blocks the most: bucket rank, then rows that stop a session's
 * work before free-standing ones, then the SERVER's order (newest first) —
 * a STABLE sort, so two rows the rule cannot tell apart keep the order the
 * pod gave them.
 */
export function orderNeedsYouByBlocking<T extends BucketableSignal>(
  rows: readonly NeedsYouBucketed<T>[]
): NeedsYouBucketed<T>[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort(
      (a, b) =>
        BUCKET_RANK[a.row.bucket] - BUCKET_RANK[b.row.bucket] ||
        Number(blocksASession(b.row.signal)) -
          Number(blocksASession(a.row.signal)) ||
        a.index - b.index
    )
    .map(({ row }) => row);
}

export interface NeedsYouBuckets<T> {
  /** Every row, filed and ordered by what blocks the most. */
  rows: NeedsYouBucketed<T>[];
  /**
   * Rows per bucket, in BADGE units (one per signal row, a cluster is one) —
   * so the four add up to `rows.length`, the list's own total.
   */
  counts: Record<NeedsYouBucket, number>;
}

/**
 * File a needs-you page under the four filters and order it for triage.
 * Pure; the caller filters with `rows.filter((r) => r.bucket === b)`.
 */
export function needsYouBuckets<T extends BucketableSignal>(
  signals: readonly T[],
  opts: NeedsYouBucketOptions<T> = {}
): NeedsYouBuckets<T> {
  const counts: Record<NeedsYouBucket, number> = {
    decision: 0,
    question: 0,
    routine: 0,
    broken: 0,
  };
  const filed = signals.map((signal) => {
    const bucket = needsYouBucketOf(signal, opts);
    counts[bucket] += 1;
    return { signal, bucket };
  });
  return { rows: orderNeedsYouByBlocking(filed), counts };
}

/**
 * A needs-you page in the Inbox order — the signals only, ready for
 * `needsYouRows` (which groups and folds but never sorts): a session's card
 * then lands at its MOST blocking item, the Older fold stays a stable
 * partition. ONE rule for the desktop Inbox (`triageModel`) and relay's
 * `/blocked` (founder decision 3A — two surfaces, one order).
 */
export function orderNeedsYouSignals<T extends BucketableSignal>(
  signals: readonly T[],
  opts: NeedsYouBucketOptions<T> = {}
): T[] {
  return needsYouBuckets(signals, opts).rows.map((r) => r.signal);
}

/**
 * The REASON a row carries as its glyph (decision · ask · review · failure,
 * or the owed slot's own blocker). Its own key set, not `needsYouItemKind`:
 * that one is the session card's COUNT unit and keeps a notification as
 * `notification`. Resolve the glyph with `resolveNeedsYouReasonIcon`
 * (`@synap-core/types/vocabulary`).
 */
export function needsYouReasonOf(signal: BucketableSignal): string {
  if (isFailureSignal(signal)) return "failure";
  switch (signal.kind) {
    case "proposal-cluster":
    case "access-request":
      return "decision";
    case "owed-slot":
      return signal.blockedReason?.trim().toLowerCase() || "owed";
    case "session-review":
      return "review";
    default:
      return "ask";
  }
}

// ── The Inbox's filter control and its routine batch ────────────────────────
//
// Moved here from browser `needs-you-triage-model.ts` (lane F2, 2026-10-19) so
// the desktop Inbox and relay's `/blocked` offer the SAME filters and batch
// the SAME rows — two surfaces, one rule (founder decision 3A).

/** What the filter control can show: every row, or one bucket. */
export type NeedsYouFilter = "all" | NeedsYouBucket;

/** Every filter, in the order the control lists them (All first). */
export const NEEDS_YOU_FILTERS: readonly NeedsYouFilter[] = [
  "all",
  ...NEEDS_YOU_BUCKETS,
];

/** An address value as a filter, or `all` (an unknown value never hides rows). */
export function readNeedsYouFilter(value: unknown): NeedsYouFilter {
  return typeof value === "string" &&
    (NEEDS_YOU_FILTERS as readonly string[]).includes(value)
    ? (value as NeedsYouFilter)
    : "all";
}

/** The filters worth offering: All, then each bucket that has rows (zero is omitted). */
export function needsYouFilters(
  counts: Record<NeedsYouBucket, number>
): NeedsYouFilter[] {
  return ["all", ...NEEDS_YOU_BUCKETS.filter((b) => counts[b] > 0)];
}

/**
 * The filter actually shown: the chosen one while it still has rows, else
 * All — a filter emptied by the reader's own decisions (or an address naming
 * an empty bucket) falls back to the whole list, never to a blank page.
 */
export function effectiveNeedsYouFilter(
  chosen: NeedsYouFilter,
  counts: Record<NeedsYouBucket, number>
): NeedsYouFilter {
  return needsYouFilters(counts).includes(chosen) ? chosen : "all";
}

/**
 * At this many routine changes, All folds them into ONE batch row; fewer are
 * rows like any other (a "batch of one" is a row with an extra click).
 */
export const ROUTINE_BATCH_MIN = 2;

export interface NeedsYouFilterView<R> {
  /** Rows drawn one by one, in order. */
  rows: R[];
  /**
   * The routine changes drawn as ONE batch row (empty ⇒ no batch row): in
   * All at {@link ROUTINE_BATCH_MIN} or more, and always under Routine.
   */
  batch: R[];
}

/**
 * One filter over rows already filed and ordered (`needsYouBuckets`): the
 * bucket's rows, and — the only batch — the routine changes. Pure.
 */
export function needsYouFilterView<R extends { bucket: NeedsYouBucket }>(
  rows: readonly R[],
  filter: NeedsYouFilter
): NeedsYouFilterView<R> {
  if (filter === "routine") {
    return { rows: [], batch: rows.filter((r) => r.bucket === "routine") };
  }
  if (filter !== "all") {
    return { rows: rows.filter((r) => r.bucket === filter), batch: [] };
  }
  const routine = rows.filter((r) => r.bucket === "routine");
  if (routine.length < ROUTINE_BATCH_MIN) return { rows: [...rows], batch: [] };
  return { rows: rows.filter((r) => r.bucket !== "routine"), batch: routine };
}
