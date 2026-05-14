/**
 * Universal Proposals Router
 *
 * Handles listing, approving, and rejecting proposals for ALL entity types.
 * Replaces legacy document_proposals logic.
 */

import { z } from "zod";
import { randomUUID } from "crypto";
import { router, protectedProcedure, workspaceProcedure } from "../trpc.js";
import type { Context } from "../context.js";
import { TRPCError } from "@trpc/server";
import {
  db,
  EventRepository,
  proposals,
  documents,
  eq,
  and,
  or,
  desc,
  inArray,
  isNull,
  gt,
  entities,
  users,
  getWorkspaceMembership,
  normalizeDocumentType,
  ProfileResolutionService,
  sql,
} from "@synap/database";
import type { EventRecord } from "@synap/database";
import { ProposalStatus, workspaces } from "@synap/database/schema";
import type { WorkspaceSettings } from "@synap/database/schema";
import type {
  ProposalReviewChange,
  ProposalReviewEvent,
  ProposalReviewModel,
  StoredProposalData,
} from "@synap-core/types";
import {
  isDocumentContentProposalData,
  isRequestShapedProposalData,
  buildRequestFromProposal,
  buildFallbackTitle,
  isLikelyUUID,
} from "@synap-core/types/proposals";
import type { UpdateRequest } from "@synap-core/types/proposals";
import { storage } from "@synap/storage";
import { requireUserId } from "../utils/user-scoped.js";
import { auditLog } from "../utils/audit-log.js";
import { createEventBackedProposal } from "../utils/event-backed-proposal.js";
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

type ProposalRow = typeof proposals.$inferSelect;
type DisplayEnrichedProposal = ProposalRow & {
  request: UpdateRequest;
  authorName?: string;
  targetName?: string;
  review: ProposalReviewModel;
};

async function enrichProposalsForDisplay(
  rows: ProposalRow[]
): Promise<DisplayEnrichedProposal[]> {
  const requests = rows.map((row) => buildRequestFromProposal(row));
  const entityIds = uniqueStrings(
    requests
      .filter((request) => request.targetType === "entity")
      .map((request) => request.targetId)
      .filter(isLikelyUUID)
  );
  const userIds = uniqueStrings(
    rows.flatMap((row, idx) => [
      row.agentUserId ?? undefined,
      row.createdBy ?? undefined,
      requests[idx]?.sourceId || undefined,
    ])
  );
  const correlationIds = uniqueStrings(
    requests.map((request) => request.correlationId)
  );

  const eventRepo = new EventRepository(sql);
  const [entityRows, userRows, traceEntries] = await Promise.all([
    entityIds.length > 0
      ? db
          .select({
            id: entities.id,
            title: entities.title,
            preview: entities.preview,
            type: entities.type,
          })
          .from(entities)
          .where(inArray(entities.id, entityIds))
      : Promise.resolve([]),
    userIds.length > 0
      ? db
          .select({
            id: users.id,
            name: users.name,
            email: users.email,
            userType: users.userType,
            agentMetadata: users.agentMetadata,
          })
          .from(users)
          .where(inArray(users.id, userIds))
      : Promise.resolve([]),
    correlationIds.length > 0
      ? Promise.all(
          correlationIds.map(
            async (correlationId) =>
              [
                correlationId,
                await eventRepo.getCorrelatedEvents(correlationId),
              ] as const
          )
        )
      : Promise.resolve([] as Array<readonly [string, EventRecord[]]>),
  ]);

  const entityById = new Map(entityRows.map((row) => [row.id, row]));
  const userById = new Map(userRows.map((row) => [row.id, row]));
  const traceByCorrelationId = new Map<string, EventRecord[]>(traceEntries);

  return rows.map((row, idx) => {
    const request = requests[idx]!;
    const payload =
      request.data && typeof request.data === "object"
        ? request.data
        : undefined;
    const entityMeta = entityById.get(request.targetId);
    const targetName =
      request.targetName ??
      displayLabelFromRecord(payload) ??
      entityMeta?.title ??
      entityMeta?.preview ??
      undefined;
    const profileSlug =
      stringProp(payload, "profileSlug") ??
      stringProp(payload, "type") ??
      entityMeta?.type ??
      undefined;
    const authorRow = userById.get(
      row.agentUserId ?? row.createdBy ?? request.sourceId
    );
    const authorName = authorRow ? displayNameForUser(authorRow) : undefined;
    const summary =
      request.summary ??
      buildFallbackTitle({
        changeType: request.changeType,
        profileSlug,
        targetType: request.targetType,
        targetName,
      });

    return {
      ...row,
      authorName,
      targetName,
      request: {
        ...request,
        targetName,
        summary,
      },
      review: buildProposalReviewModel({
        row,
        request: {
          ...request,
          targetName,
          summary,
        },
        authorName,
        targetName,
        events: request.correlationId
          ? (traceByCorrelationId.get(request.correlationId) ?? [])
          : [],
      }),
    };
  });
}

