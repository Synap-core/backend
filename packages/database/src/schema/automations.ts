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
  numeric,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
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
  //
  // EXAMPLE — fire when a `client` role is attached to any entity (e.g. to
  // kick off a client-onboarding playbook):
  //   {
  //     triggerType: "event",
  //     config: {
  //       eventPattern: "entity_facet.*",   // attach/update/detach doors + generic verbs
  //       facetProfileSlug: "client",        // only the client role
  //       facetChangeType: "attach",         // only on attach (not update/detach)
  //     }
  //   }
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
    | "playbook_run"
    | "entity_read"
    | "related_entities"
    | "compute"
    | "select"
    | "claim"
    | "guard";
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
      | "facet_attach"
      | "facet_update"
      | "facet_detach"
      | "relation_create"
      | "webhook"
      | "channel_message"
      | "session_update"
      | "set_state";
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

/** Read one entity by id within the automation's workspace/pod lens. */
export interface EntityReadNodeDef extends AutomationNodeBase {
  type: "entity_read";
  data: {
    label?: string;
    entityId: string;
    errorHandling?: NodeErrorHandling;
  };
}

/** Traverse a bounded set of generic graph relations and project counterparties. */
export interface RelatedEntitiesNodeDef extends AutomationNodeBase {
  type: "related_entities";
  data: {
    label?: string;
    entityId: string;
    direction?: "outbound" | "inbound" | "both";
    relationTypes?: string[];
    propertyEquals?: Record<string, unknown>;
    /** Match any supplied property/value set (OR across predicates). */
    propertyAnyEquals?: Record<string, unknown[]>;
    /** Exclude a known related entity (for example the trigger entity itself). */
    excludeEntityId?: string;
    limit?: number;
    errorHandling?: NodeErrorHandling;
  };
}

/** Finite numeric operations over literal or template-bound scalar values. */
export interface ComputeNodeDef extends AutomationNodeBase {
  type: "compute";
  data: {
    label?: string;
    operation: "add" | "subtract" | "multiply" | "divide" | "coalesce" | "now";
    left?: unknown;
    right?: unknown;
    /** First finite numeric value wins; useful for declarative fee precedence. */
    values?: unknown[];
    errorHandling?: NodeErrorHandling;
  };
}

/** Choose one typed value from a boolean produced by a prior deterministic step. */
export interface SelectNodeDef extends AutomationNodeBase {
  type: "select";
  data: {
    label?: string;
    when: unknown;
    ifTrue: unknown;
    ifFalse: unknown;
    errorHandling?: NodeErrorHandling;
  };
}

/**
 * Atomically reserves a durable, namespace-scoped key. This is a generic
 * workflow primitive for one-time policy decisions (not a CRM concept): the
 * run that first claims a key observes `claimed: true`; subsequent runs see
 * `claimed: false`. Re-delivery of the owning run remains `claimed: true`.
 * Claims are released when that run terminally fails, so the same idempotent
 * graph can be retried without wedging a record.
 */
export interface ClaimNodeDef extends AutomationNodeBase {
  type: "claim";
  data: {
    label?: string;
    namespace: string;
    key: string;
    errorHandling?: NodeErrorHandling;
  };
}

