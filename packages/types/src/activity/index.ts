/**
 * ACTIVITY — "what happened, filtered" — ONE contract, every surface.
 *
 * The pod's `activity.list` door answers it: one newest-first ledger over the
 * acts the pod already records, merged under one ordering and one cursor.
 *
 *   proposal  — an act someone FILED through governance (an agent's write, an
 *               auto-approved receipt, a proposal still waiting). Actor = who
 *               filed it; clock = when it was filed.
 *   decision  — a PERSON approved, rejected or reverted a proposal. Actor = the
 *               reviewer; clock = `reviewedAt`.
 *   run       — an automation / playbook run. Clock = when it ended, else
 *               when it started.
 *   session   — a work session's lifecycle: started while it is live, closed
 *               (or failed / cancelled) once it settled. One row per session.
 *
 * Consumers: browser Work › Activity + Home "Today", relay "See all activity"
 * + Home. The surfaces render these rows and their filters; they never
 * re-derive who acted, what the outcome was, or which door a row opens.
 *
 * Pure and dependency-free (sibling leaves only). It returns TONE TOKEN NAMES
 * and GLYPHS, never a colour, and status TOKENS for `resolveStatusLabel`,
 * never a sentence.
 */

import { resolveActionLabel } from "../vocabulary/index.js";

export * from "./heat.js";
import type { UnitGlyph, UnitTone } from "../units/state.js";

// ── Outcome ─────────────────────────────────────────────────────────────────

/**
 * Where the act stands NOW.
 *
 *   succeeded — it applied / completed.
 *   failed    — a run or session failed, or an approval could not apply.
 *   proposed  — filed, not decided yet (the Needs you queue owns deciding it;
 *               Activity only records that it was filed).
 *   rejected  — a person said no.
 *   reverted  — it applied, then was undone.
 *   waiting   — a run the reaper found quiet while its session owes the person.
 *   running   — a live session / run.
 *   stopped   — cancelled, stale, skipped, withdrawn, expired, or refused by
 *               policy: it ended without failing and without succeeding.
 */
export const ACTIVITY_OUTCOMES = [
  "succeeded",
  "failed",
  "proposed",
  "rejected",
  "reverted",
  "waiting",
  "running",
  "stopped",
] as const;
export type ActivityOutcome = (typeof ACTIVITY_OUTCOMES)[number];

export interface ActivityOutcomeView {
  outcome: ActivityOutcome;
  /** A palette token NAME (see `UnitTone`) — each surface maps it to a colour. */
  tone: UnitTone;
  glyph: UnitGlyph;
  /** Feed to `resolveStatusLabel` (`@synap-core/types/vocabulary`). */
  statusToken: ActivityOutcome;
}

const OUTCOME_VIEWS: Record<
  ActivityOutcome,
  Pick<ActivityOutcomeView, "tone" | "glyph">
> = {
  succeeded: { tone: "success", glyph: "check" },
  failed: { tone: "error", glyph: "alert" },
  // The same mark as a unit that `needs_review` — it waits on a judgement.
  proposed: { tone: "primary", glyph: "scales" },
  rejected: { tone: "textMuted", glyph: "dashed-circle" },
  reverted: { tone: "textMuted", glyph: "dashed-circle" },
  // The same mark as a unit that `needs_you`.
  waiting: { tone: "primary", glyph: "person" },
  // The same mark as a `working` unit.
  running: { tone: "ai", glyph: "spark" },
  stopped: { tone: "textSecondary", glyph: "pause" },
};

export function resolveActivityOutcomeView(
  outcome: ActivityOutcome
): ActivityOutcomeView {
  return { outcome, statusToken: outcome, ...OUTCOME_VIEWS[outcome] };
}

/** A proposal's `status` → the outcome of the act it records. */
export function activityOutcomeForProposal(
  status: string | null | undefined
): ActivityOutcome {
  switch (status) {
    case "approved":
    case "partially_approved":
    case "auto_approved":
      return "succeeded";
    case "pending":
      return "proposed";
    case "rejected":
      return "rejected";
    case "reverted":
      return "reverted";
    case "approval_failed":
      return "failed";
    default:
      // withdrawn / expired / an unknown value: it ended, nothing applied.
      return "stopped";
  }
}

/** A run's status (the unified runs vocabulary) → the outcome. */
export function activityOutcomeForRun(
  status: string | null | undefined
): ActivityOutcome {
  switch (status) {
    case "completed":
      return "succeeded";
    case "failed":
      return "failed";
    case "waiting_on_you":
      return "waiting";
    case "running":
      return "running";
    case "proposed":
      return "proposed";
    default:
      // cancelled / skipped / blocked_by_policy / an unknown value.
      return "stopped";
  }
}

/** A work session's status → the outcome of its lifecycle row. */
export function activityOutcomeForSession(
  status: string | null | undefined
): ActivityOutcome {
  switch (status) {
    case "closed":
      return "succeeded";
    case "failed":
      return "failed";
    case "active":
    case "paused":
    case "forming":
      return "running";
    default:
      // cancelled / stale / an unknown value.
      return "stopped";
  }
}

