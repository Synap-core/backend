/**
 * Historique's rows: one decided request, in the client's words (audit abbc7a19 PA-D-17).
 * Pure; `history-list.tsx` only draws it.
 *
 * - The title says what HAPPENED (the vocabulary's past mood: "Created
 *   contact Léa", never the imperative a pending request reads).
 * - Who asked (the actor's name, the ONE requester derivation) and who
 *   decided: the approver the pod names, or a standing rule for an
 *   auto-approved write.
 * - Undo is offered only where the pod says the effect can still be undone
 *   (`revertable`, computed by the same planner `proposals.revert` runs) and
 *   the viewer may decide it; an applied change that cannot be undone says
 *   so instead of offering nothing.
 * - Every row is a door: the decision's own page, with its receipt.
 */

import { describeHeldWritesProposal } from "@synap-core/types/proposals/deferred-writes";
import { describeDevDeployProposal } from "@synap-core/types/proposals/dev-deploy";
import { describeVerbRunProposal } from "@synap-core/types/proposals/capability-run";
import {
  buildObjectActionTitle,
  resolveObjectNoun,
  resolveStatusLabel,
} from "@synap-core/types/vocabulary";
import type { StatusKind } from "../../components/status-pill";
import { proposalHeading } from "../../../proposal/[id]/proposal-heading";
import {
  proposalRequesterParts,
  type ProposalRequesterFacts,
} from "../../../proposal/[id]/proposal-requester";

/** The `proposals.list` fields a row reads, structurally. */
export interface HistoryProposal extends ProposalRequesterFacts {
  id: string;
  status: string;
  proposalType?: string | null;
  targetType?: string | null;
  targetName?: string | null;
  data?: unknown;
  request?: { data?: unknown } | null;
  workspaceName?: string | null;
  approverName?: string | null;
  reviewedAt?: Date | string | null;
  updatedAt?: Date | string | null;
  revertable?: boolean;
  viewerCanReview?: boolean;
}

/** Status → pill colour only; the word comes from the vocabulary. */
const STATUS_TONE: Readonly<Record<string, StatusKind>> = {
  approved: "healthy",
  auto_approved: "healthy",
  rejected: "down",
  approval_failed: "stale",
};

const APPLIED = new Set(["approved", "auto_approved"]);

/**
 * `available`: Undo is offered. `permanent`: the change is applied and the
 * pod says it cannot be undone, so the row says so. `none`: nothing to undo
 * (rejected, withdrawn, failed, reverted).
 */
export type HistoryUndo = "available" | "permanent" | "none";

export type HistoryDecider =
  { kind: "person"; name: string } | { kind: "rule" } | null;

export interface HistoryRow {
  id: string;
  title: string;
  status: string;
  statusLabel: string;
  tone: StatusKind;
  /** The object's kind, as a noun ("Contact"). */
  kindLabel: string;
  targetType: string | null;
  /** The name of who asked (an agent, an app, a person); null when unknown. */
  askedBy: string | null;
  decidedBy: HistoryDecider;
  decidedAt: Date | string | null;
  space: string | null;
  undo: HistoryUndo;
  /** The decision's own page: what it changed and its receipt. */
  href: string;
}

function pastTitle(p: HistoryProposal): string {
  const payload = p.request?.data ?? p.data;
  const { heading, appConnect } = proposalHeading(p, payload);
  // An app's access request and an agent's held writes have their own
  // sentence (the one the request read); every other decision says what
  // happened.
  if (
    appConnect ||
    describeHeldWritesProposal({
      targetType: p.targetType,
      proposalType: p.proposalType,
      targetName: p.targetName,
      agentName: p.agentActorName,
      data: payload,
    })
  ) {
    return heading;
  }
  const deploy = describeDevDeployProposal({
    proposalType: p.proposalType,
    data: payload,
  });
  // The act as a record ("Push of a524c103 to main in …"): the row's status
  // mark says whether it was approved, rejected or withdrawn, so the title
  // never claims "Approved" for a row that was not.
  if (deploy) return deploy.recordTitle;
  // A ship verb's run, as a record ("Merge of app-bases#12 into main at …").
  const verbRun = describeVerbRunProposal({
    proposalType: p.proposalType,
    data: payload,
  });
  if (verbRun) return verbRun.recordTitle;
  return buildObjectActionTitle({
    action: String(p.proposalType ?? "change"),
    objectKind: String(p.targetType ?? ""),
    objectName: p.targetName ? String(p.targetName) : undefined,
    mood: "past",
  });
}

function deciderOf(p: HistoryProposal): HistoryDecider {
  if (p.approverName) return { kind: "person", name: p.approverName };
  if (p.status === "auto_approved") return { kind: "rule" };
  return null;
}

function undoOf(p: HistoryProposal): HistoryUndo {
  if (!APPLIED.has(p.status)) return "none";
  if (!p.revertable) return "permanent";
  // The pod re-checks the authority on revert; a row the viewer may not
  // decide never offers a button that would only be refused.
  return p.viewerCanReview === false ? "none" : "available";
}

export function historyRow(p: HistoryProposal): HistoryRow {
  return {
    id: p.id,
    title: pastTitle(p),
    status: p.status,
    statusLabel: resolveStatusLabel(p.status),
    tone: STATUS_TONE[p.status] ?? "unknown",
    kindLabel: resolveObjectNoun(p.targetType),
    targetType: p.targetType ?? null,
    askedBy: proposalRequesterParts(p).actor?.name ?? null,
    decidedBy: deciderOf(p),
    decidedAt: p.reviewedAt ?? p.updatedAt ?? null,
    space: p.workspaceName ?? null,
    undo: undoOf(p),
    href: `/proposal/${encodeURIComponent(p.id)}`,
  };
}

/** The decided requests of a `proposals.list` page, newest first as read. */
export function historyRows(items: readonly HistoryProposal[]): HistoryRow[] {
  return items.filter((p) => p.status !== "pending").map(historyRow);
}
