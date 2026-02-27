import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { channels } from "./channels.js";
import { commandRuns } from "./command-runs.js";
import { messages } from "./messages.js";

/**
 * Proposal Status
 */
export enum ProposalStatus {
  PENDING = "pending",
  APPROVED = "approved",
  REJECTED = "rejected",
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
    workspaceId: text("workspace_id").notNull(),

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
      ],
    })
      .notNull()
      .default(ProposalStatus.PENDING),

    // Provenance: which conversation / message / run generated this proposal?
    // All nullable — existing proposals have no provenance.
    // ON DELETE SET NULL: losing the thread/run doesn't destroy the proposal record.
    createdBy: text("created_by"), // userId or agentUserId that authored this proposal
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
    agentUserId: uuid("agent_user_id").references(() => users.id, {
      onDelete: "set null",
    }),

    // Expiry: proposals older than this are treated as expired
    expiresAt: timestamp("expires_at", { withTimezone: true }),

    // Review Metadata
    reviewedBy: text("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    rejectionReason: text("rejection_reason"),
    comments: jsonb("comments").default("[]"),

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
  })
);

export type Proposal = typeof proposals.$inferSelect;
export type NewProposal = typeof proposals.$inferInsert;

// Zod Schemas
export const insertProposalSchema = createInsertSchema(proposals);
export const selectProposalSchema = createSelectSchema(proposals);
