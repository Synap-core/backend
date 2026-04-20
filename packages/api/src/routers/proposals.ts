/**
 * Universal Proposals Router
 *
 * Handles listing, approving, and rejecting proposals for ALL entity types.
 * Replaces legacy document_proposals logic.
 */

import { z } from "zod";
import { router, protectedProcedure, workspaceProcedure } from "../trpc.js";
import type { Context } from "../context.js";
import { TRPCError } from "@trpc/server";
import {
  db,
  proposals,
  documents,
  eq,
  and,
  or,
  desc,
  isNull,
  gt,
  getWorkspaceMembership,
  normalizeDocumentType,
} from "@synap/database";
import { ProposalStatus, workspaces } from "@synap/database/schema";
import type { WorkspaceSettings } from "@synap/database/schema";
import type { StoredProposalData } from "@synap-core/types";
import {
  isDocumentContentProposalData,
  isRequestShapedProposalData,
  buildRequestFromProposal,
} from "@synap-core/types/proposals";
import { storage } from "@synap/storage";
import { requireUserId } from "../utils/user-scoped.js";
import { auditLog } from "../utils/audit-log.js";
import { createLogger } from "@synap-core/core";
import { getDefaultActiveService } from "../utils/intelligence-routing.js";
import { channelsRouter } from "./channels.js";
import { entitiesRouter as regularEntitiesRouter } from "./entities.js";
import { messages } from "@synap/database/schema";
import { emitChatEvent } from "../utils/chat-realtime-broadcast.js";
import { emitSideEffects } from "@synap/events";
import { notifications } from "@synap/database/schema";
import { paginatedInput, buildPaginatedResponse } from "../utils/pagination.js";

const logger = createLogger({ module: "proposals" });

/**
 * Fire-and-forget: mark the corresponding notification row as 'actioned'
 * when a proposal is approved or rejected. Uses the source index on
 * (sourceType, sourceId) for efficient lookup.
 */
function markProposalNotificationActioned(proposalId: string): void {
  db.update(notifications)
    .set({ status: "actioned", readAt: new Date() })
    .where(
      and(
        eq(notifications.sourceType, "proposal"),
        eq(notifications.sourceId, proposalId)
      )
    )
    .then(() => {
      logger.debug({ proposalId }, "Proposal notification marked as actioned");
    })
    .catch((err) => {
      // Non-fatal — notifications must never break the proposal flow
      logger.warn(
        { err, proposalId },
        "Failed to mark proposal notification as actioned (non-fatal)"
      );
    });
}

/**
 * Fire-and-forget: notify connected clients that a proposal was reviewed.
 * The bell panel uses this to remove the item immediately without a refetch.
 * Also enqueues automation-trigger-match for the proposal_event trigger type.
 */
function emitProposalReviewed(
  proposalId: string,
  workspaceId: string | null | undefined,
  status: "approved" | "rejected",
  userId?: string
): void {
  if (!workspaceId) return;
  emitChatEvent({
    event: "proposal:reviewed",
    data: { proposalId, status, workspaceId },
    workspaceId,
  });
  // Automation side-effects: proposal.approved.completed / proposal.rejected.completed
  emitSideEffects({
    subjectType: "proposal",
    action: status,
    subjectId: proposalId,
    userId: userId ?? "",
    workspaceId,
    data: { proposalStatus: status },
  });
  // Mark the corresponding notification as actioned (fire-and-forget)
  markProposalNotificationActioned(proposalId);
}

/**
 * Fire-and-forget: report a proposal outcome to the IS telemetry endpoint.
 * The IS records a Langfuse score on the originating conversation trace.
 * Never awaited — never throws — never blocks the user response.
 */