// ── Actor ───────────────────────────────────────────────────────────────────

/**
 * WHO acted. An agent is named when the pod could name it (`id: null` = an
 * agent that recorded no attributable identity, never a guess). `system` is a
 * rule acting on its own (an automation run): `id`/`name` name the rule.
 */
export type ActivityActor =
  | { kind: "agent"; id: string | null; name: string | null }
  | { kind: "human"; id: string; name: string | null; isViewer: boolean }
  | { kind: "system"; id: string | null; name: string | null };

/**
 * Who the list is filtered to: everyone, any agent, the viewer's own acts, or
 * one agent (`agent:<agentUserId>`).
 */
export type ActivityActorFilter = "all" | "agents" | "me" | `agent:${string}`;

export const ACTIVITY_AGENT_FILTER_PREFIX = "agent:";

export function activityAgentFilter(agentUserId: string): ActivityActorFilter {
  return `${ACTIVITY_AGENT_FILTER_PREFIX}${agentUserId}`;
}

export type ParsedActivityActorFilter =
  | { kind: "all" }
  | { kind: "agents" }
  | { kind: "me" }
  | { kind: "agent"; agentUserId: string };

/** `null` for a value that is not an actor filter (the door rejects it). */
export function parseActivityActorFilter(
  value: string | null | undefined
): ParsedActivityActorFilter | null {
  if (value === undefined || value === null || value === "all")
    return { kind: "all" };
  if (value === "agents") return { kind: "agents" };
  if (value === "me") return { kind: "me" };
  if (value.startsWith(ACTIVITY_AGENT_FILTER_PREFIX)) {
    const agentUserId = value.slice(ACTIVITY_AGENT_FILTER_PREFIX.length);
    return agentUserId ? { kind: "agent", agentUserId } : null;
  }
  return null;
}

/** The actor filter as a predicate. The pod applies the same rule in SQL. */
export function matchesActivityActor(
  actor: ActivityActor,
  filter: ActivityActorFilter
): boolean {
  const parsed = parseActivityActorFilter(filter);
  if (!parsed) return false;
  switch (parsed.kind) {
    case "all":
      return true;
    case "agents":
      return actor.kind === "agent";
    case "me":
      return actor.kind === "human" && actor.isViewer;
    case "agent":
      return actor.kind === "agent" && actor.id === parsed.agentUserId;
  }
}

// ── Rows ────────────────────────────────────────────────────────────────────

export const ACTIVITY_SOURCES = [
  "proposal",
  "decision",
  "run",
  "session",
] as const;
export type ActivitySource = (typeof ACTIVITY_SOURCES)[number];

/**
 * The DOOR a row opens — through the route table (`objectNavTarget(kind, id)`).
 * An applied proposal opens the object it made or changed; one that did not
 * apply opens itself (`kind: "proposal"`), because its object may not exist.
 * A run opens the run (`kind: "run"`, with its `flowType`), a session itself.
 */
export interface ActivityObjectRef {
  /** Normalized object kind (`entity`, `document`, `proposal`, `run`, …). */
  kind: string;
  id: string;
  /** What the object is called, when known. */
  name: string | null;
  /** An entity's profile slug, for its noun ("Person"), when known. */
  profileSlug?: string | null;
  /** A run's ledger (`automation` | `playbook`), for the run route. */
  flowType?: string | null;
}

export interface ActivityRow {
  /** Stable key, unique across sources: `<source>:<id>`. */
  id: string;
  source: ActivitySource;
  /** When the act happened (ISO). The list is ordered by it, newest first. */
  occurredAt: string;
  actor: ActivityActor;
  /** The vocabulary ACTION token (`create`, `approve`, `run`, `start`, …). */
  action: string;
  /** `resolveActionLabel(action, "past")` — "Created", "Approved", "Ran". */
  verb: string;
  /**
   * The headline. A proposal / decision row carries the proposal's own display
   * title (the pod's `proposalDisplaySummary` — the name every proposal door
   * leads with); a run its flow's name; a session its title.
   */
  title: string;
  object: ActivityObjectRef;
  /** The proposal behind a proposal / decision row. */
  proposalId: string | null;
  project: { id: string; name: string | null } | null;
  /**
   * The session it happened in — the provenance door. `null` when there is
   * none, or when the viewer may not read that session (decision D1).
   */
  session: { id: string; title: string } | null;
  outcome: ActivityOutcome;
  /**
   * The Undo door — `proposals.revert(proposalId)` — on exactly ONE row per
   * revertable proposal: the decision row when a person approved it, the
   * proposal row when a rule auto-approved it. Undo reverts the WHOLE
   * proposal, so `changeCount` says how far it reaches (`null` = unknown).
   */
  undo: { proposalId: string; changeCount: number | null } | null;
  /** A failed run's own error line, when it recorded one. */
  error: string | null;
}

