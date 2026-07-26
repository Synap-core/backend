/**
 * The `diagnose` door — output shapes.
 *
 * `diagnose` is the third canonical agent door (after `ask` = recall and
 * `capture` = write): "understand what's happening / what's wrong". Like
 * `capture`, its MODE is derived from the PAYLOAD shape, never from a tool name
 * the agent has to choose (see ./index.ts for the routing table).
 *
 * Every read underneath reuses an existing primitive (the runs substrate,
 * `collapseProposalsToClusters`, the pending-proposal reads); these types are
 * only the door's own composed view-models.
 */

import type {
  FlowType,
  UnifiedRun,
  UnifiedRunDetail,
  RunGroup,
} from "../runs/types.js";

/** A diagnosable class — the CLASS mode surfaces (`diagnose({ type })`). */
export type DiagnoseClass =
  "proposal" | "session" | "capability" | "agent" | "entity" | "run";

/** The kinds `resolveObjectKind` can detect for a bare id. */
export type ObjectKind =
  | "proposal"
  | "session"
  | "capability"
  | "agent"
  | "automation_run"
  | "playbook_run"
  | "entity";

/** Default "stuck" boundary: a run still `running` past this age is flagged. */
export const DEFAULT_STUCK_THRESHOLD_HOURS = 24;

/** A single global-health section verdict. */
export type HealthStatus = "ok" | "attention" | "degraded";

/** One section of the whole-pod health read. */
export interface HealthSection {
  key:
    | "stuck_runs"
    | "failed_flows"
    | "review_backlog"
    | "duplicate_proposals"
    | "capabilities"
    | "agent_activity";
  status: HealthStatus;
  /** Plain-language one-liner — honest-empty aware ("no stuck runs"). */
  headline: string;
  /** Structured evidence for the section (counts, samples). */
  detail: Record<string, unknown>;
}

/** GLOBAL mode — whole-pod health. */
export interface GlobalHealthReport {
  mode: "global";
  status: HealthStatus;
  /** One paragraph a human can read; says "all clear" when nothing is wrong. */
  summary: string;
  thresholds: { stuckHours: number };
  scope: { workspaceId: string | null };
  sections: HealthSection[];
}

/** The pod-side, agent-system-agnostic behavioural scorecard. */
export interface AgentScorecard {
  mode: "agent";
  agentId: string;
  agentName: string | null;
  agentType: string | null;
  /** Proposals scanned to build this card (capped). */
  sampled: number;
  counts: {
    total: number;
    pending: number;
    approved: number;
    rejected: number;
    revised: number;
  };
  rates: {
    /** approved (incl. auto) / total */
    approveRate: number;
    /** rejected / total */
    rejectRate: number;
    /** share of proposals a human revised before it resolved */
    reviseRate: number;
    /** share of proposals landing in a same-shape cluster (size > 1) */
    duplicateRate: number;
  };
  /** Top rejection reasons, most frequent first. */
  rejectionReasons: Array<{ reason: string; count: number }>;
  /** Daily-cap posture (the cap is shared across all of the owner's agents). */
  dailyCap: { todayCount: number; cap: number; atOrOverCap: boolean };
}

/** CLASS mode — a diagnosable class as a product surface. */
export interface ClassReport {
  mode: "class";
  type: DiagnoseClass;
  summary: string;
  detail: Record<string, unknown>;
}

/** OBJECT mode — one object's state + why. */
export interface ObjectReport {
  mode: "object";
  kind: ObjectKind;
  id: string;
  summary: string;
  state: Record<string, unknown>;
  /** The "why" trace where one exists (run activity, rejection reason, …). */
  why: Record<string, unknown> | null;
}

/** Today's run-feed / per-run behaviour, preserved verbatim (back-compat). */
export interface RunFeedReport {
  mode: "run-feed";
  runs: UnifiedRun[];
}
export interface RunDetailReport {
  mode: "run-detail";
  detail: UnifiedRunDetail;
}
export interface RunGroupsReport {
  mode: "run-groups";
  groups: RunGroup[];
}

export interface DiagnoseError {
  error: string;
}

export type DiagnoseResult =
  | GlobalHealthReport
  | AgentScorecard
  | ClassReport
  | ObjectReport
  | RunFeedReport
  | RunDetailReport
  | RunGroupsReport
  | DiagnoseError;

export type { FlowType };
