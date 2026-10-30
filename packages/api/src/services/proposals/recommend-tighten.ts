/**
 * Governance TIGHTEN recommender — the mirror image of the trust ladder's
 * earned streak (`@synap-core/types/trust-ladder` `earnedStreak`, offered on
 * the card by `governanceRules.nextRungs`; it replaced the daily widen-lane
 * scanner, structural plan S3).
 *
 * Where the streak OFFERS opening an agent's auto-approve lane once it has
 * earned trust, this recommender PROPOSES pinning a specific agent
 * write-motif back to REVIEW when the humans keep saying no. It scans recent
 * REJECTED proposals per agent, groups them by ACTION MOTIF
 * (`${targetType}.${proposalType}` — the same key it files against, and the
 * same vocabulary as the ladder's `proposalEventKey`), and for any motif
 * the humans REJECT consistently (a conservative floor: ≥ MIN_CLUSTER_SIZE
 * rejects AND ≥ MIN_REJECT_RATE of that motif's attempts rejected) files ONE
 * pending `governance.tighten_lane` proposal. Approving it inserts a
 * `governance_rules` row with `verdict:'propose'` — see the approve-branch in
 * `packages/api/src/routers/proposals.ts`.
 *
 * NEVER silent + never a direct rule write for a FINDING: its only side effect
 * is a PENDING proposal via the ONE door `insertPendingProposal`. The one
 * direct write in this module is the PAUSE below, and it only ever narrows:
 * a soft revoke of an earned grant, with the reason the rule page shows.
 * The verb RUNS this (files review items) — it is not itself a governed graph
 * mutation, so it auto-runs inside a cron automation (marked read-only in
 * `builtin-verbs.ts`, same rationale as `connector.health_check`).
 *
 * NOT the structural fingerprint: `collapseProposalsToClusters` keys on a
 * per-OBJECT signature (`id:<targetId>` for every non-create class), which is
 * correct for DUPLICATE detection but wrong here — see the axis-mismatch note at
 * the qualification site below.
 *
 * REUSE, not reinvention:
 *   - the motif vocabulary `${targetType}.${proposalType}` — the event key the
 *     ladder grants on, so both directions speak one language and
 *     `hasCoveringProposeRule` can glob-match it.
 *   - the retired widen scanner's DB-tier STRUCTURE — agent enumeration, the
 *     resilient per-agent loop, the pending/covering-rule dedupe — per
 *     (agent, motif), not per agent, since one agent can have several
 *     consistently-rejected shapes.
 *
 * NOT reused: the old scanner's per-agent scorecard gate (overall trust and a
 * dominant APPROVED motif) — the wrong axis for tighten: a highly-trusted agent
 * can still have ONE shape the humans reliably reject, and tighten targets
 * that shape regardless of the agent's global approve rate.
 *
 * REASON-AWARE (2026-08-14): counting rejections was never enough — a count says
 * HOW OFTEN, never WHY. This module now reads the rejection's `reasonCode`
 * (falling back to free-text `rejectionReason` for pre-0232 rows, via the shared
 * `proposalReasonBucket`), computes the DOMINANT reason per qualifying motif, and
 * CLASSIFIES it:
 *
 *   - MECHANICAL fault (`duplicate` / `wrong_kind_or_facet` / `wrong_link_type`):
 *     a `propose` rule is the WRONG remedy. Live-pod dogfood: an agent hit
 *     duplicateRate 0.82 by re-creating playbooks that already existed. Pinning
 *     `playbook.create` to review fixes NOTHING — those writes are ALREADY
 *     pending review; the remedy is a code-level existence check. Patching policy
 *     for a deterministic bug is a named anti-pattern; corrections belong on the
 *     cheapest durable surface (tool schema/idempotency → description → error
 *     strings → few-shot → standing prompt). So we file an ADVISORY, not a rule.
 *   - JUDGMENT fault (everything else, including `unknown`): the write was
 *     well-formed but unwanted. That is exactly what a `propose` rule is for —
 *     unchanged `governance.tighten_lane` behaviour.
 *
 * NEVER FABRICATED: a rejection with no reason at all buckets as `unknown`, and a
 * motif whose dominant bucket is `unknown` keeps TODAY's behaviour (rule). The
 * classifier only ever moves a motif OFF the rule path on positive evidence.
 *
 * THE PAUSE (founder Q3, 29 Oct) — the "auto-approved-then-reverted" detector.
 * A grant the ladder EARNED (`source_proposal_id` set: granted from a card, or
 * a legacy widen-lane approval) pauses when {@link PAUSE_AFTER_REVERTS}
 * receipts it decided (`_autoApprove.governanceRuleId`) are undone within
 * {@link PAUSE_WINDOW_DAYS} days: the soft revoke (`revoked_at`) plus
 * `revoked_reason = RULE_PAUSED_AFTER_REVERTS`. The next card of that kind
 * asks again (`nextRungs` `paused`), and only approvals after the pause earn
 * it back. Run right after an undo (`proposals.revert`) and, as a backstop, by
 * the daily tighten pass. A rule a person wrote at the editor is never paused:
 * they decided it, not a streak. Prior art: ServiceNow retires a standard
 * change on failure; Claude Code's auto mode pauses after repeated blocks.
 */

