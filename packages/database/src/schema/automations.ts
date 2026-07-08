/**
 * Automations Schema
 *
 * Workflow automations: trigger → step chain with conditions, commands, and outputs.
 * The flow_definition JSONB is both the visual layout (ReactFlow) and the execution graph.
 *
 * Trigger types:
 *   - event: fires on a Synap event (entities.create.validated, etc.)
 *   - cron: fires on schedule ("0 9 * * MON")
 *   - webhook: fires on inbound webhook
 *   - manual: user-triggered
 *
 * Steps reference intelligence_commands by ID, with input mapping from prior step outputs.
 */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { workspaces } from "./workspaces.js";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

// ── Flow definition types ───────────────────────────────────────────────────

/**
 * AutomationTriggerConfig
 *
 * Typed configuration stored as JSONB on the automations table.
 * The discriminant is `automations.triggerType` (separate column), not a field here.
 *
 * For event triggers, all domain-specific filter fields are declared here so
 * TypeScript sees them without `& Record<string, unknown>` casts.
 */
export interface AutomationTriggerConfig {
  // ── event trigger ──────────────────────────────────────────────────────
  /** Event pattern to match. Supports trailing wildcard: "entities.*", "capture.complete.completed" */
  eventPattern?: string;
  /** Generic key-value filters applied to event.data (dot-notation supported) */
  filters?: Record<string, unknown>;

  // ── cron trigger ───────────────────────────────────────────────────────
  /** Cron expression (e.g. "0 9 * * MON") */
  expression?: string;

  // ── webhook trigger ────────────────────────────────────────────────────
  /** Webhook subscription ID to listen on */
  webhookSubscriptionId?: string;

  // ── channel_message domain filters ────────────────────────────────────
  /** Only match messages in this specific channel */
  channelId?: string;
  /** Filter by message author role ("user" | "assistant" | "any") */
  messageRole?: "user" | "assistant" | "any";

  // ── connector_sync domain filters ─────────────────────────────────────
  /** Only match events from this connector provider (e.g. "google-calendar", "github") */
  provider?: string;
  /** Filter by sync outcome ("success" | "error" | "any") */
  syncStatus?: "success" | "error" | "any";

  // ── relation domain filters ────────────────────────────────────────────
  /** Only match this relation type slug */
  relationType?: string;
  /** Filter by change direction ("create" | "delete" | "any") */
  changeType?: "create" | "delete" | "any";

  // ── proposal domain filters ────────────────────────────────────────────
  /** Filter by proposal lifecycle event ("created" | "approved" | "rejected" | "any") */
  proposalEventType?: "created" | "approved" | "rejected" | "any";

  // ── capture domain filters ─────────────────────────────────────────────
  /** Only fire when a specific profile was captured (e.g. "person", "company", or "any") */
  profileSlug?: string;

  // ── proactive domain filters ───────────────────────────────────────────
  /** Filter by proactive message type ("morning_briefing" | "weekly_digest" | "insight" | "any") */
  proactiveType?: string;

  // ── feed domain filters ────────────────────────────────────────────────
  /** Only fire for items from this archetype ("leads" | "hiring" | "investors" | "trends" | "competitors" | "press") */
  feedArchetype?: string;
  /** Minimum relevance score (0-1) — items below this score are skipped */
  feedMinRelevanceScore?: number;

  // ── focus_session stage filters ──────────────────────────────────────────
  /** Only fire when a focus session advanced INTO this stage (PlaybookStage.key) */
  toStage?: string;

  // ── entity_facet domain filters (Kind + Facets, Wave 1B) ───────────────
  /** Only match facets of this role-profile slug */
  facetProfileSlug?: string;
  /** Only match facets of this role-profile id */
  facetProfileId?: string;
  /** Filter by facet change type ("attach" | "detach" | "status_changed" | "any") */
  facetChangeType?: "attach" | "detach" | "status_changed" | "any";
  /** Only match facets with this status */
  facetStatus?: string;
}

export interface AutomationNodeBase {
  id: string;
  type:
    | "trigger"
    | "command"
    | "condition"
    | "delay"
    | "output"
    | "loop"
    | "transform"
    | "fetch"
    | "query"
    | "messages_query"
    | "switch"
    | "skill"
    | "capability"
    | "sub_automation"
    | "playbook_run";
  position: { x: number; y: number };
}

