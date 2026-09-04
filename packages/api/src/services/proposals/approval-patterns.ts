/**
 * Approval patterns — the "notice" rung of record → notice → propose → ratify.
 *
 * Answers ONE question over data that already exists: *which event shape has
 * repeatedly led to a proposal a human approved?* That is the evidence a
 * promoter would later need to say "make this a standing automation" — but it is
 * useful long before any promotion threshold is met, because "you approved this
 * 3 times" is itself worth showing.
 *
 * WHY THIS IS A READ AND NOT A TABLE: the whole chain is already joinable —
 * `proposals.step_run_id → automation_step_runs.run_id → automation_runs`, whose
 * `trigger_payload` carries the `eventType` that fired the run. Every column is
 * indexed (`idx_proposals_step_run_id`, `automation_step_runs_run_id_idx`,
 * `automation_runs_automation_id_idx`). Prior art says "detect on a projection,
 * never the raw event log" — at this volume the projection IS this query, and
 * materializing it now would be infrastructure ahead of evidence. Materialize
 * when the scan hurts, not before.
 *
 * ── The three choices that decide whether this measures anything real ────────
 *
 * 1. KEYED ON MOTIF, NEVER ON FINGERPRINT. The key is
 *    `${eventType}` × `${targetType}.${proposalType}` — the SAME motif
 *    vocabulary `recommend-tighten` and the widen scanner speak, so all three
 *    lanes glob-match against one language. The structural fingerprint
 *    (`computeProposalFingerprint`) embeds OBJECT identity (`id:<targetId>` for
 *    every non-create class), which is right for duplicate detection and fatal
 *    here: "same shape, different objects" would shatter into clusters of one.
 *    That mistake already cost this codebase a recommender that fired ZERO times
 *    — qualify on the key you act on, or you measure a different population than
 *    you govern.
 *
 * 2. A HUMAN VERDICT, NOT A SYSTEM ONE. `auto_approved` is counted but kept in
 *    its OWN field and never folded into `approvedByHuman`. An auto-approved row
 *    means governance already decided the shape is fine and no person ever
 *    looked — treating it as approval would let the system cite its own past
 *    decisions as evidence for widening further, which is the loop governance
 *    exists to close. For the same reason the denominator admits only DECIDED
 *    statuses: counting PENDING would let a chatty agent suppress its own signal
 *    by flooding the queue.
 *
 * 3. FAST APPROVAL IS NOT APPROVAL. A verdict returned inside
 *    `MIN_DELIBERATION_MS` is a rubber stamp or a bulk action, and is excluded
 *    from the human count (still reported in the funnel). Bot output waved
 *    through by implicit trust is exactly how a dependency bot distributed
 *    malware across ~895 repositories; the analogue here is a pattern promoted
 *    on evidence nobody actually read.
 *
 * ── The funnel is not optional ───────────────────────────────────────────────
 * `funnel` reports what was examined and where it fell out. A detector whose
 * normal output is "nothing to report" is INDISTINGUISHABLE from one that is
 * structurally dead — this codebase has shipped two such detectors, both fired
 * zero times, and neither was noticed for weeks. Any caller that surfaces
 * patterns must be able to say WHY there are none.
 *
 * Access: floored with `userVisibleWhere` exactly as `proposals.list` and
 * `proposals.groups` do. This read never widens what a caller can see — it only
 * groups rows they could already list.
 */

import {
  db,
  and,
  eq,
  inArray,
  isNotNull,
  desc,
  count,
  proposals,
  automationRuns,
  automationStepRuns,
  ProposalStatus,
} from "@synap/database";
import { userVisibleWhere } from "../../utils/user-visible-where.js";

/** Rows scanned before grouping — mirrors `recommend-tighten`'s SCAN_LIMIT. */
const SCAN_LIMIT = 1000;

/**
 * A verdict faster than this is a rubber stamp, not a decision. Deliberately
 * generous: the point is to drop bulk "approve all" and reflex clicks, not to
 * judge a reviewer who genuinely recognised the row on sight.
 */
const MIN_DELIBERATION_MS = 3_000;