/** Structured, fail-closed business guard with an actionable retry reason. */
export interface GuardNodeDef extends AutomationNodeBase {
  type: "guard";
  data: {
    label?: string;
    checks: Array<{
      path: string;
      exists?: boolean;
      equals?: unknown;
      notEquals?: unknown;
      arrayIncludes?: unknown;
      lengthEquals?: number;
      numberGte?: number;
      numberLte?: number;
      /** At least one path/literal pair must match. */
      anyOf?: Array<{ path: string; equals: unknown }>;
      message: string;
    }>;
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
  | EntityReadNodeDef
  | RelatedEntitiesNodeDef
  | ComputeNodeDef
  | SelectNodeDef
  | ClaimNodeDef
  | GuardNodeDef
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
  /**
   * Optional flow-level precondition (Wave 4.V3). A single comparison expression
   * (same grammar as a `condition` node — e.g. "trigger.payload.stage === 'won'")
   * evaluated against the run context BEFORE any step runs. When it evaluates
   * false the run finalizes `skipped` (no side effect, no session) instead of
   * fake-`completed`, so a precondition-gated run is honestly distinguishable
   * from one that did work. Absent/empty → the flow always runs.
   */
  precondition?: string;
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

    // Monotonic definition version (D3c). Bumped on a governed update that
    // changes a definition-affecting field (flowDefinition/triggerType/
    // triggerConfig); a run snapshots it into automation_runs.definitionSnapshot.
    // Distinct from the legacy free-form metadata.version bag.
    version: integer("version").notNull().default(1),

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
    /** Entity the run was explicitly launched about, when applicable. */
    subjectEntityId: uuid("subject_entity_id"),
    triggeredBy: text("triggered_by"), // userId or "system"

    triggerPayload: jsonb("trigger_payload")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),

    // 'skipped' (Wave 4.V3) — a run whose flow-level precondition evaluated false
    // at start: finalized before any step executes, distinct from a genuine
    // 'completed'. The DB column is unconstrained `text` (no CHECK; see
    // 0000_baseline_schema.sql), so this is a TS-only enum widening — exactly as
    // automation_step_runs.status added 'skipped' with no migration. Nothing to
    // migrate at the DB level, and schema-coherence validates column existence,
    // not enum membership.
    status: text("status", {
      enum: ["running", "completed", "failed", "cancelled", "skipped"],
    })
      .notNull()
      .default("running"),
    errorMessage: text("error_message"),

    stepsCompleted: integer("steps_completed").default(0).notNull(),
    stepsFailed: integer("steps_failed").default(0).notNull(),
    outputSummary: jsonb("output_summary").$type<Record<string, unknown>>(),

    // The automation definition this run executed (D3c) —
    // { version, flowDefinition }. Plain JSON snapshot so "what ran" survives
    // later edits to the automation. Stamped once at execution start.
    definitionSnapshot: jsonb("definition_snapshot").$type<{
      version: number;
      flowDefinition: FlowDefinition;
    }>(),
    /** Soft self-reference to the run this one replays (schema support only). */
    replayOf: uuid("replay_of"),

    /**
     * The one run-narration summary message posted for this run (Wave 3.N1).
     * NULL until `postRunSummary` claims it; the claim
     * (`SET summary_message_id=$mid WHERE id=$runId AND summary_message_id IS NULL`)
     * is the exactly-once guard so the finalizer and the reaper can never both
     * post for the same terminal run. Soft ref to `messages.id`.
     */
    summaryMessageId: uuid("summary_message_id"),

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
    subjectEntityIdIdx: index("automation_runs_subject_entity_id_idx").on(
      table.subjectEntityId
    ),
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

    // Per-step token/cost attribution (D3, cheap-now). Populated only where node
    // execution surfaces usage; NULL otherwise (IS-side telemetry, out of scope
    // for Wave 1). numeric maps to string in Drizzle.
    tokensUsed: integer("tokens_used"),
    costUsd: numeric("cost_usd"),

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

// ── Durable workflow claims ─────────────────────────────────────────────────

/**
 * A compact, generic exactly-one decision ledger. It deliberately stores no
 * domain data: templates choose their namespace/key and use the boolean result
 * in the graph. The composite unique index is the concurrency boundary.
 */
export const automationClaims = pgTable(
  "automation_claims",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id"),
    namespace: text("namespace").notNull(),
    claimKey: text("claim_key").notNull(),
    ownerRunId: uuid("owner_run_id")
      .notNull()
      .references(() => automationRuns.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    workspaceNamespaceKeyUniq: uniqueIndex(
      "automation_claims_workspace_namespace_key_uniq"
    ).on(
      sql`COALESCE(${table.workspaceId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      table.namespace,
      table.claimKey
    ),
  })
);

export type AutomationClaim = typeof automationClaims.$inferSelect;

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