export interface TriggerNodeDef extends AutomationNodeBase {
  type: "trigger";
  data: {
    triggerType: "event" | "cron" | "webhook" | "manual";
    label: string;
    config: AutomationTriggerConfig;
  };
}

export interface CommandNodeDef extends AutomationNodeBase {
  type: "command";
  data: {
    commandId?: string;
    commandTitle: string;
    /** Maps step inputs to prior outputs. Uses template syntax: {{trigger.payload.entity.name}} */
    inputMapping: Record<string, string>;
    /** Optional prompt override that augments the command's template */
    promptOverride?: string;
  };
}

export interface ConditionNodeDef extends AutomationNodeBase {
  type: "condition";
  data: {
    label: string;
    /** JS-like expression evaluated at runtime: "trigger.payload.entity.metadata.priority === 'high'" */
    expression: string;
    trueLabel?: string;
    falseLabel?: string;
  };
}

export interface DelayNodeDef extends AutomationNodeBase {
  type: "delay";
  data: {
    label?: string;
    /** Duration string: "5m", "1h", "1d" */
    duration: string;
  };
}

export interface OutputNodeDef extends AutomationNodeBase {
  type: "output";
  data: {
    label: string;
    outputType:
      | "notification"
      | "entity_create"
      | "entity_update"
      | "webhook"
      | "channel_message"
      | "session_update";
    config: Record<string, unknown>;
  };
}

export interface LoopNodeDef extends AutomationNodeBase {
  type: "loop";
  data: {
    label: string;
    /** Expression referencing prior step output: "steps.search.output.results" */
    iteratorExpression: string;
    /** Variable name available inside the loop: {{loop.item}} */
    itemVariable: string;
  };
}

export interface TransformNodeDef extends AutomationNodeBase {
  type: "transform";
  data: {
    label: string;
    /** JS-like pipe expression: "{{stepId.output}} | uppercase" */
    expression: string;
    /** Optional per-node error handling */
    errorHandling?: NodeErrorHandling;
  };
}

export interface FetchNodeDef extends AutomationNodeBase {
  type: "fetch";
  data: {
    label: string;
    method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
    url: string;
    headers: Record<string, string>;
    body: string;
    /** Optional per-node error handling */
    errorHandling?: NodeErrorHandling;
  };
}

export interface QueryNodeDef extends AutomationNodeBase {
  type: "query";
  data: {
    label: string;
    profileSlug: string;
    filter: string;
    limit: number;
    /** Optional per-node error handling */
    errorHandling?: NodeErrorHandling;
  };
}

/**
 * Source node that reads stored chat messages for a client. Either reads a
 * channel directly (`channelId`) or resolves the client-comms channel bound to
 * a subject entity (`channels.contextObjectId`). Output:
 * `{ messages: [{ role, content, authorName, createdAt }], channelId, count }`
 * so a downstream loop can iterate `steps.<id>.output.messages`.
 */
export interface MessagesQueryNodeDef extends AutomationNodeBase {
  type: "messages_query";
  data: {
    label: string;
    /** Read messages for the client-comms channel bound to this entity. */
    subjectEntityId?: string;
    /** Read this channel directly (wins over subjectEntityId). */
    channelId?: string;
    /** Most-recent N messages (default 40). */
    limit?: number;
    /** Optional per-node error handling */
    errorHandling?: NodeErrorHandling;
  };
}

export interface SwitchNodeDef extends AutomationNodeBase {
  type: "switch";
  data: {
    label: string;
    /** Template expression to evaluate: "{{trigger.status}}" */
    expression: string;
    /** Cases to match against the resolved expression value */
    cases: Array<{ value: string; label: string }>;
    /** Optional per-node error handling */
    errorHandling?: NodeErrorHandling;
  };
}

/** Per-node error handling configuration */
export interface NodeErrorHandling {
  /** Don't fail the whole run on error — record error and continue */
  continueOnError?: boolean;
  /** Number of retry attempts (0–3) */
  maxRetries?: number;
  /** Milliseconds to wait between retries */
  retryDelay?: number;
}

export interface SkillNodeDef extends AutomationNodeBase {
  type: "skill";
  data: {
    label: string;
    skillId: string;
    skillTitle?: string;
    inputMapping: Record<string, string>;
    errorHandling?: NodeErrorHandling;
  };
}

