/**
 * Unified run view-model — ONE shape over the pod's several run ledgers.
 *
 * There is no unified `runs` table (a deliberate D3 decision: presentation-union,
 * no migration). Instead each existing ledger — `automation_runs`,
 * `playbook_runs`, the `capture.graph` proposal+events, and standalone
 * `focus_sessions` — is mapped to this one `UnifiedRun` so a single Runs/Activity
 * view can render "what an AI did" across every flow.
 *
 * The channel rule the model encodes (validated with the user):
 *   - automation → ONE channel for all its runs
 *   - playbook   → ONE channel per run (its session's channel)
 *   - capture    → no channel (its story is its correlationId-keyed events)
 *   - session    → its own channel
 */

/** Which ledger a run came from. */
export type FlowType = "automation" | "playbook" | "capture" | "session";

/** Normalised lifecycle across all ledgers. */
export type RunStatus =
  | "running"
  | "completed"
  | "failed"
  | "proposed"
  | "cancelled"
  // 'skipped' (Wave 4.V3) — an automation run whose flow precondition gated it
  // out before any step ran. Only automation_runs produces it today.
  | "skipped";

/** One run, ledger-agnostic. */
export interface UnifiedRun {
  /** Run id (the ledger row id; the captureId for a capture run). */
  id: string;
  flowType: FlowType;
  /** The flow this run instantiated (automationId / playbookId); null for capture. */
  flowId: string | null;
  /** Human label for the flow (automation/playbook name, session goal, "Capture"). */
  flowName: string;
  status: RunStatus;
  startedAt: Date;
  completedAt: Date | null;
  workspaceId: string | null;
  projectId: string | null;
  /** The entity this run is "about", when the ledger records one. */
  subjectEntityId: string | null;
  /** The durable channel that holds this run's activity (see the channel rule). */
  channelId: string | null;
  /** The correlationId that groups a capture's whole story (capture only). */
  correlationId: string | null;
  /** The run this one replays (automation/playbook lineage; null otherwise). */
  replayOf: string | null;
  summary: string | null;
  error: string | null;
  /** Who/what triggered the run (userId or "system"); null where the ledger has none. */
  triggeredBy: string | null;
  /** Steps that completed / failed (automation runs only; null for other ledgers). */
  stepsCompleted: number | null;
  stepsFailed: number | null;
  /** The definition version this run executed (from definitionSnapshot); null if unsnapshotted. */
  definitionVersion: number | null;
}

/**
 * A run GROUP — one template's whole run footprint collapsed to a single row.
 *
 * Only the ledgers whose runs instantiate a reusable FLOW group: `automation` and
 * `playbook` (both carry a `flowId`). Ad-hoc `capture`/`session` runs have no
 * flowId, so they are never grouped — they stay individual `UnifiedRun` rows. The
 * group key is (`flowType`, `flowId`). Counts are computed SERVER-side over the
 * whole ledger (not a truncated page), so `runCount`/`latestRunId` are exact —
 * the reason this is a dedicated grouped query and never a client fold.
 */
export interface RunGroup {
  flowType: "automation" | "playbook";
  /** The flow every run in this group instantiated (automationId / playbookId). */
  flowId: string;
  /** Human label for the flow (automation/playbook name). */
  flowName: string;
  /** Total runs of this flow the user can see. */
  runCount: number;
  /** The newest run's id — the drill target for "latest run". */
  latestRunId: string;
  /** The newest run's status (drives the group's status badge). */
  latestStatus: RunStatus;
  /** When the newest run started (the group's sort key in the merged feed). */
  latestStartedAt: Date;
  /** Any run of this flow currently running — drives the live pulse. */
  hasRunning: boolean;
  /** Runs that completed. */
  completedCount: number;
  /** Runs that failed. */
  failedCount: number;
}

/**
 * One entry in a run's activity timeline — a step (automation), a decision/trace
 * (capture), or a lifecycle marker. Rich timelines come from automation steps and
 * capture events; playbook/session runs carry a `channelId` so the UI opens the
 * channel for their message-level story instead of duplicating it here.
 */
