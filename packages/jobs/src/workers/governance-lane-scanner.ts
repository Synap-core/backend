/**
 * Governance Lane Scanner — Phase D "trusted lane" (Governance Convergence Plan).
 *
 * Daily scan: for every agent-user, build the SAME behavioural scorecard
 * `diagnose({ type: "agent" })` exposes (`packages/api/src/services/diagnose/
 * agent-scorecard.ts`) — approve rate, duplicate rate (structural-fingerprint
 * clusters), volume — and PROPOSE widening that agent's auto-approve lane when
 * it has earned trust. NEVER silent: this only files a PENDING
 * `governance.widen_lane` proposal. The ONE place a `governance_rules` row is
 * ever inserted is the approval branch in `applyProposalApproval`
 * (`packages/api/src/routers/proposals.ts`) — this scanner never writes
 * `governance_rules` directly.
 *
 * Qualification (mirrors GOVERNANCE-CONVERGENCE-PLAN.md §Phase D):
 *   total >= 100 && approveRate > 0.95 && duplicateRate < 0.15
 *   AND no already-PENDING widen proposal for the agent
 *   AND no ACTIVE governance_rules row already covering the dominant motif
 *
 * `@synap/jobs` cannot import from `@synap/api` (api depends on jobs, not the
 * reverse — root CLAUDE.md dependency direction; see
 * `resolve-agent-governance-decision.ts`'s header for the same constraint), so
 * the duplicate-cluster math below is a deliberate, minimal MIRROR of
 * `packages/api/src/services/proposals/fingerprint.ts`'s
 * `computeProposalFingerprint` — same proposalType x targetType x
 * normalized-signature algorithm, same create-vs-mutate branch. Keep the two
 * in sync (same pattern as `facetVisibilityConditions()` /
 * `getEffectiveFacets()` staying in sync across the access-layer boundary).
 *
 * Queue: governance.lane-scan
 * Cron:  daily 30 3 * * * (after pod-hygiene near-dup at 3:15, before
 *        librarian-archiver at 3:45)
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

const logger = createLogger({ module: "governance-lane-scanner" });

/**
 * `governance.widen_lane` proposal payload — mirrors the type of the same
 * name in `packages/api/src/routers/proposals.ts` (the approval-branch
 * consumer). Kept as a separate local declaration rather than a cross-package
 * import: `@synap/jobs` cannot depend on `@synap/api` (see file header).
 */
export interface GovernanceWidenLaneProposalData {
  agentUserId: string;
  targetKind: "action" | "profile" | "capability";
  targetPattern: string;
  targetProfile?: string | null;
  scopeKind: "workspace" | "pod";
  workspaceId?: string | null;
  verdict: "auto";
  evidence: {
    total: number;
    approveRate: number;
    duplicateRate: number;
  };
}

export const GOVERNANCE_LANE_SCANNER_QUEUE = "governance.lane-scan";

/** After pod-hygiene near-dup (3:15), before librarian-archiver (3:45). */
export const GOVERNANCE_LANE_SCANNER_CRON = "30 3 * * *";

/** Mirrors SCORECARD_SCAN_LIMIT in agent-scorecard.ts. */
const SCAN_LIMIT = 500;

const MIN_TOTAL = 100;
const MIN_APPROVE_RATE = 0.95;
const MAX_DUPLICATE_RATE = 0.15;

// ── Pure fingerprint mirror (see file header) ───────────────────────────────
// Deliberately duplicated from fingerprint.ts's computeProposalFingerprint —
// jobs cannot import @synap/api. Keep in sync if that file's algorithm changes.

type ChangeClass = "create" | "delete" | "mutate";

function classifyChange(proposalType: string): ChangeClass {
  const t = proposalType.toLowerCase();
  if (t === "delete" || t.startsWith("delete") || t.endsWith(".delete")) {
    return "delete";
  }
  if (
    t === "create" ||
    t === "create_composite" ||
    t === "import.graph" ||
    t.startsWith("create") ||
    t.endsWith(".create")
  ) {
    return "create";
  }
  return "mutate";
}

function normalizeSignatureToken(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function extractPayload(data: unknown): Record<string, unknown> | undefined {
  if (!data || typeof data !== "object") return undefined;
  const raw = data as Record<string, unknown>;
  const nested = raw.data;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    return nested as Record<string, unknown>;
  }
  return raw;
}

