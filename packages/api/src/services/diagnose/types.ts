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
  | "proposal"
  | "session"
  | "capability"
  | "agent"
  | "entity"
  | "run"
  /**
   * The workspace LANDSCAPE — "do I have too many workspaces?", answered with
   * evidence (per-workspace kinds + counts, pairwise profile-slug overlap,
   * empty/duplicate-name/no-identity flags). Added because the pod could not
   * answer a structural question about its own organising dimension: the read
   * was only reachable by raw SQL against Postgres.
   */
  | "workspace";

/** The kinds `resolveObjectKind` can detect for a bare id. */
export type ObjectKind =
  | "proposal"
  | "session"
  | "capability"
  | "agent"
  | "automation_run"
  | "playbook_run"
  | "entity"
  /**
   * A saved VIEW and a DOCUMENT. Added when `/resolve/:id` (the `synap open
   * <bare-id>` door) stopped keeping its own second probe list and started
   * calling `resolveObjectKind`: those two kinds existed ONLY in that weaker,
   * unguarded list, so the union of the two lists is what this prober now owns.
   */
  | "view"
  | "document"
  /**
   * A WORKSPACE — the pod's own organising lens. It was the one kind the pod is
   * structured by that `diagnose` could not explain (`diagnose({id:<wsId>})`
   * answered "No diagnosable object found" on the live pod).
   */
  | "workspace"
  /**
   * A completed external-dispatch send (messaging.external.send / provider
   * proxy call) — resolved ONLY via its `correlationId` (there is no separate
   * row; see resolve-object-kind.ts's correlationId fallback). Wave 2 of the
   * universal-sink plan (`connectors/external-dispatch.ts`).
   */
  | "external_send";

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
    | "agent_activity"
    /**
     * How often the human says YES when the pod asks. Present only when the
     * signal was computed (see `GlobalSignals.reviewQueue`) — absent means
     * "not measured", never "0%".
     */
    | "review_queue";
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
  /** `idleMinutes` present only when the progress-based signal was computed. */
  thresholds: { stuckHours: number; idleMinutes?: number };
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
    /** FULLY approved — every item of the package was applied. */
    approved: number;
    /**
     * Approved with at least one item DENIED (per-item dispositions). The row
     * stores plain `"approved"`; this is the only place the gutting shows.
     * Excluded from `approved` so a partial apply is never scored as a full
     * endorsement.
     */
    partiallyApproved: number;
    rejected: number;
    revised: number;
  };
  rates: {
    /** FULLY approved (incl. auto) / total — partial applies excluded. */
    approveRate: number;
    /** partially approved / total */
    partialApproveRate: number;
    /** rejected / total */
    rejectRate: number;
    /** share of proposals a human revised before it resolved */
    reviseRate: number;
    /** share of proposals landing in a same-shape cluster (size > 1) */
    duplicateRate: number;
  };
  /** Top rejection reasons, most frequent first. */
  rejectionReasons: Array<{ reason: string; count: number }>;
  /** Daily-cap posture. The cap is PER-AGENT (scales with this agent's own
   *  trust — see `agentDailyProposalCap`), not shared across the owner's roster. */
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

/**
 * CAPABILITY-COMPOSITION mode — "what did this installed capability materialize,
 * and is it healthy?". Returned when OBJECT mode resolves a real `capabilities`
 * row (a container). FROZEN shape — a parallel frontend consumes it verbatim, so
 * do NOT reshape it. Members are the capability's `member_of` graph (now complete
 * with playbook/automation after the T5 wiring); `wired` flags a member missing
 * its own edges (a verb with no parent tool, an archived flow); `health` rolls up
 * run health over the materialized playbook/automation flows; `gaps` is the
 * human-readable list of what is unwired.
 */