import {
  db,
  and,
  eq,
  desc,
  drizzleSql,
  isNotNull,
  isNull,
  inArray,
  proposals,
  users,
  governanceRules,
  proposalClusterMutes,
  insertPendingProposal,
  ProposalStatus,
  notAnAppAgent,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import { RULE_PAUSED_AFTER_REVERTS } from "@synap-core/types/trust-ladder";
import { computeProposalFingerprint } from "./fingerprint.js";
import {
  proposalReasonBucket,
  classifyRejectionReason,
  dominantReason,
  UNKNOWN_REASON,
  type RejectionFaultClass,
} from "./reason-bucket.js";
import { notifyProposalCreatedOrdered } from "../../notifications/notify-proposal-created-ordered.js";
const SAMPLE_CAP = 20;

/**
 * The two proposal types this recommender can file for a (agent, motif). Both
 * are deduped together: a motif already carrying an OPEN finding of EITHER shape
 * must not accrue a second one just because its dominant reason drifted across
 * the mechanical/judgment line between scans.
 */
export const TIGHTEN_LANE_TYPE = "governance.tighten_lane";
export const ADVISORY_TYPE = "governance.advisory";

const logger = createLogger({ module: "governance-recommend-tighten" });

/**
 * `governance.tighten_lane` proposal payload (mirrored in apply-approval.ts).
 * The subject agent lives in
 * `agentUserId` HERE (the payload), not on `proposals.agentUserId` — this
 * recommender authors the proposal, the agent does not. `verdict` is always
 * "propose": a tighten proposal only ever pins a motif to review, never widens.
 */
/**
 * The evidence both findings carry. Shared so the human sees the SAME numbers
 * whichever way the classifier routed the motif — the only difference between an
 * advisory and a rule proposal must be the REMEDY, never the evidence.
 */
export interface TightenEvidence {
  /** Number of REJECTED proposals in the consistently-rejected shape cluster. */
  clusterSize: number;
  /** rejected(shape) / total(shape) — how reliably the humans reject it. */
  rejectRate: number;
  /** Total proposals of this shape (all statuses) the reject rate is over. */
  totalForShape: number;
  /** Up to 20 member (rejected) proposal ids as evidence. */
  sampleProposalIds: string[];
  /**
   * WHY, not just how often. The most common rejection bucket across the
   * cluster — a taxonomy `reasonCode`, a lowercased legacy free-text reason, or
   * `"unknown"` when the rejections carried no reason at all.
   */
  dominantReason: string;
  /** Full bucket → count breakdown, so the human can see how lopsided it is. */
  reasonHistogram: Record<string, number>;
  /** What the dominant reason says the fault IS — drives which finding is filed. */
  faultClass: RejectionFaultClass;
}

export interface GovernanceTightenLaneProposalData {
  agentUserId: string;
  /** Tighten always targets an ACTION motif (`${targetType}.${proposalType}`). */
  targetKind: "action";
  targetPattern: string;
  scopeKind: "pod";
  verdict: "propose";
  evidence: TightenEvidence;
}

/**
 * `governance.advisory` payload — the MECHANICAL-fault sibling of
 * `GovernanceTightenLaneProposalData`.
 *
 * Same subject, same evidence, DIFFERENT remedy: this one asks a human to fix
 * CODE (an existence check, a tool schema, a description), not to tighten a gate.
 * Approving it writes NOTHING — it is a pure acknowledgement (see the no-op
 * branch in `routers/proposals/apply-approval.ts`).
 *
 * DELIBERATELY has NO `verdict` field. A distinct proposal type with no verdict
 * cannot be mistaken for a rule-writing payload by any current or future reader;
 * the alternative (`tighten_lane` + `advisory:true`) would have left a payload
 * that the EXISTING approve branch — which keys on `proposalType` alone — happily
 * turns into a `governance_rules` row if any caller misses the flag. Fail-safe
 * beats flag-safe for anything that can widen or pin governance.
 */
export interface GovernanceAdvisoryProposalData {
  agentUserId: string;
  targetKind: "action";
  targetPattern: string;
  scopeKind: "pod";
  /** What kind of advisory this is — the only value v1 emits. */
  advisoryKind: "mechanical_fault";
  /**
   * The cheapest durable surface the correction likely belongs on. Guidance for
   * the human, not machine-enforced.
   */
  suggestedRemedy: string;
  evidence: TightenEvidence;
}

/** Per-reason hint at where the fix actually belongs. */
const REMEDY_BY_REASON: Record<string, string> = {
  duplicate:
    "Add an existence/idempotency check to the tool before it proposes a create — a review gate cannot deduplicate.",
  wrong_kind_or_facet:
    "Resolve identity + read `list_profiles.profileKind` first and attach a facet instead of creating an entity — fix the tool contract, not the gate.",
  wrong_link_type:
    "Constrain the relation type to the enumerable valid set in the tool schema — an invalid type should be unrepresentable, not reviewable.",
};

/** Mirrors CAP_TRUST_WINDOW in permission-check.ts (the newest 500). */
const SCAN_LIMIT = 500;

/**
 * Conservative floor — recommender NOISE is the failure mode, so the bar is high
 * (mirrors the spirit of the widen bar's MIN_TOTAL / MIN_APPROVE_RATE).
 *   - MIN_CLUSTER_SIZE: at least this many REJECTS of the same shape.
 *   - MIN_REJECT_RATE: at least this fraction of that shape's attempts rejected.
 */
const MIN_CLUSTER_SIZE = 5;
const MIN_REJECT_RATE = 0.9;

interface AgentRow {
  id: string;
  createdByUserId: string | null;
}

/**
 * The columns motif qualification + MUTE EXCLUSION read.
 *
 * Grouping is by motif, so `createdAt` / `workspaceId` stay dropped. But
 * `targetId` and `data` are back: `computeProposalFingerprint` needs exactly
 * those two (plus proposalType/targetType) to reproduce the per-object
 * fingerprint the "Mark expected" mute is keyed on. Without them this scan
 * cannot tell a muted rejection from a live one.
 */
interface ScanRow {
  id: string;
  proposalType: string;
  targetType: string;
  status: string;
  /** Fingerprint input — the mute key's per-object signature. */
  targetId: string;
  /** Fingerprint input — the create-class signature reads the proposed name. */
  data: unknown;
  /** Structured rejection taxonomy (migration 0232). Null on non-rejects. */
  reasonCode?: string | null;
  /** Free-text rejection reason — the pre-0232 fallback. */
  rejectionReason?: string | null;
}

async function listAgentUsers(): Promise<AgentRow[]> {
  return (
    db
      .select({ id: users.id, createdByUserId: users.createdByUserId })
      .from(users)
      // An app's agent is governed on its app's page, never recommended here.
      .where(and(eq(users.userType, "agent"), notAnAppAgent(users.id)))
  );
}

/** The subject agent's recent proposals (all statuses) — mirror loadAgentProposals. */
async function loadAgentProposals(agentId: string): Promise<ScanRow[]> {
  return db
    .select({
      id: proposals.id,
      proposalType: proposals.proposalType,
      targetType: proposals.targetType,
      status: proposals.status,
      targetId: proposals.targetId,
      data: proposals.data,
      // WHY the humans said no — the classifier's whole input.
      reasonCode: proposals.reasonCode,
      rejectionReason: proposals.rejectionReason,
    })
    .from(proposals)
    .where(eq(proposals.agentUserId, agentId))
    .orderBy(desc(proposals.createdAt))
    .limit(SCAN_LIMIT);
}

/**
 * Any PENDING finding of EITHER shape already open for this (agent, motif).
 * Mirror of the scanner's `hasPendingWidenProposal`, but keyed on
 * (agent, targetPattern) — tighten can file several motifs per agent, so the
 * dedupe is per-motif, not per-agent. The subject agent + motif live in `data`
 * (this recommender authors the row; `proposals.agentUserId` is null).
 *
 * BOTH types, ONE query: the classifier can route the same motif to a rule this
 * scan and an advisory the next (a few late-arriving `duplicate` rejections flip
 * the dominant reason). Deduping per-type would let the same motif accumulate one
 * of each. One open finding per (agent, motif) is the invariant.
 */
async function hasPendingFinding(
  agentId: string,
  targetPattern: string
): Promise<boolean> {
  const rows = await db
    .select({ data: proposals.data })
    .from(proposals)
    .where(
      and(
        inArray(proposals.proposalType, [TIGHTEN_LANE_TYPE, ADVISORY_TYPE]),
        eq(proposals.status, ProposalStatus.PENDING)
      )
    );
  return rows.some((r) => {
    const data = r.data as Partial<GovernanceTightenLaneProposalData> | null;
    return (
      data?.agentUserId === agentId && data?.targetPattern === targetPattern
    );
  });
}

/**
 * A covering `propose` rule already pins this (agent, motif) to review. Mirror of
 * the scanner's `hasCoveringRule` (exact / glob / "*" pattern match) but filtered
 * to `verdict:'propose'` action rules — a tighten proposal that would insert a
 * propose rule the pod already holds is redundant, so skip. (An existing `auto`
 * rule is NOT a covering rule here: an agent that was widened but is now
 * consistently rejected is exactly the case tighten SHOULD flag.)
 */
async function hasCoveringProposeRule(
  agentId: string,
  targetPattern: string
): Promise<boolean> {
  const wildcardPattern = `${targetPattern.split(".")[0]}.*`;
  const active = await db
    .select({
      targetKind: governanceRules.targetKind,
      targetPattern: governanceRules.targetPattern,
      verdict: governanceRules.verdict,
    })
    .from(governanceRules)
    .where(
      and(
        eq(governanceRules.principalKind, "agent"),
        eq(governanceRules.agentUserId, agentId),
        isNull(governanceRules.revokedAt)
      )
    );
  return active.some(
    (r) =>
      r.verdict === "propose" &&
      r.targetKind === "action" &&
      (r.targetPattern === targetPattern ||
        r.targetPattern === wildcardPattern ||
        r.targetPattern === "*")
  );
}

/**
 * Every ACTIVE "Mark expected" mute (`proposal_cluster_mutes`, migration 0233),
 * as a fingerprint set. Pod-scoped and agent-independent, so it is loaded ONCE
 * per scan and handed to every agent pass — never re-queried per agent or per
 * motif (the per-(agent,motif) `hasPendingTightenProposal` /
 * `hasCoveringProposeRule` N+1 already flagged in review is not to be joined by
 * a third).
 */
async function loadActiveMutedFingerprints(): Promise<ReadonlySet<string>> {
  const rows = await db
    .select({ fingerprint: proposalClusterMutes.fingerprint })
    .from(proposalClusterMutes)
    .where(isNull(proposalClusterMutes.revokedAt));
  return new Set(rows.map((r) => r.fingerprint));
}

/** Scan ONE agent; file a tighten proposal per consistently-rejected shape. */
async function recommendTightenForAgent(
  agent: AgentRow,
  mutedFingerprints: ReadonlySet<string>
): Promise<string[]> {
  if (!agent.createdByUserId) return [];

  const rows = await loadAgentProposals(agent.id);
  if (rows.length === 0) return [];

  // QUALIFY ON THE MOTIF — the SAME axis this recommender ACTS on.
  //
  // Dogfood finding (2026-08-11): qualifying on the canonical FINGERPRINT was an
  // axis mismatch that made this recommender unfireable in practice. The
  // fingerprint embeds a per-object signature — `id:<targetId>` for every
  // non-create class (delete / update / merge / attach) — so N rejections of the
  // same ACTION against N different objects produce N clusters of size 1 and
  // never reach MIN_CLUSTER_SIZE. On a real pod, 11 rejected `entity.delete`
  // proposals scored 11 clusters of 1 (fires: never) instead of one motif at 11
  // (fires: correctly). The fingerprint is the right key for DUPLICATE detection
  // ("the same thing proposed twice"); the motif is the right key for tighten
  // ("this action shape keeps getting refused"). Since the filed proposal always
  // targets `${targetType}.${proposalType}`, qualifying on anything narrower
  // measured a different population than it acted on.
  const motifOf = (r: { targetType: string; proposalType: string }) =>
    `${r.targetType}.${r.proposalType}`;

  // MUTE AWARENESS — the two axes must not contradict each other.
  //
  // "Mark expected" (`proposal_cluster_mutes`, 0233) keys on the structural
  // FINGERPRINT; this recommender qualifies on the MOTIF, which is strictly
  // coarser (many fingerprints roll up into one motif). Without this filter a
  // human who marks a rejection cluster expected keeps feeding exactly those
  // rejections into a proposal to pin the WHOLE motif to review — the recommender
  // escalates what the human just declared benign, and re-files it after every
  // reject. A muted rejection is a human verdict of "this is fine", so it is not
  // evidence of anything here.
  //
  // REMOVED FROM BOTH NUMERATOR AND DENOMINATOR — deliberately. Dropping muted
  // rows from the numerator only would leave them sitting in the denominator
  // behaving like approvals: N muted rejections would drag the rate below the
  // 0.9 floor and SUPPRESS tighten for the remaining, genuinely-contested
  // rejections of the same motif. That is the same dilution bug already fixed
  // for PENDING rows just below. Excluding them from both keeps the rate's
  // meaning honest: "of the decided attempts still treated as signal, how
  // reliably do the humans reject this shape". A motif whose rejections are
  // ENTIRELY muted simply disappears from the scan, which is the correct outcome.
  const isMuted = (r: ScanRow) =>
    mutedFingerprints.size > 0 &&
    mutedFingerprints.has(
      computeProposalFingerprint({
        proposalType: r.proposalType,
        targetType: r.targetType,
        targetId: r.targetId,
        data: r.data,
      })
    );

  // Denominator: attempts per motif that a HUMAN ACTUALLY DECIDED.
  //
  // Only decided outcomes belong in a rate whose meaning is "how reliably do the
  // humans reject this". PENDING / EXPIRED / APPROVAL_FAILED / WITHDRAWN are not
  // verdicts — counting them dilutes the numerator against rows nobody judged.
  // Worst case they invert the loop this recommender exists to close: an agent
  // with 9 rejected + 2 still-pending `entity.delete` scores 9/11 = 0.82 < 0.9
  // and stays silent, so a chatty agent that keeps a steady backlog of the same
  // shape pending PERMANENTLY SUPPRESSES its own tighten recommendation.
  const DECIDED: ReadonlySet<string> = new Set<string>([
    ProposalStatus.APPROVED,
    ProposalStatus.AUTO_APPROVED,
    ProposalStatus.REJECTED,
  ]);
  const decidedByMotif = new Map<string, number>();
  for (const r of rows) {
    if (!DECIDED.has(r.status)) continue;
    if (isMuted(r)) continue;
    const m = motifOf(r);
    decidedByMotif.set(m, (decidedByMotif.get(m) ?? 0) + 1);
  }

  // Numerator: rejected attempts per motif (+ evidence sample ids + WHY).
  //
  // The reason histogram is accumulated on the SAME pass over the SAME filtered
  // rows the count comes from — so the dominant reason always describes exactly
  // the population the rate was measured over (muted rows excluded from both, no
  // second scan that could drift). A rejection with no reason at all buckets as
  // `unknown`; it is never dropped (that would silently make one loud reason
  // "dominant" over a mostly-unreasoned cluster) and never guessed at.
  const rejectedByMotif = new Map<
    string,
    {
      count: number;
      sampleProposalIds: string[];
      reasons: Map<string, number>;
    }
  >();
  for (const r of rows) {
    if (r.status !== ProposalStatus.REJECTED) continue;
    if (isMuted(r)) continue;
    const m = motifOf(r);
    const acc = rejectedByMotif.get(m) ?? {
      count: 0,
      sampleProposalIds: [],
      reasons: new Map<string, number>(),
    };
    acc.count += 1;
    if (acc.sampleProposalIds.length < SAMPLE_CAP)
      acc.sampleProposalIds.push(r.id);
    const bucket =
      proposalReasonBucket(r.reasonCode, r.rejectionReason) ?? UNKNOWN_REASON;
    acc.reasons.set(bucket, (acc.reasons.get(bucket) ?? 0) + 1);
    rejectedByMotif.set(m, acc);
  }
  if (rejectedByMotif.size === 0) return [];

  const filed: string[] = [];

  // Most-rejected motifs first — worst offenders lead. NOTE: there is no per-run
  // cap; every qualifying motif is filed (the ≥5-count + ≥0.9-rate floors and the
  // per-(agent,motif) dedupe are what bound the volume).
  const motifs = Array.from(rejectedByMotif.entries()).sort(
    (a, b) => b[1].count - a[1].count
  );

  for (const [targetPattern, rejected] of motifs) {
    if (rejected.count < MIN_CLUSTER_SIZE) continue;
    const totalForShape = decidedByMotif.get(targetPattern) ?? rejected.count;
    const rejectRate = Number((rejected.count / totalForShape).toFixed(4));
    if (rejectRate < MIN_REJECT_RATE) continue;

    if (await hasPendingFinding(agent.id, targetPattern)) continue;

    // CLASSIFY — the point of the reason-aware wave. The dominant reason decides
    // WHICH remedy is even coherent, before any redundancy check runs.
    const reason = dominantReason(rejected.reasons);
    const faultClass = classifyRejectionReason(reason);
    const isMechanical = faultClass === "mechanical";

    // The covering-rule check is a RULE-redundancy check: "the pod already pins
    // this motif to review, so proposing to pin it again is noise". It says
    // nothing about a mechanical fault — a propose rule does not fix a missing
    // existence check, so an advisory stays warranted regardless. Skipped (and
    // the DB call saved) on the advisory path deliberately.
    if (
      !isMechanical &&
      (await hasCoveringProposeRule(agent.id, targetPattern))
    )
      continue;

    const evidence: TightenEvidence = {
      clusterSize: rejected.count,
      rejectRate,
      totalForShape,
      sampleProposalIds: rejected.sampleProposalIds,
      dominantReason: reason,
      reasonHistogram: Object.fromEntries(rejected.reasons),
      faultClass,
    };

    const data:
      GovernanceTightenLaneProposalData | GovernanceAdvisoryProposalData =
      isMechanical
        ? {
            agentUserId: agent.id,
            targetKind: "action",
            targetPattern,
            scopeKind: "pod",
            advisoryKind: "mechanical_fault",
            suggestedRemedy:
              REMEDY_BY_REASON[reason] ??
              "Fix the tool contract that produces this shape — a review gate cannot correct a malformed write.",
            evidence,
          }
        : {
            agentUserId: agent.id,
            targetKind: "action",
            targetPattern,
            scopeKind: "pod",
            verdict: "propose",
            evidence,
          };

    const proposalType = isMechanical ? ADVISORY_TYPE : TIGHTEN_LANE_TYPE;

    const { proposal, deduped } = await insertPendingProposal({
      workspaceId: null,
      targetType: "governance",
      targetId: agent.id,
      proposalType,
      data: data as unknown as Record<string, unknown>,
      createdBy: agent.createdByUserId,
      proposedByUserId: null,
      // OWNER FLOOR (0248): the human who owns this agent decides its lane.
      subjectUserId: agent.createdByUserId,
    });

    // TELL A HUMAN. `insertPendingProposal` is the durable one-door but it fires
    // NO notification — the pod-wide fan-out lives in `notifyProposalCreated`
    // (permission-check), which this path never reaches. Without this call every
    // tighten proposal was INVISIBLE: the recommender asked a human to decide
    // something and never told them, so the calibration loop's last link was
    // open. Pod-wide (`workspaceId: null`) → owner + admins, via the SAME
    // extracted helper permission-check now uses. Non-fatal + self-logging: the
    // proposal is already committed, and the helper never throws.
    // A dedup hit returns a PRE-EXISTING pending row that already notified when
    // it was first filed — same guard `createPendingProposal` applies.
    // ORDERED: the fan-out completes before the side effect is emitted, so the
    // emit's pod-wide reactor finds the bell row instead of racing it.
    await notifyProposalCreatedOrdered({
      podWide: deduped
        ? null
        : {
            proposalId: proposal.id,
            proposalType,
            // VISIBILITY is the whole reason the advisory is a proposal and not
            // an event: it rides the same pod-wide bell + review inbox the rule
            // does.
            description: isMechanical
              ? `${targetPattern} rejected ${rejected.count}× as "${reason}" (${Math.round(rejectRate * 100)}%) — likely a code-level fix, not a stricter gate`
              : `Pin ${targetPattern} to review (rejected ${rejected.count}× — ${Math.round(rejectRate * 100)}%, mostly "${reason}")`,
            // The SUBJECT agent, for bell grouping — mirrors the workspace
            // path's `agentUserId` grouping key. `proposals.agentUserId` is null
            // here (this recommender authors the row), so it comes from the
            // payload.
            agentUserId: agent.id,
          },
      sideEffect: {
        subjectId: proposal.id,
        userId: agent.createdByUserId,
        data: {
          proposalStatus: "created",
          targetType: "governance",
          changeType: proposalType,
        },
      },
      onEmitError: (err) =>
        logger.warn(
          { err, proposalId: proposal.id, agentId: agent.id },
          "recommend-tighten: emitSideEffects failed (non-fatal)"
        ),
    });

    filed.push(proposal.id);
    logger.info(
      {
        agentId: agent.id,
        motif: targetPattern,
        rejectRate,
        clusterSize: rejected.count,
        dominantReason: reason,
        faultClass,
        proposalType,
      },
      isMechanical
        ? "recommend-tighten: filed ADVISORY (mechanical fault — rule would be the wrong remedy)"
        : "recommend-tighten: filed tighten_lane proposal"
    );
  }

  return filed;
}

/**
 * Scan EVERY agent-user and file tighten proposals. Resilient per-agent — one
 * agent's failure never aborts the batch. Then the pause backstop
 * ({@link pauseEarnedRulesAfterReverts}), non-fatal.
 * Returns the ids of every filed `governance.tighten_lane` proposal.
 */
export async function recommendTightenForAllAgents(): Promise<{
  proposalsFiled: number;
  proposalIds: string[];
  /** Agents whose scan threw (logged per agent) — the cron reports it. */
  agentsFailed: number;
}> {
  logger.info("recommend-tighten: starting scan");
  const agents = await listAgentUsers();
  // ONCE per scan: the mute set is pod-scoped and agent-independent.
  const mutedFingerprints = await loadActiveMutedFingerprints();
  const proposalIds: string[] = [];
  let failed = 0;

  for (const agent of agents) {
    try {
      const filed = await recommendTightenForAgent(agent, mutedFingerprints);
      proposalIds.push(...filed);
    } catch (err) {
      failed += 1;
      logger.error(
        { err, agentId: agent.id },
        "recommend-tighten: failed for agent, skipping"
      );
    }
  }

  // Backstop for the undo door's own call: a pause missed there (a crash, a
  // per-item undo) is caught within a day.
  let rulesPaused = 0;
  try {
    rulesPaused = await pauseEarnedRulesAfterReverts();
  } catch (err) {
    logger.error({ err }, "recommend-tighten: pause backstop failed");
  }

  logger.info(
    {
      agents: agents.length,
      failed,
      mutedFingerprints: mutedFingerprints.size,
      proposalsFiled: proposalIds.length,
      rulesPaused,
    },
    "recommend-tighten: scan complete"
  );
  return {
    proposalsFiled: proposalIds.length,
    proposalIds,
    agentsFailed: failed,
  };
}

// ─── The pause (founder Q3) ─────────────────────────────────────────────────

/** Undone receipts under one earned grant that pause it… */
export const PAUSE_AFTER_REVERTS = 2;
/** …within this many days. */
export const PAUSE_WINDOW_DAYS = 30;

const DAY_MS = 86_400_000;

/**
 * A receipt UNDONE: reverted (whole, or its last item), or reverted and then
 * re-proposed (`revertedAt` stays in its data). When: the stamp, else the
 * review instant the revert door writes.
 */
const undone = () =>
  drizzleSql`(${proposals.status} = 'reverted' or ${proposals.data} ? 'revertedAt')`;
const undoneAt = () =>
  drizzleSql`coalesce((${proposals.data}->>'revertedAt')::timestamptz, ${proposals.reviewedAt})`;
/** The rule that decided a receipt (`_autoApprove.governanceRuleId`). */
const decidingRuleId = () =>
  drizzleSql<string>`${proposals.data}->'_autoApprove'->>'governanceRuleId'`;

/**
 * Pause ONE earned grant if {@link PAUSE_AFTER_REVERTS} receipts it decided
 * were undone within {@link PAUSE_WINDOW_DAYS} days. Only an ACTIVE, EARNED
 * (`source_proposal_id`), agent-scoped `auto` action rule is ever paused.
 * Returns whether this call paused it (a race with a concurrent pause or a
 * person's revoke writes nothing).
 */
export async function pauseEarnedRuleAfterReverts(
  ruleId: string,
  now: Date = new Date()
): Promise<boolean> {
  const [rule] = await db
    .select({ id: governanceRules.id })
    .from(governanceRules)
    .where(
      and(
        eq(governanceRules.id, ruleId),
        isNull(governanceRules.revokedAt),
        isNotNull(governanceRules.sourceProposalId),
        eq(governanceRules.principalKind, "agent"),
        eq(governanceRules.targetKind, "action"),
        eq(governanceRules.verdict, "auto")
      )
    )
    .limit(1);
  if (!rule) return false;

  const since = new Date(now.getTime() - PAUSE_WINDOW_DAYS * DAY_MS);
  const [row] = await db
    .select({ n: drizzleSql<number>`count(*)::int` })
    .from(proposals)
    .where(
      and(
        drizzleSql`${decidingRuleId()} = ${ruleId}`,
        undone(),
        drizzleSql`${undoneAt()} >= ${since.toISOString()}::timestamptz`
      )
    );
  if (Number(row?.n ?? 0) < PAUSE_AFTER_REVERTS) return false;

  const paused = await db
    .update(governanceRules)
    .set({ revokedAt: now, revokedReason: RULE_PAUSED_AFTER_REVERTS })
    .where(
      and(eq(governanceRules.id, ruleId), isNull(governanceRules.revokedAt))
    )
    .returning({ id: governanceRules.id });
  if (paused.length > 0) {
    logger.info(
      { ruleId },
      "recommend-tighten: earned rule paused after undos"
    );
  }
  return paused.length > 0;
}

/**
 * The undo door's call: an undone RECEIPT names the rule that decided it
 * (`_autoApprove.governanceRuleId`); that rule may now pause. Non-fatal — the
 * undo has already happened, and the daily pass is the backstop.
 */
export async function pauseRuleOfUndoneReceipt(data: unknown): Promise<void> {
  const ruleId = (
    data as { _autoApprove?: { governanceRuleId?: unknown } } | null
  )?._autoApprove?.governanceRuleId;
  if (typeof ruleId !== "string") return;
  try {
    await pauseEarnedRuleAfterReverts(ruleId);
  } catch (err) {
    logger.warn({ err, ruleId }, "recommend-tighten: pause after undo failed");
  }
}

/**
 * The daily backstop: every rule {@link PAUSE_AFTER_REVERTS} undone receipts
 * name within the window, each checked and paused by
 * {@link pauseEarnedRuleAfterReverts}. Returns how many were paused.
 */
export async function pauseEarnedRulesAfterReverts(
  now: Date = new Date()
): Promise<number> {
  const since = new Date(now.getTime() - PAUSE_WINDOW_DAYS * DAY_MS);
  const ruleId = decidingRuleId();
  const candidates = await db
    .select({ ruleId })
    .from(proposals)
    .where(
      and(
        drizzleSql`${ruleId} is not null`,
        undone(),
        drizzleSql`${undoneAt()} >= ${since.toISOString()}::timestamptz`
      )
    )
    .groupBy(ruleId)
    .having(drizzleSql`count(*) >= ${PAUSE_AFTER_REVERTS}`);
  let paused = 0;
  for (const c of candidates) {
    if (await pauseEarnedRuleAfterReverts(c.ruleId, now)) paused += 1;
  }
  return paused;
}