function buildProposalReviewModel(params: {
  row: ProposalRow;
  request: UpdateRequest;
  authorName?: string;
  targetName?: string;
  events: Awaited<ReturnType<EventRepository["getCorrelatedEvents"]>>;
}): ProposalReviewModel {
  const { row, request, authorName, targetName, events } = params;
  const requestData =
    request.data && typeof request.data === "object" ? request.data : {};
  const reviewEvents = events.map(toProposalReviewEvent);
  const requestedEvent =
    reviewEvents.find((event) => event.phase === "requested") ??
    reviewEvents.find((event) => event.eventType.endsWith(".requested"));
  const validatedEvent =
    reviewEvents.find((event) => event.phase === "validated") ??
    reviewEvents.find((event) => event.eventType.endsWith(".validated"));
  const completedEvent =
    reviewEvents.find((event) => event.phase === "completed") ??
    reviewEvents.find((event) => event.eventType.endsWith(".completed"));

  return {
    summary:
      request.summary ??
      buildFallbackTitle({
        changeType: request.changeType,
        targetType: request.targetType,
        targetName,
      }),
    actorName: authorName,
    targetName,
    reasoning: request.reasoning,
    source: request.source,
    sourceId: request.sourceId,
    sourceMessageId: row.sourceMessageId,
    threadId: row.threadId,
    commandRunId: row.commandRunId,
    correlationId: request.correlationId,
    requestedEventId: request.requestedEventId ?? requestedEvent?.eventId,
    validatedEventId: request.validatedEventId ?? validatedEvent?.eventId,
    completedEventId: request.completedEventId ?? completedEvent?.eventId,
    changes: buildProposalChanges(requestData, request.changeType),
    events: reviewEvents,
  };
}

function toProposalReviewEvent(event: {
  id: string;
  eventType: string;
  subjectType: string;
  subjectId: string;
  timestamp: Date;
  userId: string;
  source?: string;
  correlationId?: string;
}): ProposalReviewEvent {
  const parts = event.eventType.split(".");
  return {
    eventId: event.id,
    eventType: event.eventType,
    subjectType: event.subjectType,
    subjectId: event.subjectId,
    action: parts.length >= 2 ? parts[1] : undefined,
    phase: parts.length >= 3 ? parts[2] : undefined,
    timestamp: event.timestamp.toISOString(),
    userId: event.userId,
    source: event.source,
    correlationId: event.correlationId,
  };
}

function buildProposalChanges(
  data: Record<string, unknown>,
  changeType: string
): ProposalReviewChange[] {
  const changes: ProposalReviewChange[] = [];
  const operation =
    changeType === "delete"
      ? "delete"
      : changeType === "create"
        ? "create"
        : "update";

  for (const key of ["title", "description", "profileSlug", "documentId"]) {
    if (data[key] !== undefined) {
      changes.push({
        path: key,
        label: labelFromPath(key),
        operation,
        after: data[key],
        valueType: valueTypeOf(data[key]),
      });
    }
  }

  const properties =
    data.properties && typeof data.properties === "object"
      ? (data.properties as Record<string, unknown>)
      : {};
  for (const [key, value] of Object.entries(properties)) {
    changes.push({
      path: `properties.${key}`,
      label: labelFromPath(key),
      operation,
      after: value,
      valueType: valueTypeOf(value),
    });
  }

  return changes;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(values.filter((value): value is string => Boolean(value)))
  );
}

