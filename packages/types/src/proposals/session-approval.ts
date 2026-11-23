/**
 * The order a session's proposals are approved in when the person approves the
 * whole session at once (`proposals.approveSession`): what a later item needs
 * first — a space before the kinds in it, a kind before its lifecycle and its
 * fields, a playbook before the automation that runs it, the fact and the
 * behaviour before the rule that joins them. A composite (a plan) takes the
 * rank of its earliest step; its own steps are ordered by the materializer.
 * Within a rank, the order the proposals were filed in.
 *
 * Pure.
 */

import { resolveProposalAction } from "./action.js";
import { isCompositeProposalData, type StoredProposalData } from "./index.js";

/** What the approval makes, by `<targetType>.<verb>` / composite op, earliest first. */
const RANK: Readonly<Record<string, number>> = {
  "workspace.create": 0,
  create_workspace: 0,
  "profile.create": 1,
  define_kind: 1,
  "profile.declare_lifecycle": 2,
  declare_lifecycle: 2,
  "property_def.create": 3,
  "playbook.create": 4,
  create_playbook: 4,
  "skill.create": 5,
  create_skill: 5,
  "automation.create": 6,
  create_automation: 6,
  "rule.create": 7,
  create_rule: 7,
};
const LAST = 8;

export interface SessionApprovalRow {
  id: string;
  proposalType?: string | null;
  targetType?: string | null;
  data?: unknown;
  createdAt?: Date | string | null;
}

/** The rank of one proposal: what it makes first. */
export function sessionApprovalRank(row: SessionApprovalRow): number {
  const data = row.data as StoredProposalData | null | undefined;
  if (isCompositeProposalData(data)) {
    return Math.min(LAST, ...data.operations.map((op) => RANK[op.op] ?? LAST));
  }
  const key = `${row.targetType ?? ""}.${resolveProposalAction(row)}`;
  return RANK[key] ?? LAST;
}

/** The rows in approval order (a copy; the input is untouched). */
export function sessionApprovalOrder<R extends SessionApprovalRow>(
  rows: readonly R[]
): R[] {
  const filedAt = (r: R) =>
    r.createdAt ? new Date(r.createdAt).getTime() : Number.MAX_SAFE_INTEGER;
  return rows
    .map((row, index) => ({ row, index, rank: sessionApprovalRank(row) }))
    .sort(
      (a, b) =>
        a.rank - b.rank || filedAt(a.row) - filedAt(b.row) || a.index - b.index
    )
    .map((x) => x.row);
}