function stringField(
  record: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const v = record?.[key];
  return typeof v === "string" && v.trim() ? v : undefined;
}

function extractProposalName(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const envelope = data as Record<string, unknown>;
  const payload = extractPayload(data);
  return (
    stringField(envelope, "targetName") ??
    stringField(payload, "title") ??
    stringField(payload, "name") ??
    stringField(payload, "displayName") ??
    stringField(payload, "label")
  );
}

interface FingerprintInput {
  proposalType: string;
  targetType: string;
  targetId: string;
  data: unknown;
}

function computeFingerprint(p: FingerprintInput): string {
  const cls = classifyChange(p.proposalType);
  let signature: string;
  if (cls === "create") {
    const name = extractProposalName(p.data);
    signature = name
      ? `name:${normalizeSignatureToken(name)}`
      : `id:${p.targetId}`;
  } else {
    const id = p.targetId?.trim();
    if (id) {
      signature = `id:${id}`;
    } else {
      const name = extractProposalName(p.data);
      signature = name ? `name:${normalizeSignatureToken(name)}` : "id:";
    }
  }
  return `${p.proposalType} ${p.targetType} ${signature}`;
}

// ── Pure qualification math (unit-testable, DB-free) ────────────────────────

export interface LaneScanProposalRow {
  proposalType: string;
  targetType: string;
  targetId: string;
  data: unknown;
  status: string;
  createdAt: Date;
}

export interface AgentQualification {
  total: number;
  approveRate: number;
  duplicateRate: number;
}

/** Same approve-rate + duplicate-rate math as computeAgentScorecard's rates. */
export function computeQualification(
  rows: LaneScanProposalRow[]
): AgentQualification {
  const total = rows.length;
  if (total === 0) return { total: 0, approveRate: 0, duplicateRate: 0 };

  const approved = rows.filter(
    (r) =>
      r.status === ProposalStatus.APPROVED ||
      r.status === ProposalStatus.AUTO_APPROVED
  ).length;

  const counts = new Map<string, number>();
  for (const r of rows) {
    const fp = computeFingerprint(r);
    counts.set(fp, (counts.get(fp) ?? 0) + 1);
  }
  let inDuplicateCluster = 0;
  for (const count of counts.values()) {
    if (count > 1) inDuplicateCluster += count;
  }

  const rate = (n: number) => Number((n / total).toFixed(4));
  return {
    total,
    approveRate: rate(approved),
    duplicateRate: rate(inDuplicateCluster),
  };
}

/** Pure qualification predicate — the ONE gate the scanner applies. */
export function qualifiesForWidenLane(q: AgentQualification): boolean {
  return (
    q.total >= MIN_TOTAL &&
    q.approveRate > MIN_APPROVE_RATE &&
    q.duplicateRate < MAX_DUPLICATE_RATE
  );
}

/**
 * Dominant write-motif: the `${targetType}.${proposalType}` action pattern
 * this agent's APPROVED proposals hit most. Returns undefined when the agent
 * has no approved rows (nothing to widen).
 */
export function computeDominantMotif(
  rows: LaneScanProposalRow[]
): { targetType: string; targetPattern: string } | undefined {
  const approvedRows = rows.filter(
    (r) =>
      r.status === ProposalStatus.APPROVED ||
      r.status === ProposalStatus.AUTO_APPROVED
  );
  if (approvedRows.length === 0) return undefined;

  const counts = new Map<string, { targetType: string; count: number }>();
  for (const r of approvedRows) {
    const key = `${r.targetType}.${r.proposalType}`;
    const entry = counts.get(key);
    if (entry) entry.count += 1;
    else counts.set(key, { targetType: r.targetType, count: 1 });
  }

  let best: { key: string; targetType: string; count: number } | undefined;
  for (const [key, entry] of counts.entries()) {
    if (!best || entry.count > best.count) {
      best = { key, targetType: entry.targetType, count: entry.count };
    }
  }
  if (!best) return undefined;
  return { targetType: best.targetType, targetPattern: best.key };
}

// ── DB tier ──────────────────────────────────────────────────────────────────

interface AgentRow {
  id: string;
  createdByUserId: string | null;
}

async function listAgentUsers(): Promise<AgentRow[]> {
  const rows = await db
    .select({ id: users.id, createdByUserId: users.createdByUserId })
    .from(users)
    .where(eq(users.userType, "agent"));
  return rows;
}

