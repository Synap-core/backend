import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users.js";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { channels } from "./channels.js";
import { commandRuns } from "./command-runs.js";
import { messages } from "./messages.js";

/**
 * Proposal Status
 */
export const ProposalStatus = {
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected",
  /** Action was on the autoApproveFor whitelist — executed immediately, audited here for traceability. */
  AUTO_APPROVED: "auto_approved",
  /** An applied (approved/auto-approved) proposal whose materialized rows were undone via `proposals.revert`. */
  REVERTED: "reverted",
  /** An external-action proposal whose dispatch call failed — proposal NOT approved. */
  APPROVAL_FAILED: "approval_failed",
  /** A pending proposal retracted by its own proposer (not a reviewer action). */
  WITHDRAWN: "withdrawn",
} as const;
export type ProposalStatus =
  (typeof ProposalStatus)[keyof typeof ProposalStatus];

/**
 * One entry in a proposal's `revision_history` — a before/after snapshot of a
 * `reviseProposal` edit. `before` holds only the fields the patch changed, with
 * their prior values; `patch` is the applied change. `by` is the actor id.
 */
export interface ProposalRevision {
  at: string;
  by: string | null;
  before: Record<string, unknown>;
  patch: Record<string, unknown>;
}

/**
 * Universal Proposals Table
 *
 * Stores all pending update requests (proposals) for any entity type.
 * This effectively "pauses" an event until it is validated.
 */
