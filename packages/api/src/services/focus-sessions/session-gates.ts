/**
 * GATE STATE for one session — every gated stage of the session's process and
 * where it stands, plus the one fact a deploying agent needs: which commit a
 * PERSON approved to ship.
 *
 * ── Definition source ──────────────────────────────────────────────────────
 * The stages come from `loadSessionProcess` (the run's frozen
 * `definitionSnapshot` first, the playbook row second) and each gate is read by
 * `resolveStageGate` — the same two doors the stage-gate pause and the agent
 * gate floor use, so this list and the gates that actually hold cannot differ.
 *
 * ── State comes from PROPOSAL ROWS, never from session metadata ────────────
 * Session metadata stamps (`devLoop`, `checkGate`, …) were writable by the
 * agent being gated until the stage-gate-bypass fix, so they are evidence of
 * nothing. A gate's state is the LATEST proposal of its type filed against
 * this session (`targetType: focus_session`, `targetId`: the session — what
 * `openStageGate` and `createDevApprovalProposal` write); a human gate also
 * matches its `data.stageKey`. `decidedByHuman` is the REVIEWER row's
 * `userType`, never the proposal's own payload.
 *
 * Known limit: `reviewedBy` records the human principal of the key that
 * approved. An agent key holding full access (`*`) approves AS its owner, so a
 * row it approved reads `decidedByHuman: true`. Agent keys without `*` cannot
 * approve at all (`assertMayDecideProposal`).
 */

import {
  db,
  proposals,
  users,
  and,
  eq,
  desc,
  inArray,
  drizzleSql,
  ProposalStatus,
} from "@synap/database";
import {
  AWAITED_GATE_PROPOSAL_TYPES,
  STAGE_GATE_PROPOSAL_TYPES,
  resolveStageGate,
  stageGateProposalType,
} from "@synap/playbooks";
import { loadSessionProcess } from "@synap/jobs/utils/session-process.js";
import { DEV_DEPLOY_APPROVAL_TYPE } from "../proposals/dev-approval.js";

/** Rows read per session. A session files a handful; the cap only bounds a runaway. */
const GATE_ROWS_CAP = 200;

const GATE_PROPOSAL_TYPES: readonly string[] = [
  ...STAGE_GATE_PROPOSAL_TYPES,
  ...AWAITED_GATE_PROPOSAL_TYPES,
];

/**
 * - `not_reached` — no proposal for this gate exists yet.
 * - `pending` / `approved` / `rejected` — the latest proposal's decision
 *   (`auto_approved` counts as approved, never as decided by a human).
 * - `void` — the latest proposal holds no decision: withdrawn, expired,
 *   reverted, or its approval failed to apply.
 * - `by_criteria` — a CHECK gate: it files no proposal; whether it passes is
 *   the stage's criteria (the packet's `evaluation` section).
 */
export type PacketGateState =
  "not_reached" | "pending" | "approved" | "rejected" | "void" | "by_criteria";

export interface PacketGateItem {
  stageKey: string;
  stageName: string;
  kind: "human" | "check" | "awaits";
  /** The proposal type that decides this gate; `null` for a check gate. */
  proposalType: string | null;
  state: PacketGateState;
  /** The latest proposal for this gate, when one exists. */
  proposalId?: string;
  /** A PERSON approved or rejected it (reviewer row is `userType: human`). */
  decidedByHuman: boolean;
  /** When it was approved or rejected. */
  decidedAt?: string;
  /** A deploy gate's commit (≥ 7 hex chars, may be abbreviated). */
  commitSha?: string;
}

/** The newest `dev.deploy_approval` a PERSON approved for this session. */
export interface PacketDeployApproval {
  proposalId: string;
  /** As filed: ≥ 7 hex chars, may be abbreviated — compare by prefix, case-insensitively. */
  commitSha: string;
  branch: string | null;
  repo: string | null;
  targetHost: string | null;
  approvedAt: string | null;
}

export type PacketGatesSection =
  | {
      status: "ok";
      /** In the process's stage order. Not capped: one entry per gated stage. */
      items: PacketGateItem[];
      deploy: PacketDeployApproval | null;
    }
  | { status: "unavailable"; reason: string };

/** One proposal row, projected — only what the derivation reads. */
export interface GateProposalRow {
  id: string;
  proposalType: string;
  status: string;
  stageKey: string | null;
  commitSha: string | null;
  branch: string | null;
  repo: string | null;
  targetHost: string | null;
  reviewerType: string | null;
  reviewedAt: Date | null;
  updatedAt: Date | null;
}

const iso = (d: Date | string | null | undefined): string | undefined =>
  d ? new Date(d).toISOString() : undefined;

function stateOf(status: string): PacketGateState {
  switch (status) {
    case ProposalStatus.PENDING:
      return "pending";
    case ProposalStatus.APPROVED:
    case ProposalStatus.AUTO_APPROVED:
      return "approved";
    case ProposalStatus.REJECTED:
      return "rejected";
    default:
      return "void";
  }
}

