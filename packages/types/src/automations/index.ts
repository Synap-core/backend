/**
 * Automation Types
 *
 * Workflow automations: trigger → step chain DAG.
 * Re-exports database types + adds domain-specific utilities.
 */

// ── Database types ──────────────────────────────────────────────────────────

// Type-only — erased at build, so no drizzle/postgres runtime import reaches
// browser/Electron consumers (see the NOTE below).
import type { AutomationNodeBase, OutputNodeDef } from "@synap/database";

export type {
  Automation,
  NewAutomation,
  AutomationRun,
  NewAutomationRun,
  AutomationStepRun,
  NewAutomationStepRun,
  // Flow definition types
  FlowDefinition,
  AutomationNode,
  AutomationEdge,
  AutomationNodeBase,
  AutomationTriggerConfig,
  // Node type definitions
  TriggerNodeDef,
  CommandNodeDef,
  ConditionNodeDef,
  DelayNodeDef,
  OutputNodeDef,
  LoopNodeDef,
} from "@synap/database";

// NOTE: Zod schemas (insertAutomationSchema, selectAutomationSchema)
// intentionally NOT re-exported — they pull in postgres/drizzle which breaks
// browser/Electron builds. Backend consumers should import directly from
// @synap/database.

// ── Domain types ────────────────────────────────────────────────────────────

export type AutomationStatus = "draft" | "active" | "paused" | "error";

export type AutomationTriggerType = "event" | "cron" | "webhook" | "manual";

export type AutomationRunStatus =
  "running" | "completed" | "failed" | "cancelled";

export type AutomationStepStatus =
  "pending" | "running" | "completed" | "failed" | "skipped";

/**
 * DERIVED from the executor's own node/output definitions — never hand-written.
 *
 * Both of these WERE hand-maintained copies and both had already drifted:
 * `AutomationNodeType` listed 14 of the schema's 23 node types, and
 * `AutomationOutputType` listed 6 of 11 — silently omitting `facet_attach`,
 * `facet_update`, `facet_detach`, `relation_create` and `set_state`, so nothing
 * typed against it could express five output kinds the executor supports.
 *
 * A second copy of a union the applier already owns is a fork with a countdown;
 * deriving means teaching the executor a new node type updates this in place.
 */
export type AutomationNodeType = AutomationNodeBase["type"];

export type AutomationOutputType = OutputNodeDef["data"]["outputType"];

// ── API input types ─────────────────────────────────────────────────────────

/** Input for creating an automation via the tRPC API. */
export interface CreateAutomationInput {
  name: string;
  description?: string;
  triggerType: AutomationTriggerType;
  triggerConfig: Record<string, unknown>;
  flowDefinition: {
    nodes: Array<Record<string, unknown>>;
    edges: Array<Record<string, unknown>>;
  };
  status?: AutomationStatus;
  metadata?: Record<string, unknown>;
  agentUserId?: string;
  source?: "user" | "ai" | "intelligence" | "system" | "agent";
}

// ── Execution context (chain tracking) ──────────────────────────────────────

/**
 * Metadata injected into events emitted by automation execution.
 * Used to prevent circular triggers and track execution chains.
 */
export interface AutomationExecutionContext {
  /** The run that emitted this event */
  automationRunId: string;
  /** The automation definition ID */
  automationId: string;
  /** How deep in the automation→event→automation chain (starts at 1) */
  chainDepth: number;
  /** The run that triggered this chain (if cascading) */
  rootRunId?: string;
  /** All automation IDs in the current chain (for cycle detection) */
  chainAutomationIds?: string[];
}

/**
 * Maximum chain depth before the trigger matcher refuses to create a new run.
 * Prevents infinite loops where automation A triggers automation B triggers A.
 */
export const MAX_AUTOMATION_CHAIN_DEPTH = 3;

// ── Rule "sentence" value-model + bidirectional converters ──────────────────
//
// Zero imports, pure functions — safe for browser/Electron/Node/CLI. Lives here
// (not in synap-app) so the backend's server-side rule doors can reach it;
// `@synap-core/automation-intent` re-exports it, so its consumers are unchanged.
export {
  buildEventPattern,
  buildCronExpression,
  toBackendTrigger,
  toFlowDefinition,
  parseCron,
  triggerToSentence,
  flowToSentenceAction,
  flowToConditions,
} from "./sentence.js";
export type {
  ActionType,
  SentenceAction,
  TriggerSubjectCategory,
  ActionVerb,
  ConditionOperator,
  ConditionRow,
  CronFrequency,
  SentenceTrigger,
  RuleSentenceValue,
  RuleFlowNode,
  RuleFlowEdge,
  RuleFlowDefinition,
  BackendTrigger,
} from "./sentence.js";
