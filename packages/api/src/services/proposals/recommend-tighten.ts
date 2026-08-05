/**
 * Governance TIGHTEN recommender — the mirror image of the trusted-lane WIDEN
 * scanner (`packages/jobs/src/workers/governance-lane-scanner.ts`).
 *
 * Where the widen scanner PROPOSES opening an agent's auto-approve lane once it
 * has earned trust, this recommender PROPOSES pinning a specific agent
 * write-motif back to REVIEW when the humans keep saying no. It scans recent
 * REJECTED proposals per agent, clusters them by shape (the SAME structural
 * fingerprint the inbox groups on — `collapseProposalsToClusters`), and for any
 * shape the humans REJECT consistently (a conservative floor: ≥ MIN_CLUSTER_SIZE
 * rejects AND ≥ MIN_REJECT_RATE of that shape's attempts rejected) files ONE
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
 * REUSE, not reinvention:
 *   - `collapseProposalsToClusters` + `computeProposalFingerprint` (fingerprint.ts)
 *     — the canonical shape-cluster primitive. (The widen scanner MIRRORS this
 *     algorithm as `computeFingerprint` only because `@synap/jobs` cannot import
 *     `@synap/api`; this recommender lives IN api, so it uses the canonical fn.)
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
  proposals,
  users,
  governanceRules,
  insertPendingProposal,
  ProposalStatus,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import { emitSideEffects } from "@synap/events";
import {
  collapseProposalsToClusters,
  computeProposalFingerprint,
  type ClusterInputRow,
} from "./fingerprint.js";

const logger = createLogger({ module: "governance-recommend-tighten" });

/**
 * `governance.tighten_lane` proposal payload — the tighten mirror of
 * `GovernanceWidenLaneProposalData` (proposals.ts). The subject agent lives in
 * `agentUserId` HERE (the payload), not on `proposals.agentUserId` — this
 * recommender authors the proposal, the agent does not. `verdict` is always
 * "propose": a tighten proposal only ever pins a motif to review, never widens.
 */
export interface GovernanceTightenLaneProposalData {
  agentUserId: string;
  /** Tighten always targets an ACTION motif (`${targetType}.${proposalType}`). */
  targetKind: "action";
  targetPattern: string;
  scopeKind: "pod";
  verdict: "propose";
  evidence: {
    /** Number of REJECTED proposals in the consistently-rejected shape cluster. */
    clusterSize: number;
    /** rejected(shape) / total(shape) — how reliably the humans reject it. */
    rejectRate: number;
    /** Total proposals of this shape (all statuses) the reject rate is over. */
    totalForShape: number;
    /** Up to 20 member (rejected) proposal ids as evidence. */
    sampleProposalIds: string[];
  };
}

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

interface ScanRow {
  proposalType: string;
  targetType: string;
  targetId: string;
  data: unknown;
  status: string;
  createdAt: Date;
  workspaceId: string | null;
  id: string;
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
      targetId: proposals.targetId,
      data: proposals.data,
      status: proposals.status,
      createdAt: proposals.createdAt,
      workspaceId: proposals.workspaceId,
    })
    .from(proposals)
    .where(eq(proposals.agentUserId, agentId))
    .orderBy(desc(proposals.createdAt))
    .limit(SCAN_LIMIT);
}

/**
 * Any PENDING `governance.tighten_lane` proposal already open for this
 * (agent, motif). Mirror of the scanner's `hasPendingWidenProposal`, but keyed
 * on (agent, targetPattern) — tighten can file several motifs per agent, so the
 * dedupe is per-motif, not per-agent. The subject agent + motif live in `data`
 * (this recommender authors the row; `proposals.agentUserId` is null).
 */
async function hasPendingTightenProposal(
  agentId: string,
  targetPattern: string
): Promise<boolean> {
  const rows = await db
    .select({ data: proposals.data })
    .from(proposals)
    .where(
      and(
        eq(proposals.proposalType, "governance.tighten_lane"),
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

/** Scan ONE agent; file a tighten proposal per consistently-rejected shape. */
async function recommendTightenForAgent(agent: AgentRow): Promise<string[]> {
  if (!agent.createdByUserId) return [];

  const rows = await loadAgentProposals(agent.id);
  if (rows.length === 0) return [];

  // Totals per shape (ALL statuses) — the denominator of the reject rate. Uses
  // the SAME canonical fingerprint `collapseProposalsToClusters` groups on, so
  // the cluster's fingerprint keys straight into this map.
  const totalByFingerprint = new Map<string, number>();
  for (const r of rows) {
    const fp = computeProposalFingerprint(r);
    totalByFingerprint.set(fp, (totalByFingerprint.get(fp) ?? 0) + 1);
  }

  // Cluster the REJECTED rows by shape (count + sampleProposalIds per cluster).
  const rejectedRows: ClusterInputRow[] = rows
    .filter((r) => r.status === ProposalStatus.REJECTED)
    .map((r) => ({
      id: r.id,
      proposalType: r.proposalType,
      targetType: r.targetType,
      targetId: r.targetId,
      data: r.data,
      createdAt: r.createdAt,
      workspaceId: r.workspaceId,
    }));
  if (rejectedRows.length === 0) return [];

  const clusters = collapseProposalsToClusters(rejectedRows);
  const filed: string[] = [];

  for (const cluster of clusters) {
    if (cluster.count < MIN_CLUSTER_SIZE) continue;
    const totalForShape =
      totalByFingerprint.get(cluster.fingerprint) ?? cluster.count;
    const rejectRate = Number((cluster.count / totalForShape).toFixed(4));
    if (rejectRate < MIN_REJECT_RATE) continue;

    // Motif action pattern — the SAME `${targetType}.${proposalType}` shape the
    // widen scanner's computeDominantMotif emits, so the two lanes speak one
    // vocabulary and hasCoveringProposeRule can glob-match it.
    const targetPattern = `${cluster.targetType}.${cluster.proposalType}`;

    if (await hasPendingTightenProposal(agent.id, targetPattern)) continue;
    if (await hasCoveringProposeRule(agent.id, targetPattern)) continue;

    const data: GovernanceTightenLaneProposalData = {
      agentUserId: agent.id,
      targetKind: "action",
      targetPattern,
      scopeKind: "pod",
      verdict: "propose",
      evidence: {
        clusterSize: cluster.count,
        rejectRate,
        totalForShape,
        sampleProposalIds: cluster.sampleProposalIds,
      },
    };

    const { proposal } = await insertPendingProposal({
      workspaceId: null,
      targetType: "governance",
      targetId: agent.id,
      proposalType: "governance.tighten_lane",
      data: data as unknown as Record<string, unknown>,
      createdBy: agent.createdByUserId,
      proposedByUserId: null,
    });

    void emitSideEffects({
      subjectType: "proposal",
      action: "created",
      subjectId: proposal.id,
      userId: agent.createdByUserId,
      data: {
        proposalStatus: "created",
        targetType: "governance",
        changeType: "governance.tighten_lane",
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
        clusterSize: cluster.count,
      },
      "recommend-tighten: filed tighten_lane proposal"
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
  const proposalIds: string[] = [];
  let failed = 0;

  for (const agent of agents) {
    try {
      const filed = await recommendTightenForAgent(agent);
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
    { agents: agents.length, failed, proposalsFiled: proposalIds.length },
    "recommend-tighten: scan complete"
  );
  return { proposalsFiled: proposalIds.length, proposalIds };
}