/** A person decided it: approved or rejected (not auto), by a `human` reviewer. */
function humanDecided(row: GateProposalRow): boolean {
  return (
    (row.status === ProposalStatus.APPROVED ||
      row.status === ProposalStatus.REJECTED) &&
    row.reviewerType === "human"
  );
}

/**
 * Pure: the gate list over a stage list and this session's gate proposals,
 * NEWEST FIRST. Exported so the precedence is testable without a database.
 */
export function deriveSessionGates(
  stages: readonly unknown[],
  rowsNewestFirst: readonly GateProposalRow[]
): { items: PacketGateItem[]; deploy: PacketDeployApproval | null } {
  const items: PacketGateItem[] = [];
  for (const stage of stages) {
    const gate = resolveStageGate(stage);
    if (!gate) continue;
    const s = stage as { key?: unknown; name?: unknown };
    if (typeof s.key !== "string" || !s.key) continue;
    const stageKey = s.key;
    const stageName = typeof s.name === "string" && s.name ? s.name : stageKey;
    if (gate.kind === "check") {
      items.push({
        stageKey,
        stageName,
        kind: "check",
        proposalType: null,
        state: "by_criteria",
        decidedByHuman: false,
      });
      continue;
    }
    const proposalType = stageGateProposalType(gate);
    const latest = rowsNewestFirst.find(
      (r) =>
        r.proposalType === proposalType &&
        (gate.kind === "awaits" || r.stageKey === stageKey)
    );
    if (!latest) {
      items.push({
        stageKey,
        stageName,
        kind: gate.kind === "awaits" ? "awaits" : "human",
        proposalType,
        state: "not_reached",
        decidedByHuman: false,
      });
      continue;
    }
    const kind = gate.kind === "awaits" ? "awaits" : "human";
    const state = stateOf(latest.status);
    const decidedAt =
      state === "approved" || state === "rejected"
        ? iso(latest.reviewedAt ?? latest.updatedAt)
        : undefined;
    items.push({
      stageKey,
      stageName,
      kind,
      proposalType,
      state,
      proposalId: latest.id,
      decidedByHuman: humanDecided(latest),
      ...(decidedAt ? { decidedAt } : {}),
      ...(latest.commitSha ? { commitSha: latest.commitSha } : {}),
    });
  }

  const shipped = rowsNewestFirst.find(
    (r) =>
      r.proposalType === DEV_DEPLOY_APPROVAL_TYPE &&
      r.status === ProposalStatus.APPROVED &&
      r.reviewerType === "human" &&
      !!r.commitSha
  );
  const deploy: PacketDeployApproval | null = shipped
    ? {
        proposalId: shipped.id,
        commitSha: shipped.commitSha!,
        branch: shipped.branch,
        repo: shipped.repo,
        targetHost: shipped.targetHost,
        approvedAt: iso(shipped.reviewedAt ?? shipped.updatedAt) ?? null,
      }
    : null;
  return { items, deploy };
}

/** This session's gate proposals, newest first, with each reviewer's kind. */
async function readGateProposals(
  database: typeof db,
  sessionId: string
): Promise<GateProposalRow[]> {
  const rows = await database
    .select({
      id: proposals.id,
      proposalType: proposals.proposalType,
      status: proposals.status,
      stageKey: drizzleSql<string | null>`${proposals.data} ->> 'stageKey'`,
      commitSha: drizzleSql<string | null>`${proposals.data} ->> 'commitSha'`,
      branch: drizzleSql<string | null>`${proposals.data} ->> 'branch'`,
      repo: drizzleSql<string | null>`${proposals.data} ->> 'repo'`,
      targetHost: drizzleSql<string | null>`${proposals.data} ->> 'targetHost'`,
      reviewerType: users.userType,
      reviewedAt: proposals.reviewedAt,
      updatedAt: proposals.updatedAt,
    })
    .from(proposals)
    .leftJoin(users, eq(users.id, proposals.reviewedBy))
    .where(
      and(
        eq(proposals.targetType, "focus_session"),
        eq(proposals.targetId, sessionId),
        inArray(proposals.proposalType, [...GATE_PROPOSAL_TYPES])
      )
    )
    .orderBy(desc(proposals.createdAt))
    .limit(GATE_ROWS_CAP);
  return rows as GateProposalRow[];
}

/** The gates section. Throws on a failed read; the packet makes it `unavailable`. */
export async function readSessionGates(
  database: typeof db,
  row: { id: string; playbookId: string | null }
): Promise<{ items: PacketGateItem[]; deploy: PacketDeployApproval | null }> {
  const [sessionProcess, rows] = await Promise.all([
    loadSessionProcess({ sessionId: row.id, playbookId: row.playbookId }),
    readGateProposals(database, row.id),
  ]);
  return deriveSessionGates(sessionProcess?.stages ?? [], rows);
}