/** One (event shape → action shape) pair and how humans have decided on it. */
export interface ApprovalPattern {
  /** The WHEN, read from the triggering run's payload (e.g. `dev.commit`). */
  eventType: string;
  /** The action motif `${targetType}.${proposalType}` — the shared vocabulary. */
  motif: string;
  /** Distinct proposals a HUMAN approved after real deliberation. The signal. */
  approvedByHuman: number;
  /** Distinct proposals a human rejected. The counter-evidence. */
  rejected: number;
  /** Approved by policy with no human in the loop. Reported, never evidence. */
  autoApproved: number;
  /** Human approvals returned faster than MIN_DELIBERATION_MS. Reported only. */
  rubberStamped: number;
  /** Distinct ISO weeks the pair was decided in — ≥2 kills burst artefacts. */
  distinctWeeks: number;
  /** Distinct targets — ≥2 proves "same shape, different objects". */
  distinctSubjects: number;
  firstDecidedAt: Date;
  lastDecidedAt: Date;
  /**
   * One real proposal this pattern was learned FROM — the most recent
   * human-approved member.
   *
   * ── WHY AN EXEMPLAR, AND WHY THIS ONE ──────────────────────────────────
   * A pattern on its own is a statistic; you cannot act on it. Turning "you
   * approved this 3 times" into a standing rule needs a concrete request to
   * seed from (`sourceProposalId` for lineage, `agentUserId` for whose lane is
   * being widened), and neither is derivable from the aggregate — the scan
   * keys on eventType × motif ACROSS agents. Without this the suggestion is a
   * card the user can read and nothing can act on, which is the built-but-
   * severed shape this codebase keeps paying for.
   *
   * It is deliberately drawn from `approvedByHuman` ONLY. Seeding from an
   * auto-approved member would let the system cite its own past decision as
   * the basis for widening further — the loop governance exists to close, and
   * the same reason `autoApproved` is counted but never treated as evidence.
   * A rubber-stamped verdict (faster than `MIN_DELIBERATION_MS`) is excluded
   * for the same reason: it is not a decision anyone made.
   *
   * MOST RECENT because a widening should be justified by the freshest
   * evidence; an exemplar from six months ago may describe a shape the user
   * would no longer accept.
   *
   * `agentUserId` is null for a human-authored proposal. Absent means "no
   * agent lane to widen", never "widen everyone's".
   */
  exemplar: {
    proposalId: string;
    agentUserId: string | null;
    decidedAt: Date;
  } | null;
}

/**
 * Where the scanned rows went. Publish this wherever patterns are shown: it is
 * the only way a reader can tell "nothing qualified" from "I am broken".
 */
export interface ApprovalPatternFunnel {
  /**
   * Every decided proposal the caller can see. Counted separately from the
   * scan because the scan INNER-joins the automation chain: when this number is
   * large and `producedByAutomation` is ~0, the honest reading is "patterns are
   * empty because almost nothing here was produced by an automation" — which is
   * a different problem from "no pattern repeated often enough", and the two are
   * indistinguishable without this number.
   */
  decidedTotal: number;
  /** …of which were produced by an automation step run (the scanned set). */
  producedByAutomation: number;
  /** …of which resolved to a run whose payload names an `eventType`. */
  withEventType: number;
  /** …of which were a real human verdict (reviewer set, past the fast floor). */
  humanDecided: number;
  /** Distinct (eventType, motif) pairs the survivors formed. */
  distinctPatterns: number;
}

export interface ApprovalPatternScan {
  patterns: ApprovalPattern[];
  funnel: ApprovalPatternFunnel;
}

/** The statuses that represent a decision. PENDING is deliberately absent. */
const DECIDED = [
  ProposalStatus.APPROVED,
  ProposalStatus.AUTO_APPROVED,
  ProposalStatus.REJECTED,
];

