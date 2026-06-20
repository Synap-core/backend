/**
 * Approve executors — one `registerProposalExecutor({...})` per former approve
 * branch. Each `execute()` body is the VERBATIM branch body from the old flat
 * if-chain in proposals.ts (same caller construction, same db updates, same
 * `emitProposalReviewed`/`reportProposalOutcome` calls in the same position,
 * same returns, same idempotency guards). Behaviour is identical — the only
 * change is the dispatch mechanism (registry lookup vs. if-ladder).
 *
 * Registration runs once, from `registerApproveExecutors()` in proposals.ts,
 * which passes module-scope helpers via `deps` so the bodies stay verbatim
 * without a circular import.
 */

import { randomUUID } from "crypto";
import { TRPCError } from "@trpc/server";
import {
  db,
  proposals,
  documents,
  documentVersions,
  eq,
  getWorkspaceMembership,
  normalizeDocumentType,
  storedVersionValues,
  uploadDocumentVersionSnapshot,
  ProfileResolutionService,
  links,
  type LinkEndpointType,
  type LinkType,
} from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import type { ProposalMaterializedRecord } from "@synap-core/types";
import { storage } from "@synap/storage";
import { auditLog } from "../../utils/audit-log.js";
import { channelsRouter } from "../channels.js";
import { entitiesRouter as regularEntitiesRouter } from "../entities.js";
import {
  sendExternalMessage,
  triggerConnectorAction,
  triggerProviderAction,
} from "../../connectors/external-dispatch.js";
import type { Context } from "../../context.js";
import {
  registerProposalExecutor,
  type StoredProposalData,
} from "./execution-registry.js";

let registered = false;

/**
 * Register every approve executor exactly once (idempotent — safe to call from
 * multiple import sites). Called at module load by proposals.ts.
 */
