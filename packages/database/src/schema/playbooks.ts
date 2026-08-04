/**
 * Playbooks Schema — session templates (CONFIGURATION)
 *
 * A Playbook is a *template* of a Session: a goal (with params), the
 * capabilities (tools/skills/commands) the AI may use, an input-strategy
 * ("what to check"), a channel spec (the room), expected outputs, an optional
 * schedule, and an executor target (IS / BYOA / hybrid).
 *
 * CONFIGURATION, not entity DATA — playbooks live in their own table; a runtime
 * `focus_sessions` row is an *instance* of a playbook (focus_sessions.playbook_id).
 * The richer JSONB shapes (params/input_strategy/channel_spec/expected_outputs/
 * schedule) conform to the contracts in @synap/playbooks; they are stored loosely
 * here and interpreted at the domain/API boundary.
 *
 * Design doc: team/platform/playbooks-capability-substrate.mdx
 */

import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

/** Which "hands" run this playbook. Mirrors @synap/playbooks ExecutorRef. */
export type PlaybookExecutorRef = "is-agent" | "external-agent" | "hybrid";

/** Sentinel used when workspace_id IS NULL so pod-wide names participate in uniqueness. */
export const PLAYBOOK_POD_WIDE_WORKSPACE_SENTINEL =
  "00000000-0000-0000-0000-000000000000";

export const playbooks = pgTable(
  "playbooks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Nullable = pod-wide. */
    workspaceId: uuid("workspace_id"),
    /** Owning principal — human user id or agent-user id. */
    createdBy: text("created_by").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /** Goal template (reuses the intelligence_commands @{arg:…} grammar). */
    goalTemplate: text("goal_template").notNull(),
    /** PlaybookParam[] — typed inputs. */
    params: jsonb("params").notNull().default([]),
    /** InputStrategy — the dynamic "what to check" set. */
    inputStrategy: jsonb("input_strategy").notNull().default({ kind: "none" }),
    /** ChannelSpec — the session room (type + members + reaction mode). */
    channelSpec: jsonb("channel_spec").notNull().default({}),
    /** ExpectedOutput[] — declared deliverables. */
    expectedOutputs: jsonb("expected_outputs").notNull().default([]),
    /** PlaybookStage[] — first-class ordered stages (empty = progress-only). */
    stages: jsonb("stages").notNull().default([]),
    /**
     * Monotonic definition version (D3c). Bumped on a governed update that
     * changes a definition-affecting field (goalTemplate/stages/params/
     * inputStrategy/channelSpec/expectedOutputs). A run snapshots this into
     * playbook_runs.definitionSnapshot so "what ran" can be diffed against
     * "the definition today".
     */
    version: integer("version").notNull().default(1),
    /** PlaybookSchedule | null — { cron, enabled }. */
    schedule: jsonb("schedule"),
    executor: text("executor", {
      enum: ["is-agent", "external-agent", "hybrid"],
    })
      .$type<PlaybookExecutorRef>()
      .notNull()
      .default("is-agent"),
    status: text("status", {
      enum: ["draft", "active", "paused", "archived"],
    })
      .notNull()
      .default("draft"),
    /**
     * The automation that drives this playbook's flow.
     * Process North Star Wave 0: links a playbook to a specific automation
     * so it can be triggered or governed by that automation.
     * No hard FK constraint — enforced at the application layer.
     * Added by 0139_process_subject_spine.sql.
     */
    flowAutomationId: uuid("flow_automation_id"),
    /**
     * Subject profile selector — which entity profile this playbook operates on.
     * Shape: { profileSlug: string; filter?: Record<string, unknown> }
     * Nullable. Process North Star Wave 0.
     * Added by 0139_process_subject_spine.sql.
     */
    subjectProfile: jsonb("subject_profile"),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    workspaceIdIdx: index("idx_playbooks_workspace_id").on(table.workspaceId),
    statusIdx: index("idx_playbooks_status").on(table.status),
    flowAutomationIdIdx: index("idx_playbooks_flow_automation_id").on(
      table.flowAutomationId
    ),
    // TOCTOU race backstop (0227): at-most-one non-archived playbook per
    // (workspace | pod-wide, lower(name)). Expression index — app recovers
    // SQLSTATE 23505 by re-selecting the winner (not ON CONFLICT, which cannot
    // target expression indexes cleanly via drizzle). Pairs with
    // 0227_playbooks_workspace_name_unique.sql.
    workspaceNameActiveUniq: uniqueIndex("playbooks_workspace_name_active_uq")
      .on(
        sql`COALESCE(${table.workspaceId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
        sql`lower(${table.name})`
      )
      .where(sql`${table.status} <> 'archived'`),
  })
);

export type Playbook = typeof playbooks.$inferSelect;
export type NewPlaybook = typeof playbooks.$inferInsert;
export const insertPlaybookSchema = createInsertSchema(playbooks);
export const selectPlaybookSchema = createSelectSchema(playbooks);
