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
 *   (or: active/paused → stale, when the focus-session reaper — C8 lifecycle
 *   hygiene — finds no activity for REAPER_STALE_HOURS. Non-destructive:
 *   `stale` is not terminal, the row can still be completed/reopened like any
 *   other session; it only stops counting as a live "in progress" session.)
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
  FORMING = "forming",
  SCHEDULED = "scheduled",
  FAILED = "failed",
  CANCELLED = "cancelled",
  /** Auto-set by the focus-session reaper (C8): active/paused with no
   *  `updatedAt` activity for REAPER_STALE_HOURS. Not terminal — see the
   *  lifecycle note above. */
  STALE = "stale",
}

export const focusSessions = pgTable(
  "focus_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * Which workspace this session is scoped to.
     * Nullable since Phase 4: a project-scoped session spans workspaces and
     * is anchored by projectId instead. Workspace-scoped sessions keep this
     * non-null (enforced at the application layer, not DB).
     */
    workspaceId: text("workspace_id"),
    /**
     * Project this session is scoped to (project-centric-scope Phase 4).
     * When set, the session belongs to a project and may span multiple
     * workspaces. Mutually exclusive with a workspace-only scope: at least one
     * of workspaceId / projectId should be non-null (enforced by the caller).
     *
     * Points at the `projects` TABLE. (This comment previously said "FK to
     * entities.id — projects are entities with profileSlug='project'"; that was
     * written before migration 0151, which consolidated entity-based projects
     * into the table and deactivated the `project` profile. The table is the
     * canonical project.)
     */
    projectId: uuid("project_id"),
    /**
     * How this session came to exist — the TYPED replacement for sniffing
     * `metadata.automationId` / `metadata.source` (migration 0240).
     *
     * `"automation"` sessions are an automation run wearing a session's shape;
     * they belong on the automation ledger, not in a list of work sessions.
     * Deriving that from untyped JSONB in the UI meant every list and filter
     * re-computed the distinction, and none could group by it. Values mirror the
     * app-level `FocusSessionOrigin` union — deliberately not a DB enum so the
     * vocabulary can extend without a migration.
     *
     * `"human"` is a session a PERSON started at a door with no agent identity.
     * It is the value the triage lens keys on by absence: agent/automation/
     * inbound sessions need a look, a session the operator opened themselves
     * does not. Before it existed every human-started session read back as
     * `"agent"`, so the lens could not tell the two apart at all.
     *
     * NULL means "not yet classified": readers fall back to the legacy metadata
     * sniff, so a row written by an un-migrated writer still resolves correctly.
     */
    origin: text("origin").$type<
      "playbook" | "automation" | "agent" | "human"
    >(),
    /**
     * The entity this session is "about" — the subject spine anchor.
     * Process North Star Wave 0: links a session to a specific subject entity
     * (e.g. a person, company, or deal) so playbook flows can act on it.
     * FK enforced at the application layer (no hard DB constraint to avoid
     * ordering issues). Added by 0139_process_subject_spine.sql.
     */
    subjectEntityId: uuid("subject_entity_id"),
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
      enum: [
        "active",
        "paused",
        "closed",
        "forming",
        "scheduled",
        "failed",
        "cancelled",
        "stale",
      ],
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
     * Shape: ExpectedOutput[] (@synap/playbooks) — [{ kind, label, icon?,
     * status?: "pending" | "done", claimedDone?: boolean, satisfiedByProposalId? }]
     * `status` is a per-item lifecycle flag (defaults to "pending" when omitted)
     * and is stamped by ONE door only — `satisfyExpectedOutputs`, on approval of
     * a session-scoped proposal. `claimedDone` is the AGENT's own (unverified)
     * mark; the two are deliberately different fields
     * — a shape-within-jsonb addition, no column/migration change.
     */
    expectedOutputs: jsonb("expected_outputs").default([]),
    /**
     * The channel room for this session.
     * Nullable — created on session start and wired back via update.
     */
    channelId: uuid("channel_id"),
    /** 0-100 progress, updated by IS. Null until IS sets it. */
    progress: integer("progress"),
    /**
     * Active playbook stage key (PlaybookStage.key). Seeded from the playbook's
     * first stage on instantiation; advanced via the update doors. Stays NULL
     * for stageless playbooks (progress-only) — NEVER becomes NOT NULL.
     */
    currentStage: text("current_stage"),
    /**
     * Agent IDs invited to this session — an INVITE LIST, not a participant set.
     * NOTHING appends to it after create/update: an agent that joins and works
     * never lands here. The authoritative participant set is DERIVED from the
     * proposals filed against the session (`trpc.focusSessions.get` →
     * `participants`). Kept for the create-time invite; do not read it as truth.
     */
    agentIds: text("agent_ids").array().default([]),
    /** Set when the session transitions to `closed`. */
    closedAt: timestamp("closed_at", { withTimezone: true }),
    /** Verification report: Test results and verification outcomes (single closing report). */
    verificationReport: jsonb("verification_report"),
    /**
     * Free-form session metadata bag (additive — 0160). Shallow-merged by the
     * Hub PATCH door and the automation `session_update` output subtype. Used
     * e.g. for `grantStatus` (a sub-object an automation maintains while driving
     * a playbook session). Defaults to `{}` so a fresh row is never NULL.
     */
    metadata: jsonb("metadata").notNull().default({}),
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
    projectIdIdx: index("idx_focus_sessions_project_id").on(table.projectId),
    subjectEntityIdIdx: index("idx_focus_sessions_subject_entity_id").on(
      table.subjectEntityId
    ),
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