export const proposals = pgTable(
  "proposals",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    // Scoping
    workspaceId: text("workspace_id"),

    // Categorization (for filtering hooks)
    targetType: text("target_type").notNull(), // 'document', 'entity', 'whiteboard', etc.
    targetId: text("target_id").notNull(),

    // Proposal Concept
    proposalType: text("proposal_type").notNull(), // 'edit', 'comment', 'review_request'
    data: jsonb("data").notNull(), // Payload (was 'request')

    // Status Tracking
    status: text("status", {
      enum: [
        ProposalStatus.PENDING,
        ProposalStatus.APPROVED,
        ProposalStatus.REJECTED,
        ProposalStatus.AUTO_APPROVED,
        ProposalStatus.REVERTED,
        ProposalStatus.APPROVAL_FAILED,
        ProposalStatus.WITHDRAWN,
      ],
    })
      .notNull()
      .default(ProposalStatus.PENDING),

    // Provenance: which conversation / message / run generated this proposal?
    // All nullable — existing proposals have no provenance.
    // ON DELETE SET NULL: losing the thread/run doesn't destroy the proposal record.
    createdBy: text("created_by"), // userId or agentUserId that authored this proposal
    // The HUMAN userId that filed this proposal, when a person (not an agent)
    // is the proposer. Nullable — agent-authored proposals leave this NULL and
    // carry `agentUserId` instead. Distinct from `createdBy` (which is
    // overloaded across paths) so "who proposed this" is unambiguous for the
    // proposer-only `withdraw` gate and the review UI's "mine to approve" vs
    // "mine I proposed" split.
    proposedByUserId: text("proposed_by_user_id"),
    threadId: uuid("thread_id").references(() => channels.id, {
      onDelete: "set null",
    }),
    commandRunId: uuid("command_run_id").references(() => commandRuns.id, {
      onDelete: "set null",
    }),
    sourceMessageId: uuid("source_message_id").references(() => messages.id, {
      onDelete: "set null",
    }),

    // Attribution: which AI agent user created this proposal?
    // text to match users.id (Kratos identity IDs are stored as text, not UUID)
    agentUserId: text("agent_user_id").references(() => users.id, {
      onDelete: "set null",
    }),

    // Event-sourcing linkage: ties this proposal back to the `.requested`
    // event on the spine. correlationId groups the whole request chain;
    // requestedEventId points at the concrete originating event row.
    // Both nullable — pre-existing proposals have no linkage.
    correlationId: uuid("correlation_id"),
    requestedEventId: uuid("requested_event_id"),
    sessionId: uuid("session_id"),
    // Workflow attribution spine (D3a): the automation step run + flow node that
    // produced this proposal. Soft references (no FK) — the same pattern as
    // sessionId/correlationId above; automation_step_runs cascade-delete with
    // their run, so a soft ref keeps the proposal row durable as a trace.
    stepRunId: uuid("step_run_id"),
    nodeId: text("node_id"),
    // Project lens-context (project-centric-scope): the active project (or a
    // surface override) at proposal time. At materialization the worker stamps
    // `entity --belongs_to_project--> project` from this (falling back to the
    // producing session's projectId). Nullable — most proposals have no project.
    projectId: uuid("project_id"),

    // Agent-proposal exact-match dedup hash (G3): sha256 of the normalized
    // proposed change (see computeProposalDedupHash). Stored only for
    // agent/automation-authored rows; NULL for human-authored proposals. The
    // partial unique index below makes a duplicate PENDING agent proposal a
    // DB-level impossibility — the read-then-insert peek closes the common
    // case, this column + index closes the concurrent-insert race.
    dedupHash: text("dedup_hash"),

    // Expiry: proposals older than this are treated as expired
    expiresAt: timestamp("expires_at", { withTimezone: true }),

    // Review Metadata
    reviewedBy: text("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    // Executor-safety E2 (0209): at-most-once dispatch claim for the four
    // external executors. Atomically stamped BEFORE an irreversible external
    // send; a re-run that finds it already set skips the send. Never un-stamped.
    externalDispatchedAt: timestamp("external_dispatched_at", {
      withTimezone: true,
    }),
    rejectionReason: text("rejection_reason"),
    comments: jsonb("comments").default("[]"),
    // Revision history (D3b): append-only before/after snapshots of every
    // reviseProposal edit — the "human corrected the AI" quality signal the
    // analyzer loop feeds on. Each entry: { at, by, before, patch }.
    revisionHistory: jsonb("revision_history")
      .$type<ProposalRevision[]>()
      .notNull()
      .default([]),

    // Timestamps
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    // Index for "My Pending Inbox"
    workspaceStatusIdx: index("idx_proposals_workspace_status").on(
      table.workspaceId,
      table.status
    ),

    // Index for "History of this Item"
    targetIdx: index("idx_proposals_target").on(
      table.targetType,
      table.targetId
    ),

    // Provenance indexes (partial — only where value exists)
    threadIdIdx: index("idx_proposals_thread_id").on(table.threadId),
    commandRunIdIdx: index("idx_proposals_command_run_id").on(
      table.commandRunId
    ),
    sourceMessageIdIdx: index("idx_proposals_source_message_id").on(
      table.sourceMessageId
    ),
    createdByIdx: index("idx_proposals_created_by").on(table.createdBy),

    // Composite: pending proposals for a thread (used by getWorkspaceBranchTree)
    threadStatusIdx: index("idx_proposals_thread_status").on(
      table.threadId,
      table.status
    ),
    agentUserIdIdx: index("idx_proposals_agent_user_id").on(table.agentUserId),
    correlationIdIdx: index("proposals_correlation_id_idx").on(
      table.correlationId
    ),
    sessionIdIdx: index("proposals_session_id_idx").on(table.sessionId),
    projectIdIdx: index("proposals_project_id_idx").on(table.projectId),
    stepRunIdIdx: index("idx_proposals_step_run_id").on(table.stepRunId),
    // At-most-one PENDING proposal per normalized change, GLOBAL across agents
    // (indexed on dedup_hash alone — deliberately NOT on agent_user_id, so a
    // different agent proposing the identical change dedups onto the first
    // rather than colliding). findExistingPendingDuplicate peeks with the SAME
    // global scope; keep the two in sync. Partial — only pending, agent-authored,
    // hash-bearing rows are constrained; human and non-pending rows stay
    // unconstrained. Pairs with the SQL in 0208_proposals_dedup_hash.sql.
    agentDedupUnique: uniqueIndex("proposals_agent_dedup_uq")
      .on(table.dedupHash)
      .where(
        sql`${table.status} = 'pending' AND ${table.agentUserId} IS NOT NULL AND ${table.dedupHash} IS NOT NULL`
      ),
  })
);

/** Proposal row — explicit interface so consumers don't need drizzle-orm to resolve it. */
export interface Proposal {
  id: string;
  workspaceId: string | null;
  targetType: string;
  targetId: string;
  proposalType: string;
  data: unknown;
  status: ProposalStatus;
  createdBy: string | null;
  proposedByUserId: string | null;
  threadId: string | null;
  commandRunId: string | null;
  sourceMessageId: string | null;
  agentUserId: string | null;
  correlationId: string | null;
  requestedEventId: string | null;
  sessionId: string | null;
  stepRunId: string | null;
  nodeId: string | null;
  expiresAt: Date | null;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  externalDispatchedAt: Date | null;
  dedupHash: string | null;
  rejectionReason: string | null;
  comments: unknown;
  revisionHistory: ProposalRevision[];
  createdAt: Date;
  updatedAt: Date;
}
export type NewProposal = Partial<
  Omit<Proposal, "id" | "createdAt" | "updatedAt">
> & {
  workspaceId?: string | null;
  targetType: string;
  targetId: string;
  proposalType: string;
  data: unknown;
};

// Zod Schemas
export const insertProposalSchema = createInsertSchema(proposals);
export const selectProposalSchema = createSelectSchema(proposals);
