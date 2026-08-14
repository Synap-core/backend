/**
 * Governance TIGHTEN recommender — the mirror image of the trusted-lane WIDEN
 * scanner (`packages/jobs/src/workers/governance-lane-scanner.ts`).
 *
 * Where the widen scanner PROPOSES opening an agent's auto-approve lane once it
 * has earned trust, this recommender PROPOSES pinning a specific agent
 * write-motif back to REVIEW when the humans keep saying no. It scans recent
 * REJECTED proposals per agent, groups them by ACTION MOTIF
 * (`${targetType}.${proposalType}` — the same key it files against, and the same
 * vocabulary the widen scanner's `computeDominantMotif` emits), and for any motif
 * the humans REJECT consistently (a conservative floor: ≥ MIN_CLUSTER_SIZE
 * rejects AND ≥ MIN_REJECT_RATE of that motif's attempts rejected) files ONE
 * pending `governance.tighten_lane` proposal. Approving it inserts a
 * `governance_rules` row with `verdict:'propose'` — see the approve-branch in
 * `packages/api/src/routers/proposals.ts`.
 *
 * NEVER silent + never a direct rule write: like the widen scanner, the ONLY
 * side effect is a PENDING proposal via the ONE door `insertPendingProposal`.
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
 *   - the motif vocabulary `${targetType}.${proposalType}` — identical to the
 *     widen scanner's `computeDominantMotif`, so both lanes speak one language
 *     and `hasCoveringProposeRule` can glob-match it.
 *   - the widen scanner's DB-tier STRUCTURE — agent enumeration, the resilient
 *     per-agent loop, the pending/covering-rule dedupe — mirrored here for
 *     tighten (per (agent, motif), not per agent, since one agent can have
 *     several consistently-rejected shapes).
 *
 * NOT reused: the scanner's per-agent scorecard fns (`computeQualification`,
 * `qualifiesForWidenLane`, `computeDominantMotif`) — those gate on an agent's
 * OVERALL trust and dominant APPROVED motif, which is the wrong axis for tighten:
 * a highly-trusted agent can still have ONE shape the humans reliably reject, and
 * tighten targets that shape regardless of the agent's global approve rate.
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
 * TODO (v2, deliberately out of scope): the "auto-approved-then-reverted"
 * detector — a shape that auto-approves under a widen rule but whose writes are
 * repeatedly undone/deleted afterwards. That needs a reverted-write signal
 * (edit/delete lineage on the materialized rows), which this v1 does not build.
 * v1 = always-rejected shape clusters only.
 */

import {
  db,
  and,
  eq,
  desc,
  isNull,
  inArray,
  proposals,
  users,
  governanceRules,
  proposalClusterMutes,
  insertPendingProposal,
  ProposalStatus,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import { emitSideEffects } from "@synap/events";
import { computeProposalFingerprint } from "./fingerprint.js";
import {
  proposalReasonBucket,
  classifyRejectionReason,
  dominantReason,
  UNKNOWN_REASON,
  type RejectionFaultClass,
} from "./reason-bucket.js";
import { notifyPodWideProposal } from "../../notifications/notify-pod-wide-proposal.js";
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
 * `governance.tighten_lane` proposal payload — the tighten mirror of
 * `GovernanceWidenLaneProposalData` (proposals.ts). The subject agent lives in
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

/** Mirrors SCAN_LIMIT in governance-lane-scanner.ts. */
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
  return db
    .select({ id: users.id, createdByUserId: users.createdByUserId })
    .from(users)
    .where(eq(users.userType, "agent"));
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
    if (!deduped) {
      void notifyPodWideProposal({
        proposalId: proposal.id,
        proposalType,
        // VISIBILITY is the whole reason the advisory is a proposal and not an
        // event: it rides the same pod-wide bell + review inbox the rule does.
        description: isMechanical
          ? `${targetPattern} rejected ${rejected.count}× as "${reason}" (${Math.round(rejectRate * 100)}%) — likely a code-level fix, not a stricter gate`
          : `Pin ${targetPattern} to review (rejected ${rejected.count}× — ${Math.round(rejectRate * 100)}%, mostly "${reason}")`,
        // The SUBJECT agent, for bell grouping — mirrors the workspace path's
        // `agentUserId` grouping key. `proposals.agentUserId` is null here (this
        // recommender authors the row), so it comes from the payload.
        agentUserId: agent.id,
      });
    }

    void emitSideEffects({
      subjectType: "proposal",
      action: "created",
      subjectId: proposal.id,
      userId: agent.createdByUserId,
      data: {
        proposalStatus: "created",
        targetType: "governance",
        changeType: proposalType,
      },
    }).catch((err) => {
      logger.warn(
        { err, proposalId: proposal.id, agentId: agent.id },
        "recommend-tighten: emitSideEffects failed (non-fatal)"
      );
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
 * agent's failure never aborts the batch (mirror handleGovernanceLaneScan).
 * Returns the ids of every filed `governance.tighten_lane` proposal.
 */
export async function recommendTightenForAllAgents(): Promise<{
  proposalsFiled: number;
  proposalIds: string[];
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

  logger.info(
    {
      agents: agents.length,
      failed,
      mutedFingerprints: mutedFingerprints.size,
      proposalsFiled: proposalIds.length,
    },
    "recommend-tighten: scan complete"
  );
  return { proposalsFiled: proposalIds.length, proposalIds };
}
