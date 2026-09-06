/**
 * Review-queue approval rate — "when the pod asks a human, do they say yes?"
 *
 * ONE number, and the counts under it. Anthropic published that Claude Code
 * users approve ~93% of permission prompts and named the failure "approval
 * fatigue"; their response was to REMOVE prompts, not polish the dialog. The
 * decide queue is the most carefully built surface in Synap's mobile app and
 * the pod did not measure whether a human ever says no to it. This is that
 * measurement — and nothing else: it reads governance rows, it never changes
 * what gets proposed, auto-approved or applied.
 *
 * ── THE DENOMINATOR (stated in the field name on purpose) ────────────────────
 * `approveRateOfReviewed` = `approvedInFull / reviewed`, where **`reviewed` is
 * the set of proposals a HUMAN actually decided**: `approved` (whole or gutted)
 * + `rejected`. Deliberately NOT "all proposals":
 *
 *   - `pending` / `approval_failed` — nobody has decided yet. In the
 *     denominator they would drag the rate toward 0 and make a busy queue look
 *     like a discerning one.
 *   - `withdrawn` / `expired` — no human judgment happened (the agent recalled
 *     it; the moment passed). Same "not scored" treatment `AgentStanding`
 *     gives them.
 *   - `auto_approved` — **the load-bearing exclusion.** An auto-approved write
 *     never reached the queue, so it cannot be evidence about the queue. Note
 *     this is exactly where this function must NOT reuse the lane scanner's
 *     `isFullApproval` (`packages/jobs/.../governance-lane-scanner.ts`), which
 *     counts `auto_approved` as an approval — correctly, because that gate
 *     scores an AGENT's trust, where an auto-approved write is still a write
 *     the pod stood behind. Two different questions, two different status
 *     sets, and folding them together would be a number that means neither.
 *     It is reported alongside as `autoApprovedNeverReviewed` so the exclusion
 *     is visible rather than silent.
 *
 * What IS reused is the careful part: `isPartiallyApprovedData` — the SAME
 * door `computeAgentScorecard` and `computeQualification` use to tell "kept 1
 * of 30" from "kept 30 of 30" (the row stores plain `"approved"` either way;
 * there is no separate status). A partial apply stays in the DENOMINATOR and
 * counts as NOT a full approval, matching both of those: the reviewer read the
 * package and threw part of it away — that is the queue doing its job, and it
 * is the single strongest evidence AGAINST the theatre hypothesis. Rounding it
 * up into `approved` would inflate the very number we are trying to trust.
 *
 * ⚠️ LENS. Every count here is floored by `proposalUserFloor` — the ONE builder
 * the review queue itself scopes on (lens ∪ ownership). The number therefore
 * describes THIS user's queue, not the pod's, and it is the same population the
 * queue renders. Say "of the proposals you could review" when quoting it.
 */

import { isPartiallyApprovedData } from "@synap-core/types/proposals";
import {
  db,
  and,
  eq,
  desc,
  inArray,
  drizzleSql,
  proposals,
  ProposalStatus,
} from "@synap/database";
import { proposalUserFloor } from "../../routers/proposals/scope-conditions.js";

/** The minimum a decided-proposal row must expose to be scored. */
export interface ReviewQueueDecisionRow {
  status: string;
  /** The stored `proposals.data` — feeds `isPartiallyApprovedData` only. */
  data: unknown;
}

/**
 * Below this many human decisions, the rate is noise. Reported as `lowSample`
 * so a caller cannot quote "100% approval" off four decisions with a straight
 * face.
 */
export const MIN_CONFIDENT_REVIEW_SAMPLE = 20;

export interface ReviewQueueApproval {
  /**
   * DENOMINATOR — human decisions only: `approvedInFull` +
   * `approvedWithItemsDenied` + `rejected`. Not pending, not withdrawn, not
   * expired, and NOT auto-approved.
   */
  reviewed: number;
  /** Approved with nothing denied inside. The NUMERATOR. */
  approvedInFull: number;
  /** Approved, but the reviewer denied at least one item (per-item dispositions). */
  approvedWithItemsDenied: number;
  rejected: number;
  /**
   * `approvedInFull / reviewed`, 4dp. **`null` when `reviewed === 0`** — a pod
   * nobody has reviewed on has no approval rate, and reporting 0 (or 1) there
   * is a fabricated finding.
   */
  approveRateOfReviewed: number | null;
  /** `reviewed < MIN_CONFIDENT_REVIEW_SAMPLE` — read the counts, not the rate. */
  lowSample: boolean;
  /**
   * Auto-approved writes: in NEITHER side of the rate, because they never
   * entered the human queue. Stated so the exclusion is auditable.
   */
  autoApprovedNeverReviewed: number;
  /**
   * The decision scan hit its cap, so the counts are the most recent N
   * decisions rather than lifetime. Never silently true.
   */
  truncated: boolean;
}

