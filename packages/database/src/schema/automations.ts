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
//
// Declared once in `@synap-core/types/automations/flow` (the wire shape every
// client reads); imported here to type the JSONB columns and re-exported so
// pod code keeps importing them from `@synap/database`.

import type {
  AutomationTriggerConfig,
  CommandNodeDef,
  FlowDefinition,
  RunPathTaken,
} from "@synap-core/types/automations/flow";

export type {
  MessageShapePredicate,
  AutomationTriggerConfig,
  AutomationNodeBase,
  TriggerNodeDef,
  CommandNodeDef,
  ConditionNodeDef,
  DelayNodeDef,
  OutputNodeDef,
  LoopNodeDef,
  TransformNodeDef,
  FetchNodeDef,
  QueryNodeDef,
  EntityReadNodeDef,
  RelatedEntitiesNodeDef,
  ComputeNodeDef,
  SelectNodeDef,
  ClaimNodeDef,
  GuardNodeDef,
  MessagesQueryNodeDef,
  RunsQueryNodeDef,
  ProposalsQueryNodeDef,
  SwitchNodeDef,
  NodeErrorHandling,
  SkillNodeDef,
  CapabilityNodeDef,
  SubAutomationNodeDef,
  PlaybookRunNodeDef,
  PlaybookRunWorkerSpec,
  AutomationNode,
  AutomationEdge,
  FlowDefinition,
  RunPathTaken,
} from "@synap-core/types/automations/flow";

/**
 * The LEGACY authored shape of a `command` node, as written by `relay-app`'s
 * shipped flow templates (`src/lib/relay-automations.ts`) before 2026-09-03:
 * a free-text `prompt` and a bare `input` string instead of `promptOverride`
 * and `inputMapping`.
 *
 * This is a FIELD FORK, not a rename: `input` is a `string`, `inputMapping` is
 * a `Record<string,string>`. It did not crash — `resolveInputMapping(undefined)`
 * returns `{}` and an absent `promptOverride` falls back to `commandTitle` — so
 * a run would report SUCCESS while silently dropping BOTH the authored binding
 * and the authored ~40-word prompt.
 *
 * SCOPE — this exists for STORED DOCUMENTS, not for a legacy BEHAVIOUR. The
 * broken path was barely ever reached (upstream defects prune or never fire),
 * so no production data was ever shaped by it and there is nothing to stay
 * bug-compatible with. What DOES exist is `flow_definition` JSONB installed in
 * live pods on 2026-07-17 still spelling these fields the old way, and nothing
 * rewrites an installed flow — `executeAutomationFlow` only ever READS it. So
 * this normalizes on read, and no migration is required. It is deliberately
 * NOT defensive beyond that: no coercion, no shape-guessing, no tolerance for
 * combinations that were never authorable.
 */
export interface LegacyCommandNodeData {
  /** Free-text prompt. Canonical name: `promptOverride`. */
  prompt?: string;
  /** A single unkeyed input binding. Canonical name: `inputMapping`. */
  input?: string;
}

/**
 * Fold a `command` node's legacy authored fields into the canonical contract.
 *
 * THE ONE DOOR. Every reader of `CommandNodeDef["data"]` goes through this —
 * the jobs executor (which dispatches the node) and the sentence round-trip in
 * `@synap/types` (which re-renders it for the editor). A second, local
 * `?? data.prompt` in either place would be the fork growing a third head.
 *
 * It normalizes ON READ rather than rewriting stored rows, because flows are
 * already installed in pods' `automations.flow_definition` carrying the legacy
 * names; fixing only the template source would leave every installed flow
 * broken. No migration is therefore required.
 *
 * `prompt` → `promptOverride` is a plain rename (both are one template string).
 *
 * `input` → `inputMapping` needs a KEY, and the authored form has none by
 * construction. It becomes the single entry `{ input: <template> }`:
 *   • the key is the authored field's own name, so the mapping round-trips and
 *     no new vocabulary is invented for a value the author never named;
 *   • it is what the Intelligence Service receives, both as `context.input` on
 *     the `/api/tasks/execute` payload and as the `Inputs:` prompt line.
 * A single well-known key beats guessing a semantic one (`subjectId`,
 * `entityId`, …) from the template's text — that guess would be a second
 * hand-maintained mapping table, i.e. the same defect one level down.
 *
 * The canonical fields WIN when both are present, so a re-authored node is
 * never overwritten by a stale legacy sibling.
 */