function stringProp(
  record: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function displayLabelFromRecord(
  record: Record<string, unknown> | undefined
): string | undefined {
  return (
    stringProp(record, "title") ??
    stringProp(record, "name") ??
    stringProp(record, "displayName") ??
    stringProp(record, "label")
  );
}

function displayNameForUser(row: {
  name: string | null;
  email: string;
  userType: string;
  agentMetadata: { agentType?: string; description?: string } | null;
}): string | undefined {
  if (row.name) return row.name;
  if (row.userType === "agent") {
    return row.agentMetadata?.agentType ?? row.agentMetadata?.description;
  }
  return row.email || undefined;
}

function labelFromPath(path: string): string {
  return path
    .replace(/^properties\./, "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function valueTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export const proposalsRouter = router({
  /**
   * List proposals (Inbox)
   * Can be filtered by workspace, targetType, or specific targetId
   */
  list: protectedProcedure
    .input(
      paginatedInput.extend({
        /**
         * Workspace filter — three-state:
         *   - `string`     → only proposals for that workspace
         *   - `null`       → only pod-wide proposals (workspaceId IS NULL)
         *                    used by the Pod Admin Overview which previously
         *                    fetched all proposals and filtered client-side
         *   - `undefined`  → no filter (every workspace + pod-wide)
         */
        workspaceId: z.string().nullish(),
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
      // Three-state: string = that workspace, null = pod-wide only,
      // undefined = no filter (return all).
      if (input.workspaceId === null) {
        conditions.push(isNull(proposals.workspaceId));
      } else if (typeof input.workspaceId === "string") {
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

      // Enrich each proposal with a pre-formed `request` object and resolved
      // display metadata. Eve/Studio can render useful labels without leaking
      // raw UUIDs into the main review surface.
      const enriched = await enrichProposalsForDisplay(rows);

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
        ...(await enrichProposalsForDisplay([proposal]))[0],
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
        const branchWorkspaceId = proposal.workspaceId || null;
        if (!branchWorkspaceId) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Proposal is missing a valid workspaceId",
          });
        }
        const membership = await getWorkspaceMembership(
          db,
          branchWorkspaceId,
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
          workspaceId: branchWorkspaceId,
          workspaceRole: membership.role,
        };
        const caller = channelsRouter.createCaller(branchCallerCtx);
        await caller.createChannel({
          parentChannelId: data.parentChannelId as string,
          branchPurpose: data.branchPurpose as string,
          agentId: data.agentId as string | undefined,
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
        const mergeWorkspaceId = proposal.workspaceId || null;
        if (!mergeWorkspaceId) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Proposal is missing a valid workspaceId",
          });
        }
        const membership = await getWorkspaceMembership(
          db,
          mergeWorkspaceId,
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
          workspaceId: mergeWorkspaceId,
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
        const extWorkspaceId = proposal.workspaceId || null;
        if (!extWorkspaceId) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Proposal is missing a valid workspaceId",
          });
        }
        const membership = await getWorkspaceMembership(
          db,
          extWorkspaceId,
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
          workspaceId: extWorkspaceId,
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
        const profileSlug = innerData.profileSlug as string | undefined;
        if (!profileSlug) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Entity proposal is missing profileSlug",
          });
        }

        const proposalWorkspaceId = proposal.workspaceId || null;

        // Check whether this profile is pod-wide or workspace-scoped.
        // Pod-wide entities (task, event, note, project, …) can be created without
        // a workspace context — the membership check is skipped and the entity is
        // stored with workspaceId = null.
        const profileService = new ProfileResolutionService(db);
        const entityScope = await profileService.getEntityScope(
          profileSlug,
          proposalWorkspaceId
        );
        const isPodWide = entityScope === "pod";

        let entityCallerCtx: {
          db: typeof db;
          authenticated: true;
          userId: string;
          workspaceId: string | null;
          workspaceRole: string;
        };

        if (isPodWide) {
          entityCallerCtx = {
            db,
            authenticated: true as const,
            userId,
            workspaceId: null,
            workspaceRole: "owner",
          };
        } else {
          if (!proposalWorkspaceId) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message:
                "Entity creation proposal for a workspace-scoped profile is missing a valid workspaceId",
            });
          }
          const membership = await getWorkspaceMembership(
            db,
            proposalWorkspaceId,
            userId
          );
          if (!membership) {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: "No workspace access",
            });
          }
          entityCallerCtx = {
            db,
            authenticated: true as const,
            userId,
            workspaceId: proposalWorkspaceId,
            workspaceRole: membership.role,
          };
        }

        const entityCaller = regularEntitiesRouter.createCaller(
          entityCallerCtx as unknown as Context
        );
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
        const validatedEvent = await auditLog({
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

        if (validatedEvent) {
          payload.validatedEventId = validatedEvent.id;
        }
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
          ...(isRequestShapedProposalData(payload) ? { data: payload } : {}),
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

            const validatedEvent = await auditLog({
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

            if (validatedEvent) {
              payload.validatedEventId = validatedEvent.id;
            }
          }

          await db
            .update(proposals)
            .set({
              status: ProposalStatus.APPROVED,
              ...(payload && isRequestShapedProposalData(payload)
                ? { data: payload }
                : {}),
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

      const workspaceId = (input.data.workspaceId as string) || null;
      const targetId = input.targetId || randomUUID();
      const { proposal } = await createEventBackedProposal({
        userId,
        workspaceId,
        targetType: input.targetType,
        targetId,
        proposalType: input.changeType,
        action: input.changeType,
        summary: buildFallbackTitle({
          changeType: input.changeType,
          targetType: input.targetType,
        }),
        data: {
          requestId: randomUUID(),
          source: "user",
          sourceId: userId,
          workspaceId,
          targetType: input.targetType,
          targetId,
          changeType: input.changeType,
          data: input.data,
          reasoning: input.reasoning,
          submittedBy: userId,
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

      const { proposal } = await createEventBackedProposal({
        userId: ctx.userId,
        workspaceId,
        targetType: "document",
        targetId: input.documentId,
        proposalType: "user_edit",
        action: "update",
        summary: "Suggest document edit",
        data: {
          source: "user",
          sourceId: ctx.userId,
          proposedContent,
          range: [from, to],
          originalSnippet: currentContent.slice(from, to),
          replacementText: input.replacementText,
        },
      });

      if (!proposal) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create proposal",
        });
      }

      return { proposalId: proposal.id };
    }),
});
