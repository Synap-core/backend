/**
 * Focus Sessions Schema
 *
 * A focus session is a goal-bound user work session — a discrete "working
 * mode" where the user (and optionally IS agents) collaborate toward a
 * stated objective.
 *
 * This is WORKFLOW-SIDE infrastructure, not data-side. It has no relationship
 * to the `sessions` table, which is IS memory/compaction machinery.
 *
 * Lifecycle: active → paused ↔ active → closed
 */

import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  jsonb,
  integer,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export enum FocusSessionStatus {
  ACTIVE = "active",
  PAUSED = "paused",
  CLOSED = "closed",
}

export const focusSessions = pgTable(
  "focus_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Which workspace this session is scoped to. */
    workspaceId: text("workspace_id").notNull(),
    /** Owner — the human who started it. */
    userId: text("user_id").notNull(),
    /**
     * IS correlation ID — set when IS takes over the session.
     * UNIQUE nullable: one session per IS correlation context.
     */
    correlationId: text("correlation_id"),
    /** "What are you trying to accomplish?" */
    goal: text("goal").notNull(),
    /** Current lifecycle state. */
    status: text("status", {
      enum: ["active", "paused", "closed"],
    })
      .notNull()
      .default("active"),
    /** Which session template was used to bootstrap this session (optional). */
    templateId: text("template_id"),
    /**
     * The Playbook this session was instantiated from (config → runtime link).
     * FK enforced at the DB level (migration 0126, ON DELETE SET NULL).
     * Supersedes the loose `templateId` text stub.
     */
    playbookId: uuid("playbook_id"),
    /**
     * Expected deliverables declared at session start.
     * Shape: [{ kind: string, label: string, icon?: string }]
     */
    expectedOutputs: jsonb("expected_outputs").default([]),
    /**
     * The channel room for this session.
     * Nullable — created on session start and wired back via update.
     */
    channelId: uuid("channel_id"),
    /** 0-100 progress, updated by IS. Null until IS sets it. */
    progress: integer("progress"),
    /** Agent IDs invited to this session. */
    agentIds: text("agent_ids").array().default([]),
    /** Set when the session transitions to `closed`. */
    closedAt: timestamp("closed_at", { withTimezone: true }),
    /** Context report: AI's understanding of task, domain, constraints. */
    contextReport: jsonb("context_report"),
    /** Plan report: Decomposed plan and execution approach. */
    planReport: jsonb("plan_report"),
    /** Execution log: Step-by-step execution transcript. */
    executionLog: jsonb("execution_log"),
    /** Verification report: Test results and verification outcomes. */
    verificationReport: jsonb("verification_report"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    // Partial unique index — only one session per IS correlation context.
    correlationIdIdx: uniqueIndex("idx_focus_sessions_correlation_id").on(
      table.correlationId
    ),
    workspaceIdIdx: index("idx_focus_sessions_workspace_id").on(
      table.workspaceId
    ),
    userIdIdx: index("idx_focus_sessions_user_id").on(table.userId),
    statusIdx: index("idx_focus_sessions_status").on(table.status),
    playbookIdIdx: index("idx_focus_sessions_playbook_id").on(table.playbookId),
    // Partial unique index: one active session per channel.
    // Also serves as the covering index for channels.ts per-message lookup
    // (WHERE channel_id = ? AND status = 'active'). NULL channel_id excluded
    // so CLI/API sessions without a channel remain unconstrained.
    activeChannelIdx: uniqueIndex("idx_focus_sessions_active_channel")
      .on(table.channelId)
      .where(sql`status = 'active' AND channel_id IS NOT NULL`),
  })
);

export type FocusSession = typeof focusSessions.$inferSelect;
export type NewFocusSession = typeof focusSessions.$inferInsert;
export const insertFocusSessionSchema = createInsertSchema(focusSessions);
export const selectFocusSessionSchema = createSelectSchema(focusSessions);
