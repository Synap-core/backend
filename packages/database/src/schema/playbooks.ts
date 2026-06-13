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
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

/** Which "hands" run this playbook. Mirrors @synap/playbooks ExecutorRef. */
export type PlaybookExecutorRef = "is-agent" | "external-agent" | "hybrid";

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
  })
);

export type Playbook = typeof playbooks.$inferSelect;
export type NewPlaybook = typeof playbooks.$inferInsert;
export const insertPlaybookSchema = createInsertSchema(playbooks);
export const selectPlaybookSchema = createSelectSchema(playbooks);
