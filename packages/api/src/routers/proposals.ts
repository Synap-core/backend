/**
 * Universal Proposals Router
 *
 * Handles listing, approving, and rejecting proposals for ALL entity types.
 * Replaces legacy document_proposals logic.
 */

import { z } from "zod";
import { router, protectedProcedure, workspaceProcedure } from "../trpc.js";
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
} from "@synap-core/types/proposals";
import { storage } from "@synap/storage";
import { requireUserId } from "../utils/user-scoped.js";
import { auditLog } from "../utils/audit-log.js";
import { channelsRouter } from "./channels.js";
import { entitiesRouter as regularEntitiesRouter } from "./entities.js";

export const proposalsRouter = router({
  /**
   * List proposals (Inbox)
   * Can be filtered by workspace, targetType, or specific targetId
   */
  list: protectedProcedure
    .input(
      z.object({
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
        limit: z.number().default(50),
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

      const items = await db.query.proposals.findMany({
        where: conditions.length > 0 ? and(...conditions) : undefined,
        orderBy: desc(proposals.createdAt),
        limit: input.limit,
      });

      return { proposals: items };
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
        await caller.createThread({
          parentThreadId: data.parentThreadId as string,
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

        return { success: true };
      }

      // Entity creation proposal: AI proposed a new entity.
      // Execute inline via entitiesRouter (human approver context bypasses governance).
      if (
        proposal.targetType === "entity" &&
        proposal.proposalType === "create"
      ) {
        const innerData = ((proposal.data as any)?.data ?? {}) as Record<
          string,
          unknown
        >;
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
          entityCallerCtx as any
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

        return { success: true };
      }

      // Entity update proposal: AI proposed changes to an existing entity.
      // Execute inline via entitiesRouter (human approver context bypasses governance).
      if (
        proposal.targetType === "entity" &&
        proposal.proposalType === "update"
      ) {
        const innerData = ((proposal.data as any)?.data ?? {}) as Record<
          string,
          unknown
        >;
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
          entityCallerCtx as any
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
          workspaceId: proposal.workspaceId,
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
        .where(eq(proposals.id, input.proposalId));

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
              workspaceId: proposal.workspaceId,
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
        await db
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
          );
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