export interface ActivityPage {
  items: ActivityRow[];
  /** Pass back as `cursor` for the next (older) page; `null` = no more. */
  nextCursor: string | null;
}

/** The verb a row wears — ONE derivation, past mood (it already happened). */
export function resolveActivityVerb(action: string): string {
  return resolveActionLabel(action, "past");
}

// ── Filters ─────────────────────────────────────────────────────────────────

export const ACTIVITY_MAX_LIMIT = 100;
export const ACTIVITY_DEFAULT_LIMIT = 30;

/** The door's filter input (`activity.list`). Every field only narrows. */
export interface ActivityFilter {
  actor?: ActivityActorFilter;
  /** Only acts filed into / run under this project. */
  projectId?: string;
  /** Only acts inside this track's sessions (automation runs never are). */
  trackId?: string;
  /**
   * Same three-state lens as `signals`: a string = that workspace, `null` =
   * pod-personal only, absent = the WHOLE floor (never the active-workspace
   * header).
   */
  workspaceId?: string | null;
  outcome?: ActivityOutcome;
  source?: ActivitySource;
  /** ISO instant: only acts at or after it. */
  since?: string;
  /** ISO instant: only acts strictly before it (a day = `activityDayRange`). */
  until?: string;
}

/**
 * The filter row both apps show, as data: each preset is the door input it
 * stands for. "Decided" = the decisions the VIEWER made ("Your decisions").
 */
export const ACTIVITY_FILTER_PRESETS = [
  "all",
  "me",
  "agents",
  "failed",
  "decided",
] as const;
export type ActivityFilterPreset = (typeof ACTIVITY_FILTER_PRESETS)[number];

export function activityFilterForPreset(
  preset: ActivityFilterPreset
): Pick<ActivityFilter, "actor" | "outcome" | "source"> {
  switch (preset) {
    case "all":
      return {};
    case "me":
      return { actor: "me" };
    case "agents":
      return { actor: "agents" };
    case "failed":
      return { outcome: "failed" };
    case "decided":
      return { source: "decision", actor: "me" };
  }
}

// ── Home: "agents today" ────────────────────────────────────────────────────

/** Home shows at most this many agents. */
export const AGENTS_TODAY_MAX = 5;

/**
 * The start of the viewer's day, as the `since` of the Home read. Local
 * midnight of `now` in the runtime's own time zone — the viewer's device.
 */
export function startOfActivityDay(now: Date = new Date()): string {
  const d = new Date(now.getTime());
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export interface AgentTodaySummary {
  agent: { id: string | null; name: string | null };
  /** How many acts this agent has in the page. */
  count: number;
  /** Its newest act — the row Home shows. */
  lastAct: ActivityRow;
}

export interface AgentsTodaySelection {
  agents: AgentTodaySummary[];
  /**
   * The page did not hold the whole day (`nextCursor` was set), so the counts
   * are lower bounds — say "20+", never a confident 20.
   */
  truncated: boolean;
  /** Agents beyond the cap, so the surface can say "and N more". */
  hiddenAgents: number;
}

/**
 * THE Home selection: per agent, how many acts and the newest one, the most
 * recently active agent first, capped at `limit`.
 *
 * Feed it the page of `activity.list({ actor: "agents", since:
 * startOfActivityDay() })`. Rows that are not by an agent, or that sit before
 * `since` when one is given, are ignored. Agents with no id are grouped by
 * name — never merged with a named agent.
 */
export function selectAgentsToday(
  page: ActivityPage,
  opts: { since?: string; limit?: number } = {}
): AgentsTodaySelection {
  const sinceMs = opts.since === undefined ? null : Date.parse(opts.since);
  if (sinceMs !== null && Number.isNaN(sinceMs)) {
    throw new RangeError(`selectAgentsToday: unreadable since (${opts.since})`);
  }
  const limit = opts.limit ?? AGENTS_TODAY_MAX;
  const byAgent = new Map<string, AgentTodaySummary>();
  const newest = (a: ActivityRow, b: ActivityRow) =>
    Date.parse(b.occurredAt) - Date.parse(a.occurredAt);
  for (const row of [...page.items].sort(newest)) {
    if (row.actor.kind !== "agent") continue;
    if (sinceMs !== null && !(Date.parse(row.occurredAt) >= sinceMs)) continue;
    const key = row.actor.id
      ? `id:${row.actor.id}`
      : `name:${row.actor.name ?? ""}`;
    const seen = byAgent.get(key);
    if (seen) {
      seen.count += 1;
    } else {
      byAgent.set(key, {
        agent: { id: row.actor.id, name: row.actor.name },
        count: 1,
        lastAct: row,
      });
    }
  }
  const all = [...byAgent.values()].sort((a, b) =>
    newest(a.lastAct, b.lastAct)
  );
  return {
    agents: all.slice(0, limit),
    truncated: page.nextCursor !== null,
    hiddenAgents: Math.max(0, all.length - limit),
  };
}