/**
 * Typed, governed Tool → Verb step (Process builder). The author picks a Tool
 * (`capabilityId` = the tool row id) and a Verb on it (`verbId` = the requiring
 * skill's NAME — see `ToolVerbCatalogEntry.id`). The executor resolves the verb
 * to its backing skill and runs it through the SAME capability gate the `skill`
 * node uses. Display fields (`capabilityName`/`verbLabel`/`verbKind`/`granted`/
 * `execMode`) are authored by the FE for the canvas and not required at run time.
 */
export interface CapabilityNodeDef extends AutomationNodeBase {
  type: "capability";
  data: {
    label?: string;
    /** Tool row id of the selected capability. */
    capabilityId?: string;
    /** Display name of the chosen tool. */
    capabilityName?: string;
    /** Verb id = the requiring skill's name (resolves to the backing skill). */
    verbId?: string;
    verbLabel?: string;
    verbKind?: "read" | "write" | "action";
    granted?: boolean;
    execMode?: "auto" | "propose" | "dry-run";
    /** Maps verb args to prior step outputs ({{steps.id.output}}). */
    inputMapping?: Record<string, string>;
    errorHandling?: NodeErrorHandling;
  };
}

export interface SubAutomationNodeDef extends AutomationNodeBase {
  type: "sub_automation";
  data: {
    label: string;
    automationId: string;
    automationName?: string;
    payloadMapping: Record<string, string>;
    errorHandling?: NodeErrorHandling;
  };
}

export interface PlaybookRunNodeDef extends AutomationNodeBase {
  type: "playbook_run";
  data: {
    label: string;
    /** Resolve the playbook by id, OR by `playbookName` (template-friendly:
     *  a capability references its seeded playbook by stable name). One required. */
    playbookId?: string;
    playbookName?: string;
    /** Maps automation step outputs to playbook params */
    paramsMapping?: Record<string, string>;
    errorHandling?: NodeErrorHandling;
  };
}

export type AutomationNode =
  | TriggerNodeDef
  | CommandNodeDef
  | ConditionNodeDef
  | DelayNodeDef
  | OutputNodeDef
  | LoopNodeDef
  | TransformNodeDef
  | FetchNodeDef
  | QueryNodeDef
  | MessagesQueryNodeDef
  | SwitchNodeDef
  | SkillNodeDef
  | CapabilityNodeDef
  | SubAutomationNodeDef
  | PlaybookRunNodeDef;

export interface AutomationEdge {
  id: string;
  source: string;
  target: string;
  /** "yes" | "no" for condition nodes; case value (e.g. "active") for switch nodes */
  sourceHandle?: string;
  animated?: boolean;
  label?: string;
}

export interface FlowDefinition {
  nodes: AutomationNode[];
  edges: AutomationEdge[];
}

// ── Automations table ───────────────────────────────────────────────────────

export const automations = pgTable(
  "automations",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    // Ownership
    workspaceId: uuid("workspace_id").references(() => workspaces.id, {
      onDelete: "cascade",
    }),
    createdBy: text("created_by").notNull(),

    // Definition
    name: text("name").notNull(),
    description: text("description"),

    // Trigger (exactly one per automation)
    triggerType: text("trigger_type", {
      enum: ["event", "cron", "webhook", "manual"],
    }).notNull(),
    triggerConfig: jsonb("trigger_config")
      .$type<AutomationTriggerConfig>()
      .default({})
      .notNull(),

    // Flow: nodes + edges + layout (single source of truth)
    flowDefinition: jsonb("flow_definition")
      .$type<FlowDefinition>()
      .default({ nodes: [], edges: [] })
      .notNull(),

    // Status
    status: text("status", {
      enum: ["draft", "active", "paused", "error"],
    })
      .notNull()
      .default("draft"),
    errorMessage: text("error_message"),

    // Execution stats
    lastRunAt: timestamp("last_run_at", { mode: "date", withTimezone: true }),
    nextRunAt: timestamp("next_run_at", { mode: "date", withTimezone: true }),
    runCount: integer("run_count").default(0).notNull(),
    successCount: integer("success_count").default(0).notNull(),
    failureCount: integer("failure_count").default(0).notNull(),

    // Per-automation persistent state (watermark/cursor). Read into the run
    // context so templates can resolve {{automation.state.<key>}}; written back
    // by an explicit `output` node with outputType "set_state" (author-controlled,
    // never automatic). Concurrent runs last-writer-merge via jsonb `||`.
    state: jsonb("state")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),

    // Metadata
    metadata: jsonb("metadata")
      .$type<{
        tags?: string[];
        version?: number;
        createdVia?: "ai" | "manual" | "template";
        averageExecutionTime?: number;
        suggestedByPattern?: boolean;
        patternConfidence?: number;
        description?: string;
        [key: string]: unknown;
      }>()
      .default({})
      .notNull(),

    // Timestamps
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    workspaceIdx: index("automations_workspace_id_idx").on(table.workspaceId),
    statusIdx: index("automations_status_idx").on(table.status),
    triggerTypeIdx: index("automations_trigger_type_idx").on(table.triggerType),
    nextRunAtIdx: index("automations_next_run_at_idx").on(table.nextRunAt),
    createdByIdx: index("automations_created_by_idx").on(table.createdBy),
  })
);

