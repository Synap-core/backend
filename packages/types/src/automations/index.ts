/**
 * Automation Types
 *
 * Workflow automations: trigger → step chain DAG.
 * Re-exports database types + adds domain-specific utilities.
 */

// ── Database types ──────────────────────────────────────────────────────────

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
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type AutomationStepStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped";

export type AutomationNodeType =
  | "trigger"
  | "command"
  | "query"
  | "condition"
  | "delay"
  | "output"
  | "loop"
  | "transform"
  | "fetch"
  | "switch"
  | "skill"
  | "sub_automation";

export type AutomationOutputType =
  | "notification"
  | "entity_create"
  | "entity_update"
  | "webhook"
  | "channel_message";

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