export interface CapabilityComposition {
  id: string;
  name: string;
  /** The container's own `capabilities.description` column, verbatim.
   *  `null` when absent — never fabricated. */
  description: string | null;
  approved: boolean;
  /**
   * The container's own `capabilities.workspaceId` — `null` for a pod-wide
   * capability. ADDITIVE (optional: single-object callers that don't load it
   * simply omit it). Exists so the UI can label/distinguish two same-named
   * installs living in different workspaces (the "two identical Discord Bot
   * cards" bug) — never used to change which rows this builder returns.
   */
  workspaceId?: string | null;
  /**
   * Resolved `workspaces.name` for `workspaceId`, batched in LIST mode only
   * (`listCapabilityCompositions`) — cheap, one extra query for the whole
   * page. `undefined` when not resolved (single-object callers), `null` when
   * `workspaceId` is null (pod-wide).
   */
  workspaceName?: string | null;
  provenance: { templateKey?: string; contentHash?: string } | null;
  members: Array<{
    kind: "tool" | "skill" | "playbook" | "automation";
    id: string;
    name: string;
    wired: boolean;
  }>;
  health: {
    status: "ok" | "degraded" | "failed" | "unknown";
    failedRuns: number;
    stuckRuns: number;
    lastRunAt?: string;
  };
  gaps: string[];
  /**
   * Producer mode — "standing" (always-on, e.g. a bridge) vs "callable"
   * (invoked per-run) vs "unknown". Lets a "Bridges" listing filter standing
   * capabilities without an N+1 (see `deriveCapabilityMode`).
   */
  mode: "standing" | "callable" | "unknown";
  modeSource: "declared" | "derived_transport" | "derived_produced" | "unknown";
  /**
   * Product classification — "does this capability maintain a real connection
   * to an external system?" (drives the Bridges LIST). DISTINCT from `mode`
   * (standing/callable, drives HEALTH semantics): a connected provider with no
   * produced channels (e.g. Google Workspace) is `isBridge:true` but may still
   * read `mode:'unknown'` (no liveness signal yet) — that split is correct, not
   * a bug. True iff ANY: declared `metadata.mode==='standing'`; a member tool
   * `config.transport==='bridge'`; the capability PRODUCES ≥1 channel; or a
   * member tool is a connected provider (`kind==='provider'`, a Nango OAuth
   * account) — never an invocable `'api'`/`'builtin'`/`'mcp'`/`'script'` tool.
   */
  isBridge: boolean;
  /**
   * Directional flow — the honest ingest/callable PAIR (distinct from `mode`,
   * which is a single standing/callable/unknown enum that NEVER concludes
   * callable). Lets a UI toggle (ingest / callable / both) and per-verb
   * placement render truthfully instead of guessing:
   *   - `ingest`   — the capability brings data IN: it is standing (`mode`),
   *                  declares `metadata.emits`, or PRODUCES ≥1 channel.
   *   - `callable` — the capability exposes ≥1 catalog verb (a resolved member
   *                  skill — the SAME `verbs[]` source `buildCapabilityCatalog`
   *                  folds into a card).
   *   - `kind`     — both → "both"; ingest only → "ingest"; callable only →
   *                  "callable"; NEITHER → "unknown" (honest fallback, never a
   *                  guessed default).
   * ADDITIVE: existing consumers that ignore it are unaffected.
   */
  direction: {
    ingest: boolean;
    callable: boolean;
    kind: "ingest" | "callable" | "both" | "unknown";
  };
  /**
   * Best-effort, NORMALIZED read of a member tool's provider-specific
   * extraction config (currently only the Discord bot template populates
   * this — `tools.metadata.discord.*`; see `normalizeExtractionPolicy` in
   * capability-composition.ts). Provider config shapes vary, so only keys
   * that are present and the right type are included; `null` when NONE of
   * the recognized keys are present anywhere across the member tools — the
   * rail then renders nothing rather than an empty shell. Never fabricated.
   */
  extractionPolicy: {
    reactCapture?: boolean;
    captureFlows?: number;
    eventSync?: boolean;
    captureChannel?: string | null;
  } | null;
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
  | CapabilityComposition
  | RunFeedReport
  | RunDetailReport
  | RunGroupsReport
  | DiagnoseError;

export type { FlowType };
