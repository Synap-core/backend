/**
 * The pod-admin timeline's derivation: one history or audit row becomes the
 * ONE display entry (`entryOf`, `@synap-core/types/work-view`), and entries
 * are grouped by day with checks folded (`groupEntries`). Pages draw rows
 * only through `TimelineList`, which reads this file; neither History nor
 * Audit derives its own row (tripwire `timeline-rows.test.ts`).
 *
 * Neither source is timeline-shaped: a decided request (`proposals.list`) and
 * an audit-log event (`system.listAuditLogs`) are adapted here, through small
 * mappers onto the Activity-row shape `entryOf` reads. The data doors are
 * untouched; every word still comes from the vocabulary door.
 *
 * Pure.
 */

import {
  activityOutcomeForProposal,
  resolveActivityVerb,
  type ActivityActor,
  type ActivityOutcome,
} from "@synap-core/types/activity";
import { resolveActionLabel } from "@synap-core/types/vocabulary";
import {
  entryOf,
  groupEntries,
  type ActivityLineEntry,
  type EntryGroup,
  type WorkEntry,
} from "@synap-core/types/work-view";

/** The Activity row an adapted source stands as. */
interface AdaptedRow {
  key: string;
  at: string;
  actor: ActivityActor;
  action: string;
  title: string;
  outcome: ActivityOutcome;
  objectKind: string;
  objectId: string;
  proposalId?: string | null;
}

/** An adapted row as a line entry, then as the ONE display entry. */
export function adaptedEntry(r: AdaptedRow): WorkEntry {
  const line: ActivityLineEntry = {
    key: r.key,
    source: "activity",
    at: r.at,
    weight: "milestone",
    failed: r.outcome === "failed",
    actor: r.actor,
    kind: `${r.proposalId ? "decision" : "audit"}.${r.action}`,
    category: null,
    row: {
      id: r.key,
      source: r.proposalId ? "decision" : "proposal",
      occurredAt: r.at,
      actor: r.actor,
      action: r.action,
      verb: resolveActivityVerb(r.action),
      title: r.title,
      object: { kind: r.objectKind, id: r.objectId, name: null },
      proposalId: r.proposalId ?? null,
      project: null,
      session: null,
      outcome: r.outcome,
      undo: null,
      error: null,
    },
  };
  return entryOf(line);
}

const iso = (d: Date | string | null | undefined): string => {
  if (!d) return "";
  const t = d instanceof Date ? d : new Date(d);
  return Number.isNaN(t.getTime()) ? "" : t.toISOString();
};

// ── Decided requests (History) ──────────────────────────────────────────────

/** A decided request, structurally (what `historyRow` already read). */
export interface DecisionFacts {
  id: string;
  status: string;
  proposalType?: string | null;
  targetType?: string | null;
  title: string;
  decidedAt: Date | string | null;
  /** Who decided it (a person), else who asked (an agent), else nobody. */
  decidedBy: string | null;
  askedBy: string | null;
}

const STATUS_ACTION: Readonly<Record<string, string>> = {
  approved: "approve",
  auto_approved: "approve",
  partially_approved: "approve",
  rejected: "reject",
  reverted: "revert",
  withdrawn: "withdraw",
  expired: "expire",
  // The change did not apply: the act is "ran", the mark says it failed.
  approval_failed: "run",
};

/**
 * The act a decided request wears. Its own action when the title already
 * leads with that verb ("Created contact Léa"), so the row reads once; else
 * what was decided (approved, rejected, withdrawn…).
 */
export function decisionAction(d: DecisionFacts): string {
  const own = d.proposalType?.trim().toLowerCase();
  if (own) {
    const words = [
      resolveActionLabel(own, "imperative"),
      resolveActionLabel(own, "past"),
    ];
    const head = d.title.toLowerCase();
    if (words.some((w) => w && head.startsWith(`${w.toLowerCase()} `)))
      return own;
  }
  return STATUS_ACTION[d.status] ?? "close";
}

export function decisionEntry(d: DecisionFacts): WorkEntry {
  const actor: ActivityActor = d.decidedBy
    ? { kind: "human", id: "", name: d.decidedBy, isViewer: false }
    : d.askedBy
      ? { kind: "agent", id: null, name: d.askedBy }
      : { kind: "system", id: null, name: null };
  return adaptedEntry({
    key: d.id,
    at: iso(d.decidedAt),
    actor,
    action: decisionAction(d),
    title: d.title,
    outcome: activityOutcomeForProposal(d.status),
    objectKind: "proposal",
    objectId: d.id,
    proposalId: d.id,
  });
}

// ── Audit-log events (Audit) ────────────────────────────────────────────────

export interface AuditFacts {
  id: string;
  timestamp: Date | string;
  /** The log's own action word (`create`, `rotate`, …): read through the vocabulary. */
  action: string;
  phase: string;
  /** The subject, as the noun + short id the page already writes. */
  subject: string;
  subjectType: string;
  subjectId: string;
  userId: string;
  /** The actor's name or email; null when the pod could not read it. */
  actorName: string | null;
}

function auditOutcome(phase: string): ActivityOutcome {
  const p = phase.toLowerCase();
  if (p.includes("fail") || p.includes("error")) return "failed";
  if (p.includes("reject") || p.includes("denied")) return "rejected";
  return "succeeded";
}

export function auditEntry(a: AuditFacts): WorkEntry {
  return adaptedEntry({
    key: a.id,
    at: iso(a.timestamp),
    actor: {
      kind: "human",
      id: a.userId,
      name: a.actorName,
      isViewer: false,
    },
    action: a.action || "update",
    title: a.subject,
    outcome: auditOutcome(a.phase),
    objectKind: a.subjectType,
    objectId: a.subjectId,
  });
}

// ── Grouping and the cap ────────────────────────────────────────────────────

export function dayGroups(
  entries: readonly WorkEntry[],
  timeZone: string,
  now?: Date
): EntryGroup[] {
  return groupEntries(entries, { by: "day", timeZone, now });
}

/** The first `max` rows across the groups (a group left empty is dropped). */
export function capGroups(groups: EntryGroup[], max: number): EntryGroup[] {
  let left = max;
  const out: EntryGroup[] = [];
  for (const g of groups) {
    if (left <= 0) break;
    const rows = g.rows.slice(0, left);
    left -= rows.length;
    out.push({ ...g, rows });
  }
  return out;
}

export const rowCount = (groups: readonly EntryGroup[]): number =>
  groups.reduce((n, g) => n + g.rows.length, 0);