/**
 * PURE: counts + rate over a set of DECIDED proposal rows. DB-free.
 *
 * Rows with any other status are ignored rather than trusted to have been
 * filtered upstream — the denominator is defined here, in one place, so it can
 * never disagree with its own name.
 */
export function computeReviewQueueApproval(
  rows: ReviewQueueDecisionRow[],
  opts: { autoApprovedNeverReviewed: number; truncated: boolean }
): ReviewQueueApproval {
  let approvedInFull = 0;
  let approvedWithItemsDenied = 0;
  let rejected = 0;

  for (const r of rows) {
    if (r.status === ProposalStatus.APPROVED) {
      if (isPartiallyApprovedData(r.data)) approvedWithItemsDenied += 1;
      else approvedInFull += 1;
    } else if (r.status === ProposalStatus.REJECTED) {
      rejected += 1;
    }
    // Everything else — pending, auto_approved, withdrawn, expired, reverted,
    // approval_failed — is not a human decision on the queue. See the header.
  }

  const reviewed = approvedInFull + approvedWithItemsDenied + rejected;

  return {
    reviewed,
    approvedInFull,
    approvedWithItemsDenied,
    rejected,
    approveRateOfReviewed:
      reviewed > 0 ? Number((approvedInFull / reviewed).toFixed(4)) : null,
    lowSample: reviewed < MIN_CONFIDENT_REVIEW_SAMPLE,
    autoApprovedNeverReviewed: opts.autoApprovedNeverReviewed,
    truncated: opts.truncated,
  };
}

/** Above this share of full approvals, the queue is worth questioning. */
export const APPROVAL_FATIGUE_RATE = 0.9;

/**
 * The one-line verdict, so every surface reads the number the same way.
 * `"unknown"` whenever the sample cannot support a claim — the honest answer
 * when a pod has 3 decisions on it.
 */
export function reviewQueueVerdict(
  a: ReviewQueueApproval
): "unknown" | "discriminating" | "approval_fatigue" {
  if (a.approveRateOfReviewed === null || a.lowSample) return "unknown";
  return a.approveRateOfReviewed > APPROVAL_FATIGUE_RATE
    ? "approval_fatigue"
    : "discriminating";
}

// ── DB tier ──────────────────────────────────────────────────────────────────

/**
 * Cap on decided rows scanned. Above this the counts describe the most recent
 * N decisions and `truncated` says so.
 */
export const REVIEW_DECISION_SCAN_LIMIT = 2000;

/**
 * Gather this user's review-queue decisions and score them.
 *
 * Floored with `proposalUserFloor` — the SAME builder `proposals.list` /
 * `groups` scope the queue on (lens ∪ ownership), so this measures the queue
 * the user actually sees. `workspaceId` narrows to one lens exactly the way the
 * rest of `diagnoseGlobal` does.
 */
export async function reviewQueueApproval(params: {
  userId: string;
  workspaceId?: string | null;
}): Promise<ReviewQueueApproval> {
  const { userId } = params;
  const workspaceId = params.workspaceId ?? null;
  const scope = and(
    proposalUserFloor(userId),
    workspaceId ? eq(proposals.workspaceId, workspaceId) : undefined
  );

  const [decided, autoRow] = await Promise.all([
    // `data` is fetched ONLY for human-decided rows — it exists solely to feed
    // `isPartiallyApprovedData`, and re-deriving that JSONB shape in SQL to
    // avoid the fetch would be the second copy of the rule this codebase keeps
    // paying for.
    db
      .select({ status: proposals.status, data: proposals.data })
      .from(proposals)
      .where(
        and(
          scope,
          inArray(proposals.status, [
            ProposalStatus.APPROVED,
            ProposalStatus.REJECTED,
          ])
        )
      )
      .orderBy(desc(proposals.createdAt))
      .limit(REVIEW_DECISION_SCAN_LIMIT),
    // Auto-approved needs only a count — it is reported, never scored.
    db
      .select({ n: drizzleSql<number>`count(*)::int` })
      .from(proposals)
      .where(and(scope, eq(proposals.status, ProposalStatus.AUTO_APPROVED))),
  ]);

  return computeReviewQueueApproval(decided, {
    autoApprovedNeverReviewed: autoRow[0]?.n ?? 0,
    truncated: decided.length >= REVIEW_DECISION_SCAN_LIMIT,
  });
}
