import { pgTable, uuid, text, jsonb, timestamp, index, } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
/**
 * Proposal Status
 */
export var ProposalStatus;
(function (ProposalStatus) {
    ProposalStatus["PENDING"] = "pending";
    ProposalStatus["APPROVED"] = "approved";
    ProposalStatus["REJECTED"] = "rejected";
})(ProposalStatus || (ProposalStatus = {}));
/**
 * Universal Proposals Table
 *
 * Stores all pending update requests (proposals) for any entity type.
 * This effectively "pauses" an event until it is validated.
 */
export const proposals = pgTable("proposals", {
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
}, (table) => ({
    // Index for "My Pending Inbox"
    workspaceStatusIdx: index("idx_proposals_workspace_status").on(table.workspaceId, table.status),
    // Index for "History of this Item"
    targetIdx: index("idx_proposals_target").on(table.targetType, table.targetId),
}));
// Zod Schemas
export const insertProposalSchema = createInsertSchema(proposals);
export const selectProposalSchema = createSelectSchema(proposals);
//# sourceMappingURL=proposals.js.map