/** ISO-week bucket key — groups a decision by the week it was made. */
function weekKey(d: Date): string {
  const t = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  );
  // Thursday of the current week decides the ISO year (ISO-8601 §4.3.2).
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(
    ((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7
  );
  return `${t.getUTCFullYear()}-W${week}`;
}

interface Bucket {
  eventType: string;
  motif: string;
  approvedByHuman: Set<string>;
  rejected: Set<string>;
  autoApproved: Set<string>;
  rubberStamped: Set<string>;
  weeks: Set<string>;
  subjects: Set<string>;
  first: Date;
  last: Date;
  /** Most recent HUMAN-APPROVED member — the only defensible seed. */
  exemplar: {
    proposalId: string;
    agentUserId: string | null;
    decidedAt: Date;
  } | null;
}

/**
 * Scan the caller's visible decided proposals and group them into
 * (event shape → action shape) patterns.
 *
 * `workspaceId` is deliberately NOT a three-state here: this read is about what
 * the user has decided across their whole pod, and narrowing it per workspace
 * would silently shrink the evidence for a pattern that legitimately spans
 * lenses. Callers that need a lens should filter the RESULT.
 */
export async function scanApprovalPatterns(input: {
  userId: string;
  scanLimit?: number;
}): Promise<ApprovalPatternScan> {
  const scanLimit = input.scanLimit ?? SCAN_LIMIT;

  // ONE query: the decided queue joined to the automation chain that produced
  // it. A LEFT join would let us count proposals with no automation origin, but
  // those can never carry an eventType and so can never form a pattern — the
  // funnel reports that population from the scanned total instead.
  const rows = await db
    .select({
      id: proposals.id,
      proposalType: proposals.proposalType,
      targetType: proposals.targetType,
      targetId: proposals.targetId,
      status: proposals.status,
      reviewedBy: proposals.reviewedBy,
      reviewedAt: proposals.reviewedAt,
      createdAt: proposals.createdAt,
      agentUserId: proposals.agentUserId,
      triggerPayload: automationRuns.triggerPayload,
    })
    .from(proposals)
    .innerJoin(
      automationStepRuns,
      eq(automationStepRuns.id, proposals.stepRunId)
    )
    .innerJoin(automationRuns, eq(automationRuns.id, automationStepRuns.runId))
    .where(
      and(
        inArray(proposals.status, DECIDED),
        isNotNull(proposals.stepRunId),
        userVisibleWhere(proposals.workspaceId, input.userId)
      )
    )
    .orderBy(desc(proposals.createdAt))
    .limit(scanLimit);

  // The denominator the inner join threw away. Without it, "no patterns" reads
  // as "nothing repeats" when the truth may be "nothing is automation-produced".
  const [totals] = await db
    .select({ n: count() })
    .from(proposals)
    .where(
      and(
        inArray(proposals.status, DECIDED),
        userVisibleWhere(proposals.workspaceId, input.userId)
      )
    );

  const funnel: ApprovalPatternFunnel = {
    decidedTotal: totals?.n ?? 0,
    producedByAutomation: rows.length,
    withEventType: 0,
    humanDecided: 0,
    distinctPatterns: 0,
  };

  const buckets = new Map<string, Bucket>();

  for (const row of rows) {
    const payload = row.triggerPayload as { eventType?: unknown } | null;
    const eventType =
      typeof payload?.eventType === "string" ? payload.eventType : null;
    // A run with no eventType is a cron/manual/webhook fire: real, but it has no
    // WHEN to key on, so it cannot form a pattern. Not an error — just not this.
    if (!eventType) continue;
    funnel.withEventType += 1;

    const motif = `${row.targetType}.${row.proposalType}`;
    const key = `${eventType}${motif}`;
    const decidedAt = row.reviewedAt ?? row.createdAt;

    let b = buckets.get(key);
    if (!b) {
      b = {
        eventType,
        motif,
        approvedByHuman: new Set(),
        rejected: new Set(),
        autoApproved: new Set(),
        rubberStamped: new Set(),
        weeks: new Set(),
        subjects: new Set(),
        first: decidedAt,
        last: decidedAt,
        exemplar: null,
      };
      buckets.set(key, b);
    }

    if (decidedAt < b.first) b.first = decidedAt;
    if (decidedAt > b.last) b.last = decidedAt;
    b.weeks.add(weekKey(decidedAt));
    if (row.targetId) b.subjects.add(row.targetId);

    if (row.status === ProposalStatus.AUTO_APPROVED) {
      // Governance decided, not a person. Kept visible, never counted as signal.
      b.autoApproved.add(row.id);
      continue;
    }

    // A human verdict needs a reviewer AND enough elapsed time to be a decision.
    const deliberationMs =
      row.reviewedAt && row.createdAt
        ? row.reviewedAt.getTime() - row.createdAt.getTime()
        : null;
    const isHumanVerdict =
      !!row.reviewedBy &&
      deliberationMs !== null &&
      deliberationMs >= MIN_DELIBERATION_MS;

    if (!isHumanVerdict) {
      if (row.status === ProposalStatus.APPROVED) b.rubberStamped.add(row.id);
      continue;
    }
    funnel.humanDecided += 1;

    if (row.status === ProposalStatus.APPROVED) {
      b.approvedByHuman.add(row.id);
      // Most recent wins. Rows arrive `createdAt DESC`, but the comparison is
      // on the DECIDED instant and made explicit rather than relying on that
      // order — a change to the ORDER BY must not silently change which
      // proposal a standing rule cites as its basis.
      if (!b.exemplar || decidedAt > b.exemplar.decidedAt) {
        b.exemplar = {
          proposalId: row.id,
          agentUserId: row.agentUserId ?? null,
          decidedAt,
        };
      }
    } else if (row.status === ProposalStatus.REJECTED) b.rejected.add(row.id);
  }

  funnel.distinctPatterns = buckets.size;

  const patterns: ApprovalPattern[] = [...buckets.values()]
    .map((b) => ({
      eventType: b.eventType,
      motif: b.motif,
      approvedByHuman: b.approvedByHuman.size,
      rejected: b.rejected.size,
      autoApproved: b.autoApproved.size,
      rubberStamped: b.rubberStamped.size,
      distinctWeeks: b.weeks.size,
      distinctSubjects: b.subjects.size,
      firstDecidedAt: b.first,
      lastDecidedAt: b.last,
      exemplar: b.exemplar,
    }))
    // Strongest evidence first; a tie breaks toward the more recently confirmed.
    .sort(
      (a, z) =>
        z.approvedByHuman - a.approvedByHuman ||
        z.lastDecidedAt.getTime() - a.lastDecidedAt.getTime()
    );

  return { patterns, funnel };
}
