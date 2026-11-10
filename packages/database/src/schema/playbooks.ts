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
  primaryKey,
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
     * SessionCriterion[] — binary acceptance criteria copied onto every session
     * instantiated from this playbook (with each stage's own, see
     * `collectPlaybookCriteria`). Added by 0267.
     */
    criteria: jsonb("criteria").notNull().default([]),
    /**
     * The ONE list of what a run of this playbook may use beyond its class
     * floor (0419; plan 08e4fba7 decisions 3 and 4): run tools, intent slugs,
     * capabilities, by name (`@synap/playbooks` `run-tools.ts`). "Only these":
     * nothing else is offered. Each stage may narrow it (`PlaybookStage.tools`).
     *
     * 0419 folded into it the four declarations it replaces: `required_intents`
     * (the column stays one release for a rollback, unread and unwritten), the
     * `grants` links' targets, `stages[].grants` and the space's `taskIntents`.
     */
    tools: jsonb("tools").notNull().default([]),
    /**
     * The rules this playbook follows (0411): an ordered list of
     * `{ ref: "kind:<slug>" | "skill:<slug>", label?, when?, where? }`, refs
     * never ids (`@synap-core/types/guidance`). Rendered at run time from each
     * ref's CURRENT, person-approved version under "Rules this playbook
     * follows" (`services/playbooks/playbook-guidance.ts`).
     */
    guidance: jsonb("guidance").notNull().default([]),
    /**
     * WHO runs this playbook by default (0416) — a `PlaybookRunner`
     * (`@synap/playbooks`): one choice or an ordered list of fallbacks (an
     * agent, a role, an engine, Synap AI). NULL = nobody named. A choice made
     * at Run beats it; it beats the person's remembered choice.
     */
    runner: jsonb("runner"),
    /**
     * The tools every step needs, by capability key (0416), checked against
     * the runner's computer before a step is handed over. Each stage adds its
     * own (`PlaybookStage.requires`).
     */
    requires: jsonb("requires").notNull().default([]),
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
     * What this playbook is a template OF (migration 0240).
     *
     * `"session"` — today's meaning: a template of ONE work unit (goal, params,
     * capabilities, room, expected outputs, executor).
     * `"project"` — an ENGAGEMENT BLUEPRINT: its ordered `stages` reference
     * session-scoped playbooks, and automations attach via the existing
     * `automation --member_of--> playbook` edge.
     *
     * ONE object with two scopes rather than a second template table: wherever a
     * higher template is a separate object it ends up embedding a COPY of the
     * lower one, and the two drift. Because a playbook is already addressable by
     * id, a blueprint can REFERENCE its stage playbooks instead — with the
     * instance snapshotting at launch, so an in-flight engagement never mutates
     * when someone edits a playbook.
     *
     * NULL reads as `"session"` — no existing playbook reclassifies itself.
     */
    scope: text("scope").$type<"session" | "project">(),
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

/**
 * EVERY KEPT VERSION of a playbook's definition (0416) — what a step that IS a
 * playbook (`PlaybookStage.uses`) runs when it is pinned at a version that is
 * no longer the live one. Before it, a playbook kept only its current
 * definition and an integer `version`; a pin could not be honoured.
 *
 * One row per (playbook, version), written in the same transaction as the
 * write that sets `playbooks.version` (`recordPlaybookVersion`,
 * @synap/api `services/playbooks/playbook-versions.ts`); a tripwire scans every
 * writer of `playbooks`. Append-only: a version, once kept, never changes.
 * `definition` holds the definition fields (`PLAYBOOK_VERSION_FIELDS`).
 * Pods that booted before 0416 keep each playbook's version of that day.
 */
export const playbookVersions = pgTable(
  "playbook_versions",
  {
    playbookId: uuid("playbook_id").notNull(),
    version: integer("version").notNull(),
    definition: jsonb("definition").$type<Record<string, unknown>>().notNull(),
    /** Who wrote this version (the playbook's writer at the time). */
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.playbookId, table.version] }),
  })
);

export type PlaybookVersionRow = typeof playbookVersions.$inferSelect;
