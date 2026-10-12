/**
 * The Agents page's view model — pure, so every rule here is unit-tested.
 *
 * It composes the shared rules in `@synap-core/types/agents` (the ONE agent
 * mark, the ONE whose-agent direction, host humanizing) — the same ones the
 * browser and relay Settings › Agents read — and adds only what the console
 * needs on top: the status pill tone, one plain sentence per row, the join
 * with `diagnose.agents` standings, and the roster order.
 */

import {
  agentDirectionOf,
  agentMarkText,
  resolveAgentMark,
  type AgentDirection,
  type AgentMark,
  type AgentMarkRowLike,
  type AgentMarkTone,
  type AgentReachRowLike,
} from "@synap-core/types/agents";
import type { StatusKind } from "../../components/status-pill";

/** The slice of an `agentUsers.list` row this page reads. */
export interface AgentRosterRowLike
  extends AgentMarkRowLike, AgentReachRowLike {
  email?: string | null;
  /** It acts on the viewer's behalf (one of its keys is linked to them). */
  operatedByViewer?: boolean;
  /** `users.created_via`. */
  origin?: string | null;
  direction?: string | null;
  isPersonalAgent?: boolean | null;
  /** The person the agent acts for — the owner the scorecard is floored to. */
  createdByUserId?: string | null;
  /** Its open `agent/connect` request, when the viewer may decide it. */
  pendingProposalId?: string | null;
}

/** The slice of a `diagnose.agents` standing this page reads. */
export interface AgentStandingLike {
  agentUserId: string;
  approveRate: number;
  refuseRate: number;
  scoredTotal: number;
}

export interface AgentRowView<
  R extends AgentRosterRowLike = AgentRosterRowLike,
> {
  row: R;
  mark: AgentMark;
  status: { kind: StatusKind; label: string };
  /** One plain sentence: where the agent stands, in words. */
  sentence: string;
  direction: AgentDirection;
  /** A key or connect request waits on a person — the row's one action. */
  needsReview: boolean;
  /** The viewer is the agent's owner: its scorecard is readable. */
  ownedByViewer: boolean;
  /** Lifetime approve / refuse standing, when the viewer may see it. */
  standing: AgentStandingLike | null;
}

export const MARK_TONE_TO_STATUS: Record<AgentMarkTone, StatusKind> = {
  success: "healthy",
  warning: "stale",
  danger: "down",
  neutral: "unknown",
};

/** Short pill words per mark — the sentence carries the detail. */
const PILL_LABEL: Record<AgentMark["kind"], string> = {
  builtIn: "Built-in",
  seen: "Active",
  stale: "Quiet",
  approve: "Needs approval",
  waiting: "Not called yet",
  disconnected: "Disconnected",
  noKey: "No key",
  unmeasured: "Unknown",
};

export function agentNeedsReview(row: AgentRosterRowLike): boolean {
  return (row.pendingKeys ?? 0) > 0 || !!row.pendingProposalId;
}

/**
 * One sentence for the row. `relative` renders an ISO instant ("3d ago") —
 * the console's own `formatRelative`, injected so this stays pure.
 */
export function agentStatusSentence(
  row: AgentRosterRowLike,
  mark: AgentMark,
  relative: (iso: string) => string
): string {
  const on = mark.host ? ` on ${mark.host}` : "";
  switch (mark.kind) {
    case "builtIn":
      return "Built into the pod — it needs no key.";
    case "unmeasured":
      return "This pod does not report when its agents were last seen.";
    case "approve":
      return "Waiting for your approval before it can connect.";
    case "disconnected":
      return mark.seenAt
        ? `Disconnected — no live key. Last seen ${relative(mark.seenAt)}${on}.`
        : "Disconnected — no live key.";
    case "waiting":
      return "Has a key but has not called the pod yet.";
    case "noKey":
      return "Never connected — it has no key yet.";
    case "seen":
    case "stale": {
      const text = agentMarkText(mark, relative) ?? "Seen";
      const pending = agentNeedsReview(row)
        ? " Another key is waiting for your approval."
        : "";
      return mark.kind === "stale"
        ? `Quiet — ${text.charAt(0).toLowerCase()}${text.slice(1)}${on}.${pending}`
        : `${text}${on}.${pending}`;
    }
  }
}

/**
 * Join the roster with the standings (on `agentUserId`) and the viewer, and
 * order it: rows that wait on a person first, then most recently seen, then
 * by name.
 */
export function buildAgentRoster<R extends AgentRosterRowLike>(
  rows: readonly R[],
  standings: readonly AgentStandingLike[],
  viewerId: string | null,
  relative: (iso: string) => string,
  now: number = Date.now()
): AgentRowView<R>[] {
  const byAgent = new Map(standings.map((s) => [s.agentUserId, s]));
  const views = rows.map((row): AgentRowView<R> => {
    const mark = resolveAgentMark(row, now);
    const needsReview = agentNeedsReview(row);
    const status =
      needsReview && mark.kind !== "approve"
        ? { kind: "stale" as const, label: PILL_LABEL.approve }
        : {
            kind:
              mark.kind === "stale" ? "stale" : MARK_TONE_TO_STATUS[mark.tone],
            label: PILL_LABEL[mark.kind],
          };
    return {
      row,
      mark,
      status,
      sentence: agentStatusSentence(row, mark, relative),
      direction: agentDirectionOf(row),
      needsReview,
      ownedByViewer:
        !!viewerId && !!row.createdByUserId && row.createdByUserId === viewerId,
      standing: byAgent.get(row.id) ?? null,
    };
  });
  return views.sort((a, b) => {
    if (a.needsReview !== b.needsReview) return a.needsReview ? -1 : 1;
    const sa = a.mark.seenAt ?? "";
    const sb = b.mark.seenAt ?? "";
    if (sa !== sb) return sa < sb ? 1 : -1;
    return (a.row.name ?? "").localeCompare(b.row.name ?? "");
  });
}

/** "79% approved of 120 reviewed" — `null` when nothing was decided yet. */
export function standingLine(s: AgentStandingLike | null): string | null {
  if (!s || s.scoredTotal === 0) return null;
  return `${Math.round(s.approveRate * 100)}% approved of ${s.scoredTotal} reviewed`;
}

/** "2 live · 1 waiting · 3 revoked" — only the non-zero parts. */
export function keyCountsLine(row: AgentRosterRowLike): string {
  const parts: string[] = [];
  if (row.activeKeys) parts.push(`${row.activeKeys} live`);
  if (row.pendingKeys) parts.push(`${row.pendingKeys} waiting`);
  if (row.revokedKeys) parts.push(`${row.revokedKeys} revoked`);
  return parts.length > 0 ? parts.join(" · ") : "No keys";
}

const ORIGIN_LINE: Record<string, string> = {
  cli: "Connected from a terminal (synap init)",
  ui: "Made or added in the app",
  device: "Came with an approved computer",
  system: "Made by the pod for itself",
  "intelligence-service": "An Intelligence persona the pod runs",
};

/** Where the agent came from, in words; `null` when the pod did not record it. */
export function originLine(origin: string | null | undefined): string | null {
  if (!origin) return null;
  return ORIGIN_LINE[origin] ?? null;
}

/**
 * The roster rows `agentUsers.removeByUserId(creatorId)` would remove — every
 * agent that creator made. The roster is the viewer's floor, so this is what
 * the viewer can SEE; the pod may remove more (stated in the confirm copy).
 */
export function agentsByCreator<R extends AgentRosterRowLike>(
  rows: readonly R[],
  creatorId: string
): R[] {
  return rows.filter((r) => r.createdByUserId === creatorId);
}
