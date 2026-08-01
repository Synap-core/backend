/**
 * Proposal Wire Codec — Hub Protocol REST schemas for proposals.
 *
 * Proposals are the core governance primitive: AI/connector mutations create
 * a pending proposal that humans review. Approval emits the underlying side
 * effect via the event chain.
 */

import { z } from "@hono/zod-openapi";

/**
 * The selectable `status` filters for a proposal listing — the SSOT every
 * surface over the proposals queue reuses (the OpenAPI query schema below, the
 * tRPC `listProposals` input enum, the REST `GET /proposals` handler's 400
 * guard, and the `synap_list_proposals` MCP tool schema) so those four can't
 * drift apart.
 *
 * Covers EVERY value the `proposals.status` column can hold, plus "all".
 * `auto_approved` is the load-bearing entry: an auto-approved agent write
 * executes immediately and files a proposal row purely as an audit receipt
 * ("executed immediately, audited here for traceability" —
 * `database/schema/proposals.ts`). While this list held only three states those
 * receipts existed but no surface could list them.
 *
 * Lives in this codec module because it is a zod-only leaf — the tRPC router
 * and the REST handler both import it without pulling each other in.
 */
export const PROPOSAL_STATUS_FILTERS = [
  "pending",
  "approved",
  "rejected",
  "auto_approved",
  "reverted",
  "approval_failed",
  "withdrawn",
  "all",
] as const;

export type ProposalStatusFilter = (typeof PROPOSAL_STATUS_FILTERS)[number];

/** Canonical proposal status values. */
export const ProposalStatusSchema = z
  .enum(PROPOSAL_STATUS_FILTERS)
  .openapi("ProposalStatus");

/** Wire shape of a proposal row. */
export const WireProposalSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string().nullable(),
    targetType: z.string(),
    targetId: z.string(),
    proposalType: z.string(),
    data: z.record(z.string(), z.unknown()),
    status: z.enum(["pending", "approved", "rejected"]),
    agentUserId: z.string().nullable().optional(),
    threadId: z.string().nullable().optional(),
    sourceMessageId: z.string().nullable().optional(),
    createdBy: z.string().nullable().optional(),
    createdAt: z.union([z.string(), z.date()]).optional(),
    updatedAt: z.union([z.string(), z.date()]).optional(),
    sessionId: z.string().nullable().optional(),
  })
  .openapi("Proposal");

/** GET /proposals query. */
export const ListProposalsQuerySchema = z
  .object({
    userId: z.string().optional(),
    workspaceId: z.string().optional(),
    status: ProposalStatusSchema.optional().describe(
      "Defaults to `pending`. Use `all` to return every status. " +
        "`auto_approved` returns the audit receipts of agent writes that were " +
        "executed immediately under governance rather than queued for review."
    ),
  })
  .openapi("ListProposalsQuery");

/** PATCH /proposals/{id} request body. */
export const UpdateProposalRequestSchema = z
  .object({
    data: z
      .record(z.string(), z.unknown())
      .describe("Updated proposal payload (replaces existing data)."),
    summary: z
      .string()
      .optional()
      .describe("Human-readable summary of the revision."),
  })
  .openapi("UpdateProposalRequest");

/** POST /proposals request body. */
export const CreateProposalRequestSchema = z
  .object({
    workspaceId: z.string().nullable().optional(),
    agentUserId: z.string().optional(),
    channelId: z
      .string()
      .optional()
      .describe("Channel/thread originating the proposal."),
    targetType: z
      .string()
      .describe("Subject type the proposal mutates (e.g. entity, view)."),
    targetId: z
      .string()
      .describe(
        "ID of the target subject (existing record or stable temp id)."
      ),
    proposalType: z
      .string()
      .describe("Sub-action, e.g. entity.create, view.update, vault.request."),
    data: z
      .record(z.string(), z.unknown())
      .describe("Free-form proposal payload — shape is targetType-specific."),
    summary: z.string().optional(),
    sessionId: z
      .string()
      .optional()
      .describe("Focus session ID to link this proposal to."),
    sourceMessageId: z
      .string()
      .optional()
      .describe(
        "Message that originated the proposal — for event chain causality."
      ),
  })
  .openapi("CreateProposalRequest");

/** POST /proposals minimal response. */
export const CreateProposalResponseSchema = z
  .object({
    id: z.string(),
    status: z.literal("pending"),
  })
  .openapi("CreateProposalResponse");
