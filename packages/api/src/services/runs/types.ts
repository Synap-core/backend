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
  | "cancelled";

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
}
