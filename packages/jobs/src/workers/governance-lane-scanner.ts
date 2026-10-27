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
 * Qualification (mirrors docs/decisions/agent-governance.md, trusted lane):
 *   total >= 100 && approveRate > 0.95 && duplicateRate < 0.15
 *   (approveRate counts only FULL approvals — see `computeQualification`)
 *   AND no already-PENDING widen proposal for the agent
 *   AND no ACTIVE governance_rules row already covering the dominant motif
 *
 * PER-MOTIF qualification (founder D8, pod-side plan §5.3 F5) — an agent that
 * fails the agent-wide gate (claude-code: 20% duplicates across everything it
 * does) may still have ONE motif it always gets right. Each motif
 * (`${targetType}.${proposalType}`) is scored on its own, over the agent's last
 * {@link SCAN_LIMIT} REVIEWED proposals (receipts excluded — see
 * `loadAgentReviewedProposals`):
 *   decisions >= 30 && approveRate > 0.95 && duplicateRate < 0.15
 *   AND the motif names a gate door a rule can widen (`motifWidenRefusal`:
 *       not a floored key, not a door outside the gate)
 *   AND no PENDING, APPROVED or REJECTED widen already filed for (agent, motif)
 *   AND no ACTIVE governance_rules row already covering the motif
 * and files a widen for THAT motif only: one exact `action` rule, agent ×
 * pod × `${targetType}.${proposalType}` — the narrowest existing granularity
 * that expresses (proposalType × targetType). Still only a PENDING proposal.
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
  ne,
  proposals,
  users,
  governanceRules,
  insertPendingProposal,
  ProposalStatus,
} from "@synap/database";
import { isPartiallyApprovedData } from "@synap-core/types/proposals";
import {
  GATE_WRITE_DOORS,
  nonWidenableFloorFor,
} from "@synap/governance-policy";
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
  // Deliberately NOT `connection`: a widen_lane rule is agent-principal, and a
  // connection rule is principal `any` (sync writes run as the connection owner).
  targetKind: "action" | "profile" | "capability";
  targetPattern: string;
  targetProfile?: string | null;
  scopeKind: "workspace" | "pod";
  workspaceId?: string | null;
  verdict: "auto";
  evidence: {
    /** Agent-wide: rows in the window. Per-motif: the motif's human decisions. */
    total: number;
    approveRate: number;
    duplicateRate: number;
    /**
     * Which gate qualified it: the whole agent (absent on rows filed before
     * F5) or this one motif alone (`motif` names it).
     */
    basis?: "agent" | "motif";
    motif?: { targetType: string; proposalType: string };
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

/** Per-motif gate (F5): same rates as the agent gate, a smaller volume floor. */
const MOTIF_MIN_DECISIONS = 30;
const MOTIF_MIN_APPROVE_RATE = 0.95;
const MOTIF_MAX_DUPLICATE_RATE = 0.15;

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

export interface FingerprintInput {
  proposalType: string;
  targetType: string;
  targetId: string;
  data: unknown;
}

export function computeFingerprint(p: FingerprintInput): string {
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
  return `${p.proposalType}\0${p.targetType}\0${signature}`;
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

/**
 * Same approve-rate + duplicate-rate math as computeAgentScorecard's rates.
 *
 * PARTIAL APPLIES DO NOT COUNT AS APPROVALS. A reviewer can deny individual
 * items inside a composite proposal (per-item dispositions) and approve the
 * rest; the row still stores plain `"approved"` — there is no separate status
 * value — so `status` alone cannot tell "kept 1 of 30" from "kept 30 of 30".
 * `isPartiallyApprovedData` reads the persisted `data.dispositions` map (the
 * SAME door `computeAgentScorecard` uses) to tell them apart.
 *
 * DELIBERATE SEMANTIC CHOICE — a partial apply stays in the DENOMINATOR and is
 * counted as NOT approved, rather than being dropped from the sample the way
 * `withdrawn` is ("not scored — the agent recalled it", `AgentStanding`).
 * The two are different in kind and this gate is why:
 *   - `withdrawn` carries NO human judgment — the agent pulled it back. There
 *     is nothing to score, so it is excluded everywhere.
 *   - a gutted package IS a human judgment, and a negative one: the reviewer
 *     read the work and threw part of it away.
 * This function is not a display; it is the gate that GRANTS AUTONOMY (a wider
 * auto-approve lane). Excluding partials from the denominator would let an
 * agent whose packages are routinely gutted raise its own approve rate by
 * getting gutted more often — the signal would push the gate in the direction
 * opposite to its meaning. Keeping them in the denominator is strictly
 * conservative: it can only ever lower the rate, never raise it.
 * (The pod-wide display grid, `AgentStanding`, mirrors `withdrawn` instead and
 * shows partials as their own column — a card that informs a human may bucket
 * a non-endorsement out; a gate that hands out trust may not.)
 */
export function computeQualification(
  rows: LaneScanProposalRow[]
): AgentQualification {
  const total = rows.length;
  if (total === 0) return { total: 0, approveRate: 0, duplicateRate: 0 };

  const approved = rows.filter(isFullApproval).length;

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

/**
 * A proposal the reviewer approved WHOLE. The ONE definition of "approved" this
 * scanner uses — both the rate and the dominant motif go through it, so they
 * can never disagree about what an endorsement is.
 */
function isFullApproval(r: LaneScanProposalRow): boolean {
  const approvedStatus =
    r.status === ProposalStatus.APPROVED ||
    r.status === ProposalStatus.AUTO_APPROVED;
  return approvedStatus && !isPartiallyApprovedData(r.data);
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
 * The action pattern a proposal row's motif widens: `${targetType}.${proposalType}`.
 *
 * Receipts store a DOTTED proposalType (`entity.create`) while reviewed rows
 * carry the bare verb (`create`). Prefixing the dotted form minted
 * `entity.entity.create` rules that no write ever matches.
 */
export function motifPatternOf(r: {
  targetType: string;
  proposalType: string;
}): string {
  return r.proposalType.startsWith(`${r.targetType}.`)
    ? r.proposalType
    : `${r.targetType}.${r.proposalType}`;
}

/**
 * A HUMAN VERDICT on the row — the per-motif gate's denominator.
 *
 * `auto_approved` receipts are NOT decisions: nobody reviewed them, and a motif
 * that already lands as receipts needs no wider lane (counting them would let
 * every auto-applied motif file a widen the person must read for nothing).
 * `reverted` IS one: a person undid the write. Pending / withdrawn / expired /
 * approval_failed carry no verdict (same exclusion as `recommend-tighten`).
 */
const HUMAN_DECISION_STATUSES: ReadonlySet<string> = new Set<string>([
  ProposalStatus.APPROVED,
  ProposalStatus.REJECTED,
  ProposalStatus.REVERTED,
]);

export interface MotifQualification {
  targetType: string;
  proposalType: string;
  /** `${targetType}.${proposalType}` — the exact action key the rule names. */
  targetPattern: string;
  /** Human verdicts on this motif in the window (approved/rejected/reverted). */
  decisions: number;
  /** FULL approvals / decisions — a gutted composite or a revert is a "no". */
  approveRate: number;
  /** Share of this motif's rows (any status) in a same-fingerprint cluster. */
  duplicateRate: number;
}

/**
 * Score every motif in `rows` on its own. Duplicates are measured over ALL of
 * the motif's rows (a pending re-file is a duplicate the agent made, judged or
 * not); approvals over its human decisions only, through {@link isFullApproval}
 * — the ONE definition of approved this scanner uses.
 */
export function computeMotifQualifications(
  rows: LaneScanProposalRow[]
): MotifQualification[] {
  const byMotif = new Map<string, LaneScanProposalRow[]>();
  for (const r of rows) {
    const key = motifPatternOf(r);
    const group = byMotif.get(key);
    if (group) group.push(r);
    else byMotif.set(key, [r]);
  }

  const out: MotifQualification[] = [];
  for (const [targetPattern, group] of byMotif) {
    const decided = group.filter((r) => HUMAN_DECISION_STATUSES.has(r.status));
    const approved = decided.filter(isFullApproval).length;
    const duplicateRate = computeQualification(group).duplicateRate;
    const first = group[0]!;
    out.push({
      targetType: first.targetType,
      proposalType: targetPattern.slice(first.targetType.length + 1),
      targetPattern,
      decisions: decided.length,
      approveRate:
        decided.length > 0 ? Number((approved / decided.length).toFixed(4)) : 0,
      duplicateRate,
    });
  }
  return out;
}

/** Pure per-motif predicate — the F5 gate. */
export function qualifiesMotifForWidenLane(m: MotifQualification): boolean {
  return (
    m.decisions >= MOTIF_MIN_DECISIONS &&
    m.approveRate > MOTIF_MIN_APPROVE_RATE &&
    m.duplicateRate < MOTIF_MAX_DUPLICATE_RATE
  );
}

/**
 * Why a rule for this motif could never widen it — `null` when it can.
 *
 * - `NOT_A_GATE_DOOR`: the key is no door of the `checkPermissionOrPropose`
 *   gate (`GATE_WRITE_DOORS`, creator `gate` / `gate+automation`), the only
 *   writes rung 2.8 resolves an action rule for. A `direct` door or a key no
 *   door emits would store a rule that never fires.
 * - a floor's reason code (`DESTRUCTIVE_HARD_FLOOR`, `ADMIN_ACTION`, …): the
 *   engine itself, asked with a rung-2.8 `auto` verdict, still proposes
 *   (`nonWidenableFloorFor`) — the floors sit above the rule store. The
 *   approval branch refuses these too; this keeps them from being filed.
 */
export function motifWidenRefusal(targetPattern: string): string | null {
  const dot = targetPattern.lastIndexOf(".");
  if (dot <= 0) return "NOT_A_GATE_DOOR";
  const door = `${targetPattern.slice(0, dot)}/${targetPattern.slice(dot + 1)}`;
  const creator = (GATE_WRITE_DOORS as Record<string, string>)[door];
  if (creator !== "gate" && creator !== "gate+automation") {
    return "NOT_A_GATE_DOOR";
  }
  return nonWidenableFloorFor(targetPattern);
}

/**
 * Dominant write-motif: the `${targetType}.${proposalType}` action pattern
 * this agent's APPROVED proposals hit most. Returns undefined when the agent
 * has no approved rows (nothing to widen).
 */
export function computeDominantMotif(
  rows: LaneScanProposalRow[]
): { targetType: string; targetPattern: string } | undefined {
  // Same floor as the rate: a gutted package does not endorse its motif, so it
  // must not be the evidence for widening that motif's lane.
  const approvedRows = rows.filter(isFullApproval);
  if (approvedRows.length === 0) return undefined;

  const counts = new Map<string, { targetType: string; count: number }>();
  for (const r of approvedRows) {
    const key = motifPatternOf(r);
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

/**
 * The per-motif window: the agent's last {@link SCAN_LIMIT} proposals that went
 * to REVIEW — every status but `auto_approved`. A busy agent's last 500 rows are
 * mostly receipts (claude-code, 2026-10-27: 500 rows, 32 pending), so a motif's
 * human decisions would rarely reach the floor inside the agent-wide window.
 * A reverted receipt is kept: its status is `reverted`, a person's "no".
 */
async function loadAgentReviewedProposals(
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
    .where(
      and(
        eq(proposals.agentUserId, agentId),
        ne(proposals.status, ProposalStatus.AUTO_APPROVED)
      )
    )
    .orderBy(desc(proposals.createdAt))
    .limit(SCAN_LIMIT);
}

/**
 * Motifs already put to the person for this agent: a widen that is PENDING
 * (awaiting them), APPROVED (granted — if its rule was since revoked, that
 * revocation is their answer) or REJECTED (a "no", not an invitation to ask
 * daily). Keyed per (agent, targetPattern), like `recommend-tighten`'s
 * `hasPendingFinding`. Withdrawn / expired widens never block a refile.
 */
async function loadDecidedOrPendingWidenPatterns(
  agentId: string
): Promise<Set<string>> {
  const rows = await db
    .select({ data: proposals.data, status: proposals.status })
    .from(proposals)
    .where(eq(proposals.proposalType, "governance.widen_lane"));
  const blocking: ReadonlySet<string> = new Set<string>([
    ProposalStatus.PENDING,
    ProposalStatus.APPROVED,
    ProposalStatus.REJECTED,
  ]);
  const patterns = new Set<string>();
  for (const r of rows) {
    if (!blocking.has(r.status)) continue;
    const data = r.data as Partial<GovernanceWidenLaneProposalData> | null;
    if (data?.agentUserId === agentId && data.targetPattern) {
      patterns.add(data.targetPattern);
    }
  }
  return patterns;
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

/**
 * Any ACTIVE governance_rules row already covering this agent + motif.
 *
 * Considers BOTH `target_kind: "action"` rows (the scanner's own writes,
 * matched by exact/glob/"*" pattern as before) AND `target_kind: "capability"`
 * rows (Option B / D1, docs/decisions/agent-governance.md, phase 2 D1) — the dominant motif for
 * an agent whose approved proposals are mostly `capability.run`
 * (`CAPABILITY_RUN_PROPOSAL` in `@synap/capability-gate`) resolves to the
 * generic action pattern `"capability.run"`; if this agent already holds ANY
 * active per-capability rule, that agent's capability runs are already
 * governed at the (more specific) capability level, so proposing a blanket
 * `capability.run` action-widen on top would be redundant. Not a byte-exact
 * "same target" check (a capability rule's `target_pattern` is a capability
 * id, not an action string) — a coarser "already governed at capability
 * granularity" signal, deliberately conservative (skip the widen rather than
 * risk a duplicate/conflicting proposal).
 */
async function hasCoveringRule(
  agentId: string,
  targetPattern: string
): Promise<boolean> {
  const wildcardPattern = `${targetPattern.split(".")[0]}.*`;
  // Filtered in JS (not a SQL `IN`) — small per-agent row set, and avoids a
  // postgres.js array-binding edge case for a 3-way OR on targetPattern.
  const active = await db
    .select({
      targetKind: governanceRules.targetKind,
      targetPattern: governanceRules.targetPattern,
    })
    .from(governanceRules)
    .where(
      and(
        eq(governanceRules.principalKind, "agent"),
        eq(governanceRules.agentUserId, agentId),
        isNull(governanceRules.revokedAt)
      )
    );
  return active.some((r) => {
    if (r.targetKind === "action") {
      return (
        r.targetPattern === targetPattern ||
        r.targetPattern === wildcardPattern ||
        r.targetPattern === "*"
      );
    }
    if (r.targetKind === "capability") {
      return targetPattern.split(".")[0] === "capability";
    }
    return false;
  });
}

async function scanAgent(agent: AgentRow): Promise<void> {
  if (!agent.createdByUserId) return;
  await scanAgentWide(agent, agent.createdByUserId);
  await scanAgentMotifs(agent, agent.createdByUserId);
}

/** The agent-wide gate — unchanged by F5. */
async function scanAgentWide(agent: AgentRow, ownerId: string): Promise<void> {
  const rows = await loadAgentProposals(agent.id);
  const qualification = computeQualification(rows);
  if (!qualifiesForWidenLane(qualification)) return;

  const motif = computeDominantMotif(rows);
  if (!motif) return;

  if (await hasPendingWidenProposal(agent.id)) return;
  if (await hasCoveringRule(agent.id, motif.targetPattern)) return;

  await fileWidenProposal(agent, ownerId, {
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
  });
}

/**
 * F5 — every motif that earns a lane on its own gets its own widen. Runs after
 * the agent-wide pass, so a motif that pass just filed is already in the
 * blocking set read here.
 */
async function scanAgentMotifs(
  agent: AgentRow,
  ownerId: string
): Promise<void> {
  const rows = await loadAgentReviewedProposals(agent.id);
  const qualified = computeMotifQualifications(rows).filter(
    (m) =>
      qualifiesMotifForWidenLane(m) &&
      motifWidenRefusal(m.targetPattern) === null
  );
  if (qualified.length === 0) return;

  const alreadyAsked = await loadDecidedOrPendingWidenPatterns(agent.id);
  for (const m of qualified) {
    if (alreadyAsked.has(m.targetPattern)) continue;
    if (await hasCoveringRule(agent.id, m.targetPattern)) continue;
    await fileWidenProposal(
      agent,
      ownerId,
      buildMotifWidenProposalData(agent.id, m)
    );
  }
}

/** The widen a qualified motif files: one exact action rule, agent × pod. */
export function buildMotifWidenProposalData(
  agentUserId: string,
  m: MotifQualification
): GovernanceWidenLaneProposalData {
  return {
    agentUserId,
    targetKind: "action",
    targetPattern: m.targetPattern,
    scopeKind: "pod",
    verdict: "auto",
    evidence: {
      total: m.decisions,
      approveRate: m.approveRate,
      duplicateRate: m.duplicateRate,
      basis: "motif",
      motif: { targetType: m.targetType, proposalType: m.proposalType },
    },
  };
}

async function fileWidenProposal(
  agent: AgentRow,
  ownerId: string,
  data: GovernanceWidenLaneProposalData
): Promise<void> {
  const { proposal } = await insertPendingProposal({
    workspaceId: null,
    targetType: "governance",
    targetId: agent.id,
    proposalType: "governance.widen_lane",
    data: data as unknown as Record<string, unknown>,
    createdBy: ownerId,
    proposedByUserId: null,
    // OWNER FLOOR (0248): the human who owns this agent decides its lane.
    subjectUserId: ownerId,
  });

  void emitSideEffects({
    subjectType: "proposal",
    action: "created",
    subjectId: proposal.id,
    userId: ownerId,
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
    { agentId: agent.id, motif: data.targetPattern, evidence: data.evidence },
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