export function registerApproveExecutors(): void {
  if (registered) return;
  registered = true;

  // ── document / create ──────────────────────────────────────────────────────
  // (B3 document-content + the composite guard stay INLINE in proposals.ts
  // before the registry lookup, since they key off payload shape, not a type
  // string.)
  registerProposalExecutor({
    key: "document/create",
    async execute({ proposal, payload, userId, input, deps }) {
      void payload;
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
      const mimeType =
        docType === "html"
          ? "text/html"
          : docType === "code"
            ? "text/plain"
            : "text/markdown";
      const metadata = await storage.upload(storageKey, content, {
        contentType: mimeType,
      });
      const versionId = randomUUID();
      const snapshot = await uploadDocumentVersionSnapshot({
        userId: docUserId,
        documentId,
        versionId,
        documentType: docType,
        mimeType: "text/markdown",
        content,
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

      await db.insert(documentVersions).values({
        id: versionId,
        documentId,
        version: 1,
        ...storedVersionValues(snapshot),
        author: "user",
        authorId: userId,
        message: "Initial version",
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

      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return { success: true };
    },
  });

  // ── channel / create_branch ────────────────────────────────────────────────
  registerProposalExecutor({
    key: "channel/create_branch",
    async execute({ proposal, payload, userId, input, deps }) {
      void payload;
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
      const caller = channelsRouter.createCaller(
        branchCallerCtx as unknown as Context
      );
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

      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return { success: true };
    },
  });

  // ── channel / merge_branch ─────────────────────────────────────────────────
  registerProposalExecutor({
    key: "channel/merge_branch",
    async execute({ proposal, payload, userId, input, deps }) {
      void payload;
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
      const caller = channelsRouter.createCaller(
        mergeCallerCtx as unknown as Context
      );
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

      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return { success: true };
    },
  });

  // ── channel / create_external ──────────────────────────────────────────────
  registerProposalExecutor({
    key: "channel/create_external",
    async execute({ proposal, payload, userId, input, deps }) {
      void payload;
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
      const caller = channelsRouter.createCaller(
        extCallerCtx as unknown as Context
      );
      await caller.createExternalChannel({
        externalSource: data.externalSource as string,
        externalChannelId: data.externalChannelId as string,
        title: data.title as string,
        externalParticipants: data.externalParticipants as string[] | undefined,
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

      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return { success: true };
    },
  });

  // ── entity / create ────────────────────────────────────────────────────────
  registerProposalExecutor({
    key: "entity/create",
    async execute({ proposal, payload, userId, input, deps }) {
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
      const storedEntityId = innerData.id as string | undefined;
      const createdEntity = (await entityCaller.create({
        proposedEntityId: storedEntityId,
        profileSlug,
        title: (innerData.title as string) || "Untitled",
        description: innerData.description as string | undefined,
        properties: innerData.properties as Record<string, unknown> | undefined,
        content: innerData.content as string | undefined,
        source: "system",
      })) as { id?: string };

      const createMaterialized: ProposalMaterializedRecord = createdEntity?.id
        ? { entityIds: [createdEntity.id] }
        : {};
      const createPayload: StoredProposalData = {
        ...(payload as StoredProposalData),
        materialized: createMaterialized,
      };

      if (proposal.sessionId && createdEntity?.id) {
        await db
          .insert(links)
          .values({
            workspaceId: proposal.workspaceId ?? null,
            fromType: "session" as LinkEndpointType,
            fromId: proposal.sessionId,
            toType: "entity" as LinkEndpointType,
            toId: createdEntity.id,
            linkType: "produced" as LinkType,
            metadata: {},
          })
          .onConflictDoNothing();
      }
      if (createdEntity?.id) {
        await deps.stampProjectMembership(proposal, [createdEntity.id], userId);
      }

      await db
        .update(proposals)
        .set({
          status: ProposalStatus.APPROVED,
          data: createPayload,
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(proposals.id, input.proposalId));

      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return { success: true };
    },
  });

  // ── entity / update ────────────────────────────────────────────────────────
  registerProposalExecutor({
    key: "entity/update",
    async execute({ proposal, payload, userId, input, deps }) {
      void payload;
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
        properties: innerData.properties as Record<string, unknown> | undefined,
        deleteProperties: innerData.deleteProperties as string[] | undefined,
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

      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return { success: true };
    },
  });

  // ── workspace / join ───────────────────────────────────────────────────────
  registerProposalExecutor({
    key: "workspace/join",
    async execute({ proposal, payload, userId, input, deps }) {
      void payload;
      const joinData = (proposal.data ?? {}) as Record<string, unknown>;
      const validatedEvent = await auditLog({
        subjectType: "workspace",
        action: "join",
        phase: "validated",
        throwOnError: true,
        subjectId: proposal.targetId,
        userId,
        workspaceId: proposal.workspaceId ?? undefined,
        correlationId:
          typeof joinData.correlationId === "string"
            ? joinData.correlationId
            : undefined,
        data: {
          role: typeof joinData.role === "string" ? joinData.role : "editor",
          agentUserId: proposal.agentUserId ?? joinData.agentUserId,
          workspaceId: proposal.workspaceId,
          approvedBy: userId,
          approvedAt: new Date().toISOString(),
          approvalComment: input.comment,
          sourceProposalId: input.proposalId,
        },
        source: "api",
      });

      const joinUpdatedData = {
        ...joinData,
        ...(validatedEvent ? { validatedEventId: validatedEvent.id } : {}),
      };

      await db
        .update(proposals)
        .set({
          status: ProposalStatus.APPROVED,
          data: joinUpdatedData,
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(proposals.id, input.proposalId));

      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return { success: true };
    },
  });

  // ── messaging.external.send (proposalType-only) ─────────────────────────────
  registerProposalExecutor({
    key: "messaging.external.send",
    async execute({ proposal, payload, userId, input, deps }) {
      const data = (proposal.data ?? {}) as Record<string, unknown>;
      const threadId = data.threadId as string | undefined;
      const body = data.body as string | undefined;
      const platform = data.platform as string | undefined;

      if (!threadId || !body) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "External message send requires threadId and body in proposal data",
        });
      }

      const msgAccount = await deps.resolveMessagingAccountForPlatform(
        userId,
        platform
      );
      if (!msgAccount) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "No messaging account found for this platform — connect one first",
        });
      }

      // Guard: only execute if not already approved (external sends are irreversible).
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      const { success: sent } = await sendExternalMessage({
        threadId,
        accountId: msgAccount.id,
        body,
        userId,
      });

      if (!sent) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message:
            "Failed to send external message — messaging connector not configured",
        });
      }

      const materializedPayload = {
        ...payload,
        sentResult: { sentAt: new Date().toISOString(), threadId, platform },
      } as unknown as typeof payload;

      await db
        .update(proposals)
        .set({
          status: ProposalStatus.APPROVED,
          data: materializedPayload,
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(proposals.id, input.proposalId));

      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return { success: true };
    },
  });

  // ── connector.action.trigger (proposalType-only) ────────────────────────────
  registerProposalExecutor({
    key: "connector.action.trigger",
    async execute({ proposal, payload, userId, input, deps }) {
      const data = (proposal.data ?? {}) as Record<string, unknown>;
      const connectionId = data.connectionId as string | undefined;
      const providerConfigKey = data.providerConfigKey as string | undefined;
      const actionName = data.actionName as string | undefined;

      if (!connectionId || !providerConfigKey || !actionName) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Connector action trigger requires connectionId, providerConfigKey, and actionName",
        });
      }

      // Guard: only execute once.
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      const { success: triggered, result: actionResult } =
        await triggerConnectorAction({
          connectionId,
          providerConfigKey,
          actionName,
          input: (data.input ?? data.payload) as
            | Record<string, unknown>
            | undefined,
        });

      if (!triggered) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to trigger connector action — Nango not configured",
        });
      }

      const materializedPayload = {
        ...payload,
        triggeredResult: {
          triggeredAt: new Date().toISOString(),
          actionName,
          result: actionResult,
        },
      } as unknown as typeof payload;

      await db
        .update(proposals)
        .set({
          status: ProposalStatus.APPROVED,
          data: materializedPayload,
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(proposals.id, input.proposalId));

      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return { success: true };
    },
  });

  // ── provider.action (proposalType-only) — AGNOSTIC EXTERNAL LAST-MILE ────────
  // Closes North Star gap #1's generic tail: approve a proposal that names an
  // arbitrary provider + HTTP method + path, and dispatch it through the SAME
  // shared `triggerProviderAction()` the `/connectors/tool-execute` endpoint
  // uses (ONE impl, two doors — mirrors sendExternalMessage). `vault://` stays
  // 501 inside the shared helper. Idempotent: skip if already APPROVED.
  registerProposalExecutor({
    key: "provider.action",
    async execute({ proposal, payload, userId, input, deps }) {
      const data = (proposal.data ?? {}) as Record<string, unknown>;
      const provider = data.provider as string | undefined;
      const method = data.method as string | undefined;
      const path = data.path as string | undefined;

      if (!provider || !method || !path) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Provider action requires provider, method, and path in proposal data",
        });
      }

      // Guard: only execute once (external proxy calls are irreversible).
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      const {
        success: executed,
        body: providerBody,
        status: providerStatus,
        error: providerError,
      } = await triggerProviderAction({
        userId,
        provider,
        method,
        path,
        body: data.body as Record<string, unknown> | undefined,
        accountHint: data.accountHint as string | undefined,
      });

      if (!executed) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message:
            providerError ??
            "Failed to execute provider action — connector not configured or no connection",
        });
      }

      const materializedPayload = {
        ...payload,
        providerResult: {
          executedAt: new Date().toISOString(),
          provider,
          method,
          path,
          status: providerStatus,
          result: providerBody,
        },
      } as unknown as typeof payload;

      await db
        .update(proposals)
        .set({
          status: ProposalStatus.APPROVED,
          data: materializedPayload,
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(proposals.id, input.proposalId));

      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return { success: true };
    },
  });

  // ── Catch-all (generic request-shaped) — replaces silent NOT_IMPLEMENTED ─────
  // resolve() returns THIS for any unmatched key. The body is the verbatim
  // generic `.validated`-emit path PLUS the old shared tail (status flip +
  // reportProposalOutcome + emitProposalReviewed). Only a payload that ALSO
  // fails isRequestShapedProposalData throws — that throw is now EXPLICIT here,
  // no longer a forgotten-branch fallthrough.
  registerProposalExecutor({
    key: "*/*",
    async execute({ proposal, payload, userId, input, deps }) {
      const isRequestShaped = deps.isRequestShapedProposalData as (
        p: unknown
      ) => boolean;

      if (isRequestShaped(payload)) {
        const {
          targetType,
          changeType,
          data: requestData,
          correlationId: proposalCorrelationId,
        } = payload as StoredProposalData & {
          targetType: string;
          changeType: string;
          data: unknown;
          correlationId?: string;
        };

        const eventPayload: Record<string, unknown> =
          typeof requestData === "object" && requestData !== null
            ? { ...(requestData as Record<string, unknown>) }
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

        const validatedEvent = await auditLog({
          subjectType: targetType,
          action: changeType,
          phase: "validated",
          throwOnError: true,
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
            sourceProposalId: input.proposalId,
          },
          source: "api",
        });

        if (validatedEvent && payload) {
          (payload as { validatedEventId?: string }).validatedEventId =
            validatedEvent.id;
        }
      } else {
        // Payload doesn't match any known request shape and targetType was not
        // handled by a specific executor above — throw rather than silently succeed.
        throw new TRPCError({
          code: "NOT_IMPLEMENTED",
          message: `Proposal approval for type '${proposal.targetType}' is not yet implemented`,
        });
      }

      await db
        .update(proposals)
        .set({
          status: ProposalStatus.APPROVED,
          ...(isRequestShaped(payload) ? { data: payload } : {}),
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(proposals.id, input.proposalId));

      // Report to IS telemetry (fire-and-forget — never blocks)
      deps.reportProposalOutcome({
        proposalId: input.proposalId,
        outcome: "approved",
        sourceMessageId: proposal.sourceMessageId,
        agentUserId: proposal.agentUserId,
        targetType: proposal.targetType,
        proposalType: proposal.proposalType,
        source: (proposal.data as Record<string, unknown> | null)?.source as
          | string
          | undefined,
      });

      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return { success: true };
    },
  });
}
