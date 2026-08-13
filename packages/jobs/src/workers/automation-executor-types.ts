/**
 * Shared types for the automation-executor module family. Extracted as a leaf
 * (no imports back into the worker or any `steps/*` module) so every split-out
 * module — and the main worker — can depend on the SAME `StepContext` /
 * `ExecutionPayload` shape without a circular import.
 */

export interface ExecutionPayload {
  runId: string;
  automationId: string;
  workspaceId: string;
  automationContext: {
    automationRunId: string;
    automationId: string;
    chainDepth: number;
    rootRunId: string;
    chainAutomationIds: string[];
    /**
     * The focus session opened for this run (non-playbook-delegate automations
     * only — see `executeAutomationFlow`). Threaded through delay-resumption
     * re-enqueues so a suspended run reuses the SAME session on resume instead
     * of opening a second one. Deliberately NOT inherited by `sub_automation`
     * children — each chained automation run is its own reviewable unit and
     * gets its own session.
     */
    focusSessionId?: string;
    /** True when this run created the session fresh (vs. reusing a channel's
     *  existing active session) — only the owner closes it at genuine finish. */
    focusSessionOwned?: boolean;
  };
  /** For delay resumption: skip nodes that were already executed */
  completedNodeIds?: string[];
}

/** Context built up during execution — step outputs available to later steps */
export interface StepContext {
  trigger: {
    payload: Record<string, unknown>;
  };
  // `output` is the RAW result of the node (whatever the verb/skill/handler
  // returned — object, array, string, number). ONE rule for every node type:
  // templates read `steps.<id>.output.<field>`. No node double-wraps (the old
  // skill/capability/sub_automation `{ output: <result>, verbId }` envelope is
  // gone — provenance is not consumed downstream, so it is not re-nested here).
  steps: Record<string, { output: unknown }>;
  loop?: { item: unknown; index: number };
  // Set only inside array-pipe predicates/expressions (filter/map) so a
  // predicate can reference the current item as `{{item.<field>}}`.
  item?: unknown;
  // Per-automation persistent state, snapshotted at trigger time. Templates
  // resolve `{{automation.state.<key>}}`; the `set_state` output node reads
  // `automation.id` to know which row to merge back into.
  automation: {
    id: string;
    state: Record<string, unknown>;
  };
}

/** A completed-step-ledger row as far as resume seeding cares about it. */
export interface LedgerStepRow {
  nodeId: string;
  status: string;
  output: unknown;
}