export type Automation = typeof automations.$inferSelect;
export type NewAutomation = typeof automations.$inferInsert;
export const insertAutomationSchema = createInsertSchema(automations);
export const selectAutomationSchema = createSelectSchema(automations);

// ── Automation runs ─────────────────────────────────────────────────────────

export const automationRuns = pgTable(
  "automation_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    automationId: uuid("automation_id")
      .notNull()
      .references(() => automations.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id"),
    triggeredBy: text("triggered_by"), // userId or "system"

    triggerPayload: jsonb("trigger_payload")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),

    status: text("status", {
      enum: ["running", "completed", "failed", "cancelled"],
    })
      .notNull()
      .default("running"),
    errorMessage: text("error_message"),

    stepsCompleted: integer("steps_completed").default(0).notNull(),
    stepsFailed: integer("steps_failed").default(0).notNull(),
    outputSummary: jsonb("output_summary").$type<Record<string, unknown>>(),

    startedAt: timestamp("started_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    completedAt: timestamp("completed_at", {
      mode: "date",
      withTimezone: true,
    }),
  },
  (table) => ({
    automationIdx: index("automation_runs_automation_id_idx").on(
      table.automationId
    ),
    statusIdx: index("automation_runs_status_idx").on(table.status),
    startedAtIdx: index("automation_runs_started_at_idx").on(table.startedAt),
  })
);

export type AutomationRun = typeof automationRuns.$inferSelect;
export type NewAutomationRun = typeof automationRuns.$inferInsert;

// ── Automation step runs ────────────────────────────────────────────────────

export const automationStepRuns = pgTable(
  "automation_step_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => automationRuns.id, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(), // matches AutomationNode.id in flow_definition

    commandId: uuid("command_id"), // FK to intelligence_commands (null for non-command steps)

    status: text("status", {
      enum: ["pending", "running", "completed", "failed", "skipped"],
    })
      .notNull()
      .default("pending"),

    resolvedInputs: jsonb("resolved_inputs")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    output: jsonb("output")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    errorMessage: text("error_message"),

    startedAt: timestamp("started_at", { mode: "date", withTimezone: true }),
    completedAt: timestamp("completed_at", {
      mode: "date",
      withTimezone: true,
    }),
  },
  (table) => ({
    runIdx: index("automation_step_runs_run_id_idx").on(table.runId),
  })
);

export type AutomationStepRun = typeof automationStepRuns.$inferSelect;
export type NewAutomationStepRun = typeof automationStepRuns.$inferInsert;

// ── Drizzle relations (enables db.query.automations) ────────────────────────

export const automationsRelations = relations(automations, ({ many }) => ({
  runs: many(automationRuns),
}));

export const automationRunsRelations = relations(
  automationRuns,
  ({ one, many }) => ({
    automation: one(automations, {
      fields: [automationRuns.automationId],
      references: [automations.id],
    }),
    stepRuns: many(automationStepRuns),
  })
);

export const automationStepRunsRelations = relations(
  automationStepRuns,
  ({ one }) => ({
    run: one(automationRuns, {
      fields: [automationStepRuns.runId],
      references: [automationRuns.id],
    }),
  })
);