async function loadAgentProposals(
  agentId: string
): Promise<LaneScanProposalRow[]> {
  return db
    .select({
      proposalType: proposals.proposalType,
      targetType: proposals.targetType,
      targetId: proposals.targetId,
      data: proposals.data,
      status: proposals.status,
      createdAt: proposals.createdAt,
    })
    .from(proposals)
    .where(eq(proposals.agentUserId, agentId))
    .orderBy(desc(proposals.createdAt))
    .limit(SCAN_LIMIT);
}

/** Pending `governance.widen_lane` proposals — subject agent lives in `data`, not `proposals.agentUserId` (the scanner authors these, not the agent). */
async function hasPendingWidenProposal(agentId: string): Promise<boolean> {
  const rows = await db
    .select({ data: proposals.data })
    .from(proposals)
    .where(
      and(
        eq(proposals.proposalType, "governance.widen_lane"),
        eq(proposals.status, ProposalStatus.PENDING)
      )
    );
  return rows.some((r) => {
    const data = r.data as Partial<GovernanceWidenLaneProposalData> | null;
    return data?.agentUserId === agentId;
  });
}

/** Any ACTIVE governance_rules row already covering this agent + motif. */
async function hasCoveringRule(
  agentId: string,
  targetPattern: string
): Promise<boolean> {
  const wildcardPattern = `${targetPattern.split(".")[0]}.*`;
  // Filtered in JS (not a SQL `IN`) — small per-agent row set, and avoids a
  // postgres.js array-binding edge case for a 3-way OR on targetPattern.
  const active = await db
    .select({ targetPattern: governanceRules.targetPattern })
    .from(governanceRules)
    .where(
      and(
        eq(governanceRules.principalKind, "agent"),
        eq(governanceRules.agentUserId, agentId),
        eq(governanceRules.targetKind, "action"),
        isNull(governanceRules.revokedAt)
      )
    );
  return active.some(
    (r) =>
      r.targetPattern === targetPattern ||
      r.targetPattern === wildcardPattern ||
      r.targetPattern === "*"
  );
}

async function scanAgent(agent: AgentRow): Promise<void> {
  if (!agent.createdByUserId) return;

  const rows = await loadAgentProposals(agent.id);
  const qualification = computeQualification(rows);
  if (!qualifiesForWidenLane(qualification)) return;

  const motif = computeDominantMotif(rows);
  if (!motif) return;

  if (await hasPendingWidenProposal(agent.id)) return;
  if (await hasCoveringRule(agent.id, motif.targetPattern)) return;

  const data: GovernanceWidenLaneProposalData = {
    agentUserId: agent.id,
    targetKind: "action",
    targetPattern: motif.targetPattern,
    scopeKind: "pod",
    verdict: "auto",
    evidence: {
      total: qualification.total,
      approveRate: qualification.approveRate,
      duplicateRate: qualification.duplicateRate,
    },
  };

  const { proposal } = await insertPendingProposal({
    workspaceId: null,
    targetType: "governance",
    targetId: agent.id,
    proposalType: "governance.widen_lane",
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
      changeType: "governance.widen_lane",
    },
  }).catch((err) => {
    logger.warn(
      { err, proposalId: proposal.id, agentId: agent.id },
      "governance-lane-scanner: emitSideEffects failed (non-fatal)"
    );
  });

  logger.info(
    { agentId: agent.id, motif: motif.targetPattern, qualification },
    "governance-lane-scanner: filed widen_lane proposal"
  );
}

// ── Handler ──────────────────────────────────────────────────────────────────

/**
 * Cron / on-demand handler. Manual trigger:
 * `await boss.send("governance.lane-scan", {})`
 *
 * Resilient per-agent: one agent's failure never aborts the batch.
 */
export async function handleGovernanceLaneScan(): Promise<void> {
  logger.info("governance-lane-scanner: starting scan");

  const agents = await listAgentUsers();
  let failed = 0;

  for (const agent of agents) {
    try {
      await scanAgent(agent);
    } catch (err) {
      failed += 1;
      logger.error(
        { err, agentId: agent.id },
        "governance-lane-scanner: failed for agent, skipping"
      );
    }
  }

  logger.info(
    { agents: agents.length, failed },
    "governance-lane-scanner: scan complete"
  );
}