export interface RunActivityItem {
  id: string;
  at: Date | null;
  /** "step" | "ai_decision" | "capture_trace" | "lifecycle" | … */
  kind: string;
  status: string | null;
  label: string;
  /** A one-line, actionable hint (capture traces carry a fixHint). */
  hint: string | null;
  detail: Record<string, unknown> | null;
}

export interface UnifiedRunDetail {
  run: UnifiedRun;
  activity: RunActivityItem[];
  /** The trigger that started this run — its principal + full payload (automation only). */
  trigger: { triggeredBy: string | null; payload: unknown } | null;
  /** The run's full output summary JSONB (automation only); null for other ledgers. */
  outputSummary: unknown;
  /**
   * Rich per-kind detail for a PLAYBOOK run — the objects it produced, the
   * changes it proposed (created/updated/removed), who worked it, and its
   * session card. Null for every other flow (additive; browsers infer absence).
   *
   * For automation runs the per-node story lives on `activity` (each step's
   * `detail` gains `nodeLabel` / `nodeId` / `commandId`), so there is no
   * automation-specific block here.
   */
  playbookDetail?: PlaybookRunDetail | null;
}

/**
 * A playbook run's rich footprint. Every list is user-floored and capped; the
 * session is the run's ONE focus session (playbook → one session per run).
 */
export interface PlaybookRunDetail {
  /** The run's session card — its goal, stage, progress, expected/verified outputs. */
  session: RunSessionCard | null;
  /** Entities the session produced (`session --produced--> entity`), user-visible only. */
  produced: RunProducedEntity[];
  /** The session's proposals — the created/updated/removed ledger the run wrote (cap 50). */
  proposals: RunProposalItem[];
  /** Best-effort distinct actors who worked the run (see RunAgent for the honesty caveats). */
  agents: RunAgent[];
}

/** The session card behind a playbook run. */
export interface RunSessionCard {
  id: string;
  goal: string;
  status: string;
  /** Active playbook stage key, or null for a stageless (progress-only) playbook. */
  currentStage: string | null;
  /** 0-100 progress, or null until the runner sets it. */
  progress: number | null;
  /** Declared deliverables ([{ kind, label, status? }]); shape-within-jsonb, passed through. */
  expectedOutputs: unknown;
  /** The single closing verification report JSONB, or null. */
  verificationReport: unknown;
  /** The session's room — where its message-level story lives. */
  channelId: string | null;
}

/** An entity a playbook run's session produced. */
export interface RunProducedEntity {
  entityId: string;
  title: string | null;
  /** Entity type slug (entities.type, from the profile slug). */
  type: string;
  producedAt: Date;
}

/**
 * One change a playbook run proposed. `changeKind` is a compact create/update/
 * delete class DERIVED from `proposalType` where the vocabulary maps cleanly
 * (create*, update/edit/merge, delete*); null when the type does not map — in
 * which case read the raw `proposalType`. APPROVED/auto-approved proposals are
 * included: "objects updated" ≈ resolved update-class proposals.
 */
export interface RunProposalItem {
  id: string;
  proposalType: string;
  changeKind: "create" | "update" | "delete" | null;
  status: string;
  targetType: string;
  targetId: string;
  rejectionReason: string | null;
  /** How many times a human revised this proposal before it resolved (the "AI got it wrong" signal). */
  revisionCount: number;
  createdAt: Date;
  reviewedAt: Date | null;
}

/**
 * A best-effort actor who worked a playbook run. Two honest signals are unioned:
 *   - `proposal` — the FK-backed `proposals.agentUserId` (guaranteed an agent-user).
 *   - `message`  — a `routedTeammateId` on an AI-agent message in the run's
 *     channel (the documented agent-user id). Plain AI-agent messages are NOT
 *     counted: their `userId` is the requesting owner, not the agent.
 * `name` is null when the id does not resolve to a `users` row.
 */
export interface RunAgent {
  /** users.id of the agent-user. */
  id: string;
  /** Display name (name / agentType / email) where resolvable; null otherwise. */
  name: string | null;
  /** Where the actor was observed. */
  source: "proposal" | "message" | "both";
}
