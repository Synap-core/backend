/**
 * Automation rows on the wire — `automations`, `automation_runs`,
 * `automation_step_runs` as the pod reads (`Automation`) and inserts
 * (`NewAutomation`) them.
 *
 * The pod's types are inferred from its drizzle tables; this package cannot see
 * those tables, so the wire shape is declared here and `@synap/database` proves
 * it equal to the inferred one (`src/wire-parity/automations.ts`): a column
 * added on one side only fails the database build.
 */

import type {
  AutomationTriggerConfig,
  FlowDefinition,
  RunPathTaken,
} from "./flow.js";

export interface AutomationMetadata {
  [key: string]: unknown;
  tags?: string[];
  version?: number;
  createdVia?: "ai" | "manual" | "template";
  averageExecutionTime?: number;
  suggestedByPattern?: boolean;
  patternConfidence?: number;
  description?: string;
}

export type AutomationRowStatus =
  "active" | "draft" | "paused" | "error" | "archived";
export type AutomationRowTriggerType = "event" | "cron" | "webhook" | "manual";

export interface Automation {
  id: string;
  workspaceId: string | null;
  name: string;
  description: string | null;
  status: AutomationRowStatus;
  triggerType: AutomationRowTriggerType;
  triggerConfig: AutomationTriggerConfig;
  flowDefinition: FlowDefinition;
  createdBy: string;
  version: number;
  errorMessage: string | null;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
  runCount: number;
  successCount: number;
  failureCount: number;
  state: Record<string, unknown>;
  metadata: AutomationMetadata;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewAutomation {
  id?: string;
  workspaceId?: string | null;
  name: string;
  description?: string | null;
  status?: AutomationRowStatus;
  triggerType: AutomationRowTriggerType;
  triggerConfig?: AutomationTriggerConfig;
  flowDefinition?: FlowDefinition;
  createdBy: string;
  version?: number;
  errorMessage?: string | null;
  lastRunAt?: Date | null;
  nextRunAt?: Date | null;
  runCount?: number;
  successCount?: number;
  failureCount?: number;
  state?: Record<string, unknown>;
  metadata?: AutomationMetadata;
  createdAt?: Date;
  updatedAt?: Date;
}

export type AutomationRunRowStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "skipped"
  | "blocked_by_policy"
  | "waiting_on_you";

export interface AutomationDefinitionSnapshot {
  version: number;
  flowDefinition: FlowDefinition;
}

export interface AutomationRun {
  id: string;
  automationId: string;
  workspaceId: string | null;
  status: AutomationRunRowStatus;
  subjectEntityId: string | null;
  triggeredBy: string | null;
  triggerEventId: string | null;
  triggerPayload: Record<string, unknown>;
  stepsCompleted: number;
  stepsFailed: number;
  aiDispatchCount: number;
  outputSummary: Record<string, unknown> | null;
  definitionSnapshot: AutomationDefinitionSnapshot | null;
  pathTaken: RunPathTaken | null;
  replayOf: string | null;
  summaryMessageId: string | null;
  errorMessage: string | null;
  /** A `failed` run whose only failed children stopped at their budget (0361). */
  stopReason: "budget" | null;
  startedAt: Date;
  completedAt: Date | null;
}

export interface NewAutomationRun {
  id?: string;
  automationId: string;
  workspaceId?: string | null;
  status?: AutomationRunRowStatus;
  subjectEntityId?: string | null;
  triggeredBy?: string | null;
  triggerEventId?: string | null;
  triggerPayload?: Record<string, unknown>;
  stepsCompleted?: number;
  stepsFailed?: number;
  aiDispatchCount?: number;
  outputSummary?: Record<string, unknown> | null;
  definitionSnapshot?: AutomationDefinitionSnapshot | null;
  pathTaken?: RunPathTaken | null;
  replayOf?: string | null;
  summaryMessageId?: string | null;
  errorMessage?: string | null;
  stopReason?: "budget" | null;
  startedAt?: Date;
  completedAt?: Date | null;
}

export type AutomationStepRunRowStatus =
  | "running"
  | "completed"
  | "failed"
  | "skipped"
  | "blocked_by_policy"
  | "pending";

export interface AutomationStepRun {
  id: string;
  runId: string;
  nodeId: string;
  commandId: string | null;
  status: AutomationStepRunRowStatus;
  resolvedInputs: Record<string, unknown>;
  output: Record<string, unknown>;
  errorMessage: string | null;
  tokensUsed: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: string | null;
  finishReason: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface NewAutomationStepRun {
  id?: string;
  runId: string;
  nodeId: string;
  commandId?: string | null;
  status?: AutomationStepRunRowStatus;
  resolvedInputs?: Record<string, unknown>;
  output?: Record<string, unknown>;
  errorMessage?: string | null;
  tokensUsed?: number | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  costUsd?: string | null;
  finishReason?: string | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
}