function reportProposalOutcome(params: {
  proposalId: string;
  outcome: "approved" | "rejected";
  sourceMessageId: string | null | undefined;
  agentUserId: string | null | undefined;
  targetType: string | null | undefined;
}): void {
  const internalKey = process.env.INTELLIGENCE_HUB_INTERNAL_KEY;
  if (!internalKey || !params.agentUserId) return; // only track AI proposals

  void (async () => {
    try {
      // Resolve hub endpoint from DB (registered IS) rather than env vars
      const { endpoint: hubUrl } = await getDefaultActiveService();

      // Resolve channelId (= Langfuse traceId) from sourceMessageId
      let traceId: string | undefined;
      if (params.sourceMessageId) {
        const [msg] = await db
          .select({ channelId: messages.channelId })
          .from(messages)
          .where(eq(messages.id, params.sourceMessageId))
          .limit(1);
        traceId = msg?.channelId ?? undefined;
      }

      await fetch(`${hubUrl}/api/internal/telemetry/proposal-outcome`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Key": internalKey,
        },
        body: JSON.stringify({
          traceId,
          proposalId: params.proposalId,
          outcome: params.outcome,
          targetType: params.targetType,
        }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch (err) {
      // Non-fatal — telemetry must never affect proposal approval UX
      logger.warn(
        { err, proposalId: params.proposalId },
        "Failed to report proposal outcome to IS telemetry"
      );
    }
  })();
}

export const proposalsRouter = router({
  /**
   * List proposals (Inbox)
   * Can be filtered by workspace, targetType, or specific targetId
   */
  list: protectedProcedure
    .input(
      paginatedInput.extend({
        workspaceId: z.string().optional(),
        targetType: z
          .enum(["document", "entity", "whiteboard", "view", "profile"])
          .optional(),
        targetId: z.string().optional(),
        /** Filter to proposals originating from a specific chat thread */
        threadId: z.string().uuid().optional(),
        status: z
          .enum(["pending", "validated", "rejected", "all"])
          .default("pending"),
      })
    )
    .query(async ({ input, ctx }) => {
      const conditions = [];

      // Filter by Workspace (Security Boundary)
      if (input.workspaceId) {
        conditions.push(eq(proposals.workspaceId, input.workspaceId));
      }

      if (input.targetType) {
        conditions.push(eq(proposals.targetType, input.targetType));
      }

      if (input.targetId) {
        conditions.push(eq(proposals.targetId, input.targetId));
      }

      if (input.threadId) {
        conditions.push(eq(proposals.threadId, input.threadId));
      }

      if (input.status !== "all") {
        // Map string to enum
        const statusEnum =
          input.status === "pending"
            ? ProposalStatus.PENDING
            : input.status === "validated"
              ? ProposalStatus.APPROVED // Note: "validated" maps to APPROVED
              : ProposalStatus.REJECTED;
        conditions.push(eq(proposals.status, statusEnum));
      }

      // Exclude expired proposals (expiresAt is null = no expiry, or in the future)
      conditions.push(
        or(isNull(proposals.expiresAt), gt(proposals.expiresAt, new Date()))!
      );

      // Verify user has editor+ access to the workspace
      if (input.workspaceId) {
        const { workspaceMembers } = await import("@synap/database/schema");
        const membership = await db.query.workspaceMembers.findFirst({
          where: and(
            eq(workspaceMembers.workspaceId, input.workspaceId),
            eq(workspaceMembers.userId, requireUserId(ctx.userId))
          ),
        });
        if (
          !membership ||
          !["owner", "admin", "editor"].includes(membership.role)
        ) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Editor or higher role required to view proposals",
          });
        }
      }

      const rows = await db.query.proposals.findMany({
        where: conditions.length > 0 ? and(...conditions) : undefined,
        orderBy: desc(proposals.createdAt),
        limit: input.limit + 1,
        offset: input.offset,
      });

      // Enrich each proposal with a pre-formed `request` object so the
      // frontend doesn't need to reconstruct it from the JSONB data column.
      const enriched = rows.map((row) => ({
        ...row,
        request: buildRequestFromProposal(row),
      }));

      const { items, pagination } = buildPaginatedResponse(enriched, input);

      return {
        items,
        pagination,
        /** @deprecated Use `items` instead */
        proposals: items,
      };
    }),

  /**
   * Fetch a single proposal by ID.
   *
   * Used by the Studio's /proposals/:id detail page — the destination of the
   * `reviewUrl` returned on every `"status": "proposed"` response. Enforces
   * the same workspace-access check as `list` (editor or higher).
   */
  get: protectedProcedure
    .input(z.object({ proposalId: z.string() }))
    .query(async ({ input, ctx }) => {
      const userId = requireUserId(ctx.userId);

      const proposal = await db.query.proposals.findFirst({
        where: eq(proposals.id, input.proposalId),
      });

      if (!proposal) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Proposal not found",
        });
      }

      // Workspace access check
      if (proposal.workspaceId) {
        const { workspaceMembers } = await import("@synap/database/schema");
        const membership = await db.query.workspaceMembers.findFirst({
          where: and(
            eq(workspaceMembers.workspaceId, proposal.workspaceId),
            eq(workspaceMembers.userId, userId)
          ),
        });
        if (
          !membership ||
          !["owner", "admin", "editor"].includes(membership.role)
        ) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Editor or higher role required to view this proposal",
          });
        }
      } else {
        // Pod-wide proposal (no workspaceId) — only the proposer can see it
        const proposalData = proposal.data as Record<string, unknown> | null;
        if (proposalData?.sourceId !== userId) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Not authorized to view this proposal",
          });
        }
      }

      return {
        ...proposal,
        request: buildRequestFromProposal(proposal),
      };
    }),

  /**
   * Approve a proposal
   * For hub-created document proposals (AI edit): applies proposedContent to storage + DB.
   * For other proposals: emits the original request event as *.validated.
   */
  approve: protectedProcedure
    .input(
      z.object({
        proposalId: z.string(),
        comment: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);

      const proposal = await db.query.proposals.findFirst({
        where: eq(proposals.id, input.proposalId),
      });

      if (!proposal) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Proposal not found",
        });
      }

      // Ownership check: who can approve this proposal?
      if (proposal.workspaceId) {
        const [ws] = await db
          .select({ settings: workspaces.settings })
          .from(workspaces)
          .where(eq(workspaces.id, proposal.workspaceId))
          .limit(1);

        const settings = ws?.settings as WorkspaceSettings | undefined;
        const policy =
          settings?.aiGovernance?.proposalApprovalPolicy ?? "owner_and_admins";

        const membership = await getWorkspaceMembership(
          db,
          proposal.workspaceId,
          userId
        );
        const memberRole = membership?.role;
        const isAdmin = memberRole === "admin";
        const isEditor = memberRole === "editor" || isAdmin;
        const proposalData = proposal.data as Record<string, unknown> | null;
        const isOwner = proposalData?.sourceId === userId;

        const canApprove =
          policy === "admins_only"
            ? isAdmin
            : policy === "any_editor"
              ? isEditor
              : /* owner_and_admins */ isOwner || isAdmin;

        if (!canApprove) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Not authorized to approve this proposal",
          });
        }
      }

      const payload = proposal.data as StoredProposalData | null | undefined;

      // B3: Document content proposal (hub/chat/user_edit) – apply content directly
      if (
        proposal.targetType === "document" &&
        isDocumentContentProposalData(payload)
      ) {
        const { storage } = await import("@synap/storage");
        const { documents, documentVersions } =
          await import("@synap/database/schema");

        const document = await db.query.documents.findFirst({
          where: eq(documents.id, proposal.targetId),
        });

        if (!document?.storageKey) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Document not found or has no storage key",
          });
        }

        const newVersion = (document.currentVersion ?? 1) + 1;
        const content = payload.proposedContent;

        await storage.upload(
          document.storageKey,
          Buffer.from(content, "utf-8"),
          { contentType: document.mimeType || "text/plain" }
        );

        await db.insert(documentVersions).values({
          documentId: proposal.targetId,
          version: newVersion,
          content,
          author: "user",
          authorId: userId,
          message: "AI edit accepted",
        });

        await db
          .update(documents)
          .set({
            currentVersion: newVersion,
            lastSavedVersion: newVersion,
            updatedAt: new Date(),
          })
          .where(eq(documents.id, proposal.targetId));

        await db
          .update(proposals)
          .set({
            status: ProposalStatus.APPROVED,
            reviewedBy: userId,
            reviewedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(proposals.id, input.proposalId));

        emitProposalReviewed(
          input.proposalId,
          proposal.workspaceId,
          "approved",
          userId
        );
        return { success: true };
      }

      // Document creation proposal: AI proposed a new document (content stored in JSONB).
      // Upload content to MinIO and insert DB row now that the user approved.
      if (
        proposal.targetType === "document" &&
        proposal.proposalType === "create"
      ) {
        const data = (proposal.data ?? {}) as Record<string, unknown>;
        const documentId = proposal.targetId;
        const docType = normalizeDocumentType(
          (data.type as string) || "markdown",
          "markdown"
        );
        const extension = docType === "markdown" ? "md" : docType;
        const content = (data.content as string) || "";
        const docUserId = (data.userId as string) || userId;
        const storageKey = storage.buildPath(
          docUserId,
          "document",
          documentId,
          extension
        );
        const metadata = await storage.upload(storageKey, content, {
          contentType: "text/markdown",
        });

        await db.insert(documents).values({
          id: documentId,
          title: (data.title as string) || "Untitled",
          type: docType,
          storageUrl: metadata.url,
          storageKey: metadata.path,
          size: metadata.size,
          mimeType: "text/markdown",
          userId: docUserId,
          workspaceId: proposal.workspaceId,
          currentVersion: 1,
          lastSavedVersion: 1,
        });

        await db
          .update(proposals)
          .set({
            status: ProposalStatus.APPROVED,
            reviewedBy: userId,
            reviewedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(proposals.id, input.proposalId));

        emitProposalReviewed(
          input.proposalId,
          proposal.workspaceId,
          "approved",
          userId
        );
        return { success: true };
      }

      // Branch creation proposal: AI proposed creating a branch.
      // Execute via channelsRouter now that the user approved.
      if (
        proposal.targetType === "channel" &&
        proposal.proposalType === "create_branch"
      ) {
        const data = (proposal.data ?? {}) as Record<string, unknown>;
        const membership = await getWorkspaceMembership(
          db,
          proposal.workspaceId!,
          userId
        );
        if (!membership) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "No workspace access",
          });
        }
        const branchCallerCtx = {
          db,
          authenticated: true as const,
          userId,
          workspaceId: proposal.workspaceId!,
          workspaceRole: membership.role,
        };
        const caller = channelsRouter.createCaller(branchCallerCtx);
        await caller.createChannel({
          parentChannelId: data.parentChannelId as string,
          branchPurpose: data.branchPurpose as string,
          agentId: data.agentId as string | undefined,
          agentType: data.agentType as
            | "default"
            | "meta"
            | "prompting"
            | "knowledge-search"
            | "code"
            | "writing"
            | "action"
            | undefined,
          agentConfig: data.agentConfig as Record<string, unknown> | undefined,
          inheritContext: (data.inheritContext as boolean) ?? true,
        });

        await db
          .update(proposals)
          .set({
            status: ProposalStatus.APPROVED,
            reviewedBy: userId,
            reviewedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(proposals.id, input.proposalId));

        emitProposalReviewed(
          input.proposalId,
          proposal.workspaceId,
          "approved",
          userId
        );
        return { success: true };
      }

      // Branch merge proposal: AI proposed merging a branch.
      // The user must always validate a merge — execute now that they approved.
      if (
        proposal.targetType === "channel" &&
        proposal.proposalType === "merge_branch"
      ) {
        const data = (proposal.data ?? {}) as Record<string, unknown>;
        const membership = await getWorkspaceMembership(
          db,
          proposal.workspaceId!,
          userId
        );
        if (!membership) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "No workspace access",
          });
        }
        const mergeCallerCtx = {
          db,
          authenticated: true as const,
          userId,
          workspaceId: proposal.workspaceId!,
          workspaceRole: membership.role,
        };
        const caller = channelsRouter.createCaller(mergeCallerCtx);
        await caller.mergeBranch({
          branchId: data.branchId as string,
          summary: data.summary as string | undefined,
        });

        await db
          .update(proposals)
          .set({
            status: ProposalStatus.APPROVED,
            reviewedBy: userId,
            reviewedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(proposals.id, input.proposalId));

        emitProposalReviewed(
          input.proposalId,
          proposal.workspaceId,
          "approved",
          userId
        );
        return { success: true };
      }

      // External channel import proposal: AI (e.g. OpenClaw) wants to import a
      // WhatsApp/Slack/Telegram conversation as a Synap channel.
      // Execute createExternalChannel now that the user approved.
      if (
        proposal.targetType === "channel" &&
        proposal.proposalType === "create_external"
      ) {
        const data = (proposal.data ?? {}) as Record<string, unknown>;
        const membership = await getWorkspaceMembership(
          db,
          proposal.workspaceId!,
          userId
        );
        if (!membership) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "No workspace access",
          });
        }
        const extCallerCtx = {
          db,
          authenticated: true as const,
          userId,
          workspaceId: proposal.workspaceId!,
          workspaceRole: membership.role,
        };
        const caller = channelsRouter.createCaller(extCallerCtx);
        await caller.createExternalChannel({
          externalSource: data.externalSource as string,
          externalChannelId: data.externalChannelId as string,
          title: data.title as string,
          externalParticipants: data.externalParticipants as
            | string[]
            | undefined,
          initialMessage: data.initialMessage as string | undefined,
          metadata: data.metadata as Record<string, unknown> | undefined,
        });

        await db
          .update(proposals)
          .set({
            status: ProposalStatus.APPROVED,
            reviewedBy: userId,
            reviewedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(proposals.id, input.proposalId));

        emitProposalReviewed(
          input.proposalId,
          proposal.workspaceId,
          "approved",
          userId
        );
        return { success: true };
      }

      // Entity creation proposal: AI proposed a new entity.
      // Execute inline via entitiesRouter (human approver context bypasses governance).
      if (
        proposal.targetType === "entity" &&
        proposal.proposalType === "create"
      ) {
        const innerData = ((proposal.data as Record<string, unknown>)?.data ??
          {}) as Record<string, unknown>;
        const membership = await getWorkspaceMembership(
          db,
          proposal.workspaceId!,
          userId
        );
        if (!membership) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "No workspace access",
          });
        }
        const entityCallerCtx = {
          db,
          authenticated: true as const,
          userId,
          workspaceId: proposal.workspaceId!,
          workspaceRole: membership.role,
        };
        const entityCaller = regularEntitiesRouter.createCaller(
          entityCallerCtx as unknown as Context
        );
        const profileSlug = innerData.profileSlug as string | undefined;
        if (!profileSlug) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Entity proposal is missing profileSlug",
          });
        }
        await entityCaller.create({
          profileSlug,
          title: (innerData.title as string) || "Untitled",
          description: innerData.description as string | undefined,
          properties: innerData.properties as
            | Record<string, unknown>
            | undefined,
          source: "system",
        });

        await db
          .update(proposals)
          .set({
            status: ProposalStatus.APPROVED,
            reviewedBy: userId,
            reviewedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(proposals.id, input.proposalId));

        emitProposalReviewed(
          input.proposalId,
          proposal.workspaceId,
          "approved",
          userId
        );
        return { success: true };
      }

      // Entity update proposal: AI proposed changes to an existing entity.
      // Execute inline via entitiesRouter (human approver context bypasses governance).
      if (
        proposal.targetType === "entity" &&
        proposal.proposalType === "update"
      ) {
        const innerData = ((proposal.data as Record<string, unknown>)?.data ??
          {}) as Record<string, unknown>;
        const entityId = (innerData.id as string) || proposal.targetId;
        const membership = await getWorkspaceMembership(
          db,
          proposal.workspaceId!,
          userId
        );
        if (!membership) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "No workspace access",
          });
        }
        const entityCallerCtx = {
          db,
          authenticated: true as const,
          userId,
          workspaceId: proposal.workspaceId!,
          workspaceRole: membership.role,
        };
        const entityCaller = regularEntitiesRouter.createCaller(
          entityCallerCtx as unknown as Context
        );
        await entityCaller.update({
          id: entityId,
          title: innerData.title as string | undefined,
          description: innerData.description as string | undefined,
          properties: innerData.properties as
            | Record<string, unknown>
            | undefined,
          source: "system",
        });

        await db
          .update(proposals)
          .set({
            status: ProposalStatus.APPROVED,
            reviewedBy: userId,
            reviewedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(proposals.id, input.proposalId));

        emitProposalReviewed(
          input.proposalId,
          proposal.workspaceId,
          "approved",
          userId
        );
        return { success: true };
      }

      // Generic flow: emit .validated event → materialization hook picks it up
      if (isRequestShapedProposalData(payload)) {
        const {
          targetType,
          changeType,
          data: requestData,
          correlationId: proposalCorrelationId,
        } = payload as typeof payload & { correlationId?: string };

        const eventPayload =
          typeof requestData === "object" && requestData !== null
            ? { ...requestData }
            : {};

        // Normalize entity payload fields
        if (targetType === "entity") {
          if (
            changeType === "update" &&
            eventPayload.entityId != null &&
            eventPayload.id == null
          ) {
            eventPayload.id = eventPayload.entityId;
          }
          if (
            changeType === "create" &&
            eventPayload.description != null &&
            eventPayload.preview == null
          ) {
            eventPayload.preview = eventPayload.description;
          }
        }

        const subjectId = (eventPayload.id as string) || proposal.targetId;

        // Emit .validated event with the same correlationId as the .requested event.
        // The materialization hook (setup-event-broadcasting.ts) will pick this up
        // and enqueue it to the materializer worker via pg-boss.
        await auditLog({
          subjectType: targetType,
          action: changeType,
          phase: "validated",
          subjectId,
          userId,
          workspaceId: proposal.workspaceId ?? undefined,
          correlationId: proposalCorrelationId,
          data: {
            ...eventPayload,
            workspaceId: proposal.workspaceId,
            approvedBy: userId,
            approvedAt: new Date().toISOString(),
            approvalComment: input.comment,
          },
          source: "api",
        });
      } else {
        // Payload doesn't match any known request shape and targetType was not
        // handled by a specific branch above — throw rather than silently succeed.
        throw new TRPCError({
          code: "NOT_IMPLEMENTED",
          message: `Proposal approval for type '${proposal.targetType}' is not yet implemented`,
        });
      }

      await db
        .update(proposals)
        .set({
          status: ProposalStatus.APPROVED,
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(proposals.id, input.proposalId));

      // Report to IS telemetry (fire-and-forget — never blocks)
      reportProposalOutcome({
        proposalId: input.proposalId,
        outcome: "approved",
        sourceMessageId: proposal.sourceMessageId,
        agentUserId: proposal.agentUserId,
        targetType: proposal.targetType,
      });

      emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return { success: true };
    }),

  /**
   * Reject a proposal
   */
  reject: protectedProcedure
    .input(
      z.object({
        proposalId: z.string(),
        reason: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);

      // Fetch first to get sourceMessageId + agentUserId for telemetry + workspaceId for realtime
      const proposal = await db.query.proposals.findFirst({
        where: eq(proposals.id, input.proposalId),
        columns: {
          sourceMessageId: true,
          agentUserId: true,
          targetType: true,
          workspaceId: true,
        },
      });

      await db
        .update(proposals)
        .set({
          status: ProposalStatus.REJECTED,
          rejectionReason: input.reason,
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(proposals.id, input.proposalId));

      // Report to IS telemetry (fire-and-forget — never blocks)
      if (proposal) {
        reportProposalOutcome({
          proposalId: input.proposalId,
          outcome: "rejected",
          sourceMessageId: proposal.sourceMessageId,
          agentUserId: proposal.agentUserId,
          targetType: proposal.targetType,
        });
        emitProposalReviewed(
          input.proposalId,
          proposal.workspaceId,
          "rejected",
          userId
        );
      }

      return { success: true };
    }),

  /**
   * Batch approve multiple proposals in a single call.
   * The frontend handles selection; this processes the IDs.
   * Each proposal goes through the same ownership + materialization flow.
   */
  batchApprove: protectedProcedure
    .input(
      z.object({
        proposalIds: z.array(z.string()).min(1).max(50),
        comment: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const results: Array<{
        proposalId: string;
        success: boolean;
        error?: string;
      }> = [];

      for (const proposalId of input.proposalIds) {
        try {
          const proposal = await db.query.proposals.findFirst({
            where: eq(proposals.id, proposalId),
          });

          if (!proposal) {
            results.push({ proposalId, success: false, error: "Not found" });
            continue;
          }

          if (proposal.status !== ProposalStatus.PENDING) {
            results.push({
              proposalId,
              success: false,
              error: `Already ${proposal.status}`,
            });
            continue;
          }

          // Ownership check
          if (proposal.workspaceId) {
            const [ws] = await db
              .select({ settings: workspaces.settings })
              .from(workspaces)
              .where(eq(workspaces.id, proposal.workspaceId))
              .limit(1);

            const settings = ws?.settings as WorkspaceSettings | undefined;
            const policy =
              settings?.aiGovernance?.proposalApprovalPolicy ??
              "owner_and_admins";

            const membership = await getWorkspaceMembership(
              db,
              proposal.workspaceId,
              userId
            );
            const memberRole = membership?.role;
            const isAdmin = memberRole === "admin";
            const isEditor = memberRole === "editor" || isAdmin;
            const proposalData = proposal.data as Record<
              string,
              unknown
            > | null;
            const isOwner = proposalData?.sourceId === userId;

            const canApprove =
              policy === "admins_only"
                ? isAdmin
                : policy === "any_editor"
                  ? isEditor
                  : isOwner || isAdmin;

            if (!canApprove) {
              results.push({
                proposalId,
                success: false,
                error: "Not authorized",
              });
              continue;
            }
          }

          // Emit .validated event for generic proposals (same as single approve)
          const payload = proposal.data as
            | StoredProposalData
            | null
            | undefined;

          if (payload && isRequestShapedProposalData(payload)) {
            const {
              targetType,
              changeType,
              data: requestData,
              correlationId: proposalCorrelationId,
            } = payload as typeof payload & { correlationId?: string };

            const eventPayload =
              typeof requestData === "object" && requestData !== null
                ? { ...requestData }
                : {};

            if (targetType === "entity") {
              if (
                changeType === "update" &&
                eventPayload.entityId != null &&
                eventPayload.id == null
              ) {
                eventPayload.id = eventPayload.entityId;
              }
              if (
                changeType === "create" &&
                eventPayload.description != null &&
                eventPayload.preview == null
              ) {
                eventPayload.preview = eventPayload.description;
              }
            }

            const subjectId = (eventPayload.id as string) || proposal.targetId;

            await auditLog({
              subjectType: targetType,
              action: changeType,
              phase: "validated",
              subjectId,
              userId,
              workspaceId: proposal.workspaceId ?? undefined,
              correlationId: proposalCorrelationId,
              data: {
                ...eventPayload,
                workspaceId: proposal.workspaceId,
                approvedBy: userId,
                approvedAt: new Date().toISOString(),
                approvalComment: input.comment,
              },
              source: "api",
            });
          }

          await db
            .update(proposals)
            .set({
              status: ProposalStatus.APPROVED,
              reviewedBy: userId,
              reviewedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(proposals.id, proposalId));

          emitProposalReviewed(
            proposalId,
            proposal.workspaceId,
            "approved",
            userId
          );
          results.push({ proposalId, success: true });
        } catch (error) {
          results.push({
            proposalId,
            success: false,
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }
      }

      return { results };
    }),

  /**
   * Batch reject multiple proposals in a single call.
   */
  batchReject: protectedProcedure
    .input(
      z.object({
        proposalIds: z.array(z.string()).min(1).max(50),
        reason: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);

      for (const proposalId of input.proposalIds) {
        const [updated] = await db
          .update(proposals)
          .set({
            status: ProposalStatus.REJECTED,
            rejectionReason: input.reason,
            reviewedBy: userId,
            reviewedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(proposals.id, proposalId),
              eq(proposals.status, ProposalStatus.PENDING)
            )
          )
          .returning({ workspaceId: proposals.workspaceId });

        if (updated) {
          emitProposalReviewed(
            proposalId,
            updated.workspaceId,
            "rejected",
            userId
          );
        }
      }

      return { success: true };
    }),

  /**
   * Submit a proposal (Universal Request)
   * Emits *.requested event.
   * If user has permission + auto-approve enabled -> Validated.
   * If not -> Pending Proposal.
   */
  submit: protectedProcedure
    .input(
      z.object({
        targetType: z.enum([
          "document",
          "entity",
          "relation",
          "workspace",
          "view",
          "profile",
        ]),
        targetId: z.string().optional(),
        changeType: z.enum(["create", "update", "delete"]),
        data: z.record(z.string(), z.any()),
        reasoning: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);

      // Insert proposal directly into DB
      const [proposal] = await db
        .insert(proposals)
        .values({
          workspaceId: (input.data.workspaceId as string) || "",
          targetType: input.targetType,
          targetId: input.targetId || "",
          proposalType: "user_suggestion",
          data: {
            ...input.data,
            changeType: input.changeType,
            reasoning: input.reasoning,
            submittedBy: userId,
          },
          status: ProposalStatus.PENDING,
        })
        .returning();

      // Side-effects: fire proposal.created event for automation triggers
      emitSideEffects({
        subjectType: "proposal",
        action: "created",
        subjectId: proposal.id,
        userId,
        workspaceId: (input.data.workspaceId as string) || undefined,
        data: {
          proposalStatus: "created",
          targetType: input.targetType,
          changeType: input.changeType,
        },
      });

      return {
        success: true,
        requestId: proposal.id,
        status: "proposed",
        message: "Proposal submitted",
      };
    }),

  /**
   * Create a document edit proposal (suggest edit): replace text in range [from, to] with replacementText.
   * Used when user selects text and clicks "Suggest edit" in the editor.
   */
  createDocumentEdit: workspaceProcedure
    .input(
      z.object({
        documentId: z.string().uuid(),
        from: z.number().int().nonnegative(),
        to: z.number().int().nonnegative(),
        replacementText: z.string(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const workspaceId = ctx.workspaceId;
      if (!workspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Workspace context required",
        });
      }

      const document = await db.query.documents.findFirst({
        where: eq(documents.id, input.documentId),
      });

      if (!document) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Document not found",
        });
      }

      if (document.workspaceId !== workspaceId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Document is not in the current workspace",
        });
      }

      let currentContent: string;
      if (document.storageKey) {
        const contentBuffer = await storage.downloadBuffer(document.storageKey);
        currentContent =
          (document.mimeType?.includes("base64") ?? false)
            ? contentBuffer.toString("base64")
            : contentBuffer.toString("utf-8");
      } else {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Document has no stored content (e.g. whiteboard); suggest edit not supported",
        });
      }

      const from = Math.min(input.from, currentContent.length);
      const to = Math.min(input.to, currentContent.length);
      const proposedContent =
        currentContent.slice(0, from) +
        input.replacementText +
        currentContent.slice(to);

      const [proposal] = await db
        .insert(proposals)
        .values({
          workspaceId,
          targetType: "document",
          targetId: input.documentId,
          proposalType: "user_edit",
          data: {
            proposedContent,
            range: [from, to],
            originalSnippet: currentContent.slice(from, to),
            replacementText: input.replacementText,
          },
          status: ProposalStatus.PENDING,
        })
        .returning();

      if (!proposal) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create proposal",
        });
      }

      return { proposalId: proposal.id };
    }),
});