export function normalizeCommandNodeData(
  data: CommandNodeDef["data"] & LegacyCommandNodeData
): CommandNodeDef["data"] {
  // Canonical key present → it wins outright. No empty-object special-casing:
  // an `inputMapping: {}` alongside an `input` was never authorable, so
  // treating `{}` as "absent" would be a guess about a case that cannot occur.
  const inputMapping =
    data.inputMapping ?? (data.input ? { input: data.input } : {});

  return {
    label: data.label,
    commandId: data.commandId,
    commandTitle: data.commandTitle,
    inputMapping,
    promptOverride: data.promptOverride ?? data.prompt,
  };
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
    // "archived" is a terminal soft-delete state (0230): a name-dedup casualty
    // or a retired automation. It is EXCLUDED from the name-uniqueness index
    // (archived rows free the name) and from scheduling/matching (both filter
    // status = 'active'), so it never fires. Not a user-selectable input value —
    // the create/update/list zod enums stay draft|active|paused|error.
    status: text("status", {
      enum: ["draft", "active", "paused", "error", "archived"],
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
    // Name-identity backstop (0230, mirrors playbooks_workspace_name_active_uq /
    // 0227): at-most-one non-archived automation per (workspace | pod-wide,
    // lower(name)). MCP create_automation re-authored the SAME automation into a
    // 2nd row on every run (`Stellar Grant ×4` live) because there was no name
    // identity. Expression index — the create door recovers SQLSTATE 23505 by
    // re-selecting the winner (reuse-by-name), NOT ON CONFLICT (which cannot
    // target an expression index cleanly via drizzle). NULL workspace coalesced
    // to a sentinel UUID so pod-wide rows participate in uniqueness.
    workspaceNameActiveUniq: uniqueIndex("automations_workspace_name_active_uq")
      .on(
        sql`COALESCE(${table.workspaceId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
        sql`lower(${table.name})`
      )
      .where(sql`${table.status} <> 'archived'`),
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

    /**
     * The `events` row that fired this run (0256). NULL for a cron, manual or
     * webhook run — those have no triggering event row at all — and for every
     * run that predates the column.
     *
     * `triggered_by` says WHO and `trigger_payload` says roughly WHAT, but
     * neither is a POINTER: the payload is an envelope the matcher rebuilt, not
     * the immutable audit record with its own actor, `proposal_id`,
     * `session_id` and timestamp. This column is the forward edge of the pair
     * whose reverse edge is `events.session_id` (0241), so a spawned session
     * can be walked back to the fact that caused it and vice-versa.
     *
     * Soft reference, no FK — same reasoning as the sibling `subjectEntityId`:
     * `events` is an append-only spine subject to retention pruning, and run
     * provenance must neither block a prune nor be silently rewritten by one.
     */
    triggerEventId: uuid("trigger_event_id"),

    triggerPayload: jsonb("trigger_payload")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),

    // 'skipped' (Wave 4.V3) — a run whose flow-level precondition evaluated false
    // at start: finalized before any step executes, distinct from a genuine
    // 'completed'. 'blocked_by_policy' — a run whose effect a GOVERNANCE verdict
    // refused (an agent-produced trigger fired a human-owned automation and the
    // producer ladder / a policy floor blocked the THEN-action): a calm governance
    // OUTCOME, not a transport error, so it reads distinct from 'failed'. The DB
    // column is unconstrained `text` (no CHECK; see 0000_baseline_schema.sql), so
    // both are TS-only enum widenings — exactly as automation_step_runs.status
    // added 'skipped' with no migration. Nothing to migrate at the DB level, and
    // schema-coherence validates column existence, not enum membership.
    status: text("status", {
      enum: [
        "running",
        "completed",
        "failed",
        "cancelled",
        "skipped",
        "blocked_by_policy",
        // 'waiting_on_you' (W2 calm) — the run reaper found this run past its
        // window with its session still owing the person an open slot: not
        // orphaned, not failed — waiting on the human. Same TS-only widening.
        "waiting_on_you",
      ],
    })
      .notNull()
      .default("running"),
    errorMessage: text("error_message"),

    stepsCompleted: integer("steps_completed").default(0).notNull(),
    stepsFailed: integer("steps_failed").default(0).notNull(),
    /**
     * AI dispatches (IS commands + agent playbook runs) this run started,
     * bumped as each one happens (0304). Summed over a rolling 24h for the
     * per-automation daily AI cap — see `@synap-core/types/automations`
     * `AI_DISPATCH_GUARDRAILS`.
     */
    aiDispatchCount: integer("ai_dispatch_count").default(0).notNull(),
    outputSummary: jsonb("output_summary").$type<Record<string, unknown>>(),

    // The automation definition this run executed (D3c) —
    // { version, flowDefinition }. Plain JSON snapshot so "what ran" survives
    // later edits to the automation. Stamped once at execution start.
    definitionSnapshot: jsonb("definition_snapshot").$type<{
      version: number;
      flowDefinition: FlowDefinition;
    }>(),
    /**
     * Which edges of the flow this run actually walked (D3d). Written by the
     * executor at the point the branch decisions are already made — NOT
     * re-derivable client-side without a second copy of `markDescendantsSkipped`.
     *
     * - `prunedEdgeIds` — edges on an untaken condition/switch branch (exact:
     *   the executor pruned them by id).
     * - `traversedEdgeIds` — live edges whose SOURCE node executed, i.e. control
     *   was released along them. An edge whose source never ran (the run failed
     *   fast upstream) appears in NEITHER list — that absence is honest
     *   "undecided", not "not taken".
     *
     * NULL for every run that predates this column and for runs finalized by the
     * reaper without executing — render as "unknown", never as "nothing pruned".
     */
    pathTaken: jsonb("path_taken").$type<RunPathTaken>(),
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

    // 'blocked_by_policy' — this step's effect was refused by a governance verdict
    // (confused-deputy guard / agent-ladder deny) rather than breaking: a calm
    // governance outcome, distinct from 'failed'. TS-only widening on this
    // unconstrained `text` column, mirroring how 'skipped' was added (no migration).
    status: text("status", {
      enum: [
        "pending",
        "running",
        "completed",
        "failed",
        "skipped",
        "blocked_by_policy",
      ],
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

    // Per-step token/cost attribution (D3, cheap-now). numeric maps to string
    // in Drizzle. `cost_usd` stays NULL until a provider reports a price —
    // honest-by-design, never a fabricated 0.
    tokensUsed: integer("tokens_used"),
    costUsd: numeric("cost_usd"),

    // ── AI telemetry across the pod↔IS seam (0224) ──────────────────────────
    // Drained from the AI-usage collector when a step made one or more IS
    // generations (see @synap/intelligence-client ai-usage-collector.ts). NULL
    // on a non-AI step, and NULL when the provider reported no usage.
    //
    // `finishReason` is the field that EXPLAINS an empty output: `length` (the
    // maxTokens budget truncated it), `content-filter`, `error`, or `stop` (the
    // model genuinely emitted nothing). Before 0224 an empty generation was
    // unexplainable without SSH-ing to the IS container.
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    finishReason: text("finish_reason"),

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
