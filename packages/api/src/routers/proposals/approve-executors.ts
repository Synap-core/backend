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
  skills,
  documents,
  documentVersions,
  focusSessions,
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
import type { RendererRef } from "@synap/database";
import { storage } from "@synap/storage";
import { setProfileRenderer } from "../../services/profiles/set-profile-renderer.js";
import { auditLog } from "../../utils/audit-log.js";
import { emitHubRealtimeEvent } from "../../utils/domain-event-bridge.js";
import { channelsRouter } from "../channels.js";
import { entitiesRouter as regularEntitiesRouter } from "../entities.js";
import {
  sendExternalMessage,
  triggerProviderAction,
  type ConnectionSelector,
} from "../../connectors/external-dispatch.js";
import { getMessagingConnector } from "../../connectors/index.js";
import { runResolvedSkill } from "../../services/capabilities/execute-capability.js";
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

  // ── focus_session / create ──────────────────────────────────────────────────
  // A gated createFocusSession (AI caller in a review-required workspace) lands
  // here on approval. Without this executor the `*/*` catch-all flipped the
  // proposal APPROVED but NEVER inserted the session row — approving a
  // focus-session proposal materialized NOTHING, and update/list/complete (which
  // scope by the operator userId) could never find it. Structure mirrors
  // entity/create; the insert mirrors services/focus-sessions/create-session.ts.
  //
  // CONSERVATIVE NOTE: createFocusSession only persists { goal, templateId } into
  // the permission `data` at propose time, so subjectEntityId / channelId /
  // expectedOutputs / agentIds are NOT carried through the proposal — they default
  // to null/[] here. Preserving them would require widening the gate `data` in
  // create-session.ts (flagged for review). workspaceId / projectId come from the
  // proposal row.
  registerProposalExecutor({
    key: "focus_session/create",
    async execute({ proposal, userId, input, deps }) {
      const innerData = ((proposal.data as Record<string, unknown>)?.data ??
        {}) as Record<string, unknown>;
      const goal = innerData.goal as string | undefined;
      if (!goal) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Focus session proposal is missing goal",
        });
      }

      // Idempotency: approve is not status-guarded before dispatch and the row
      // uses a fixed id, so skip if this proposal was already materialized.
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      const [created] = await db
        .insert(focusSessions)
        .values({
          // id = proposal.targetId so any link built at propose time resolves.
          id: proposal.targetId,
          workspaceId: proposal.workspaceId,
          projectId: proposal.projectId,
          subjectEntityId:
            (innerData.subjectEntityId as string | undefined) ?? null,
          // userId = the operator/approver so update/list/complete (scoped by
          // operator userId) can resolve this session.
          userId,
          goal,
          templateId: (innerData.templateId as string | undefined) ?? null,
          expectedOutputs:
            (innerData.expectedOutputs as unknown[] | undefined) ?? [],
          channelId: (innerData.channelId as string | undefined) ?? null,
          agentIds: (innerData.agentIds as string[] | undefined) ?? [],
          status: "active",
        })
        .onConflictDoNothing()
        .returning();

      // Mirror create-session.ts:134 so the browser mirrors the new session live.
      if (created) {
        emitHubRealtimeEvent({
          eventType: "focus_session.create.completed",
          subjectId: created.id,
          userId,
          data: {
            id: created.id,
            workspaceId: created.workspaceId,
            status: created.status,
            goal: created.goal,
            progress: created.progress,
          },
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

      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return { success: true };
    },
  });

  // ── profile / renderer.set ──────────────────────────────────────────────────
  // Materializes an approved "bind a cell as a profile renderer" proposal via
  // the SAME shared write path the governed Hub route uses on operator
  // auto-apply. Without this the proposal would fall to the `*/*` catch-all,
  // which emits a `.validated` event but never writes the renderer.
  registerProposalExecutor({
    key: "profile/renderer.set",
    async execute({ proposal, userId, input, deps }) {
      const innerData = ((proposal.data as Record<string, unknown>)?.data ??
        {}) as Record<string, unknown>;
      const profileSlug = innerData.profileSlug as string | undefined;
      const slot = innerData.slot as
        | "list"
        | "detail"
        | "dashboard"
        | undefined;
      const ref = innerData.ref as RendererRef | undefined;
      const scope =
        (innerData.scope as "workspace" | "pod" | undefined) ?? "workspace";
      if (!profileSlug || !slot || !ref) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Renderer proposal is missing profileSlug/slot/ref",
        });
      }

      // Idempotency: skip if already materialized.
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      await setProfileRenderer({
        userId,
        workspaceId: proposal.workspaceId,
        profileSlug,
        slot,
        ref,
        scope,
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

  // ── entity / delete ──────────────────────────────────────────────────────
  // Materialize an approved delete proposal (agents can't delete directly —
  // their role gates auto-execution, so a delete is proposed; this executor is
  // what makes approval actually delete). The APPROVER (userId) authorizes it
  // with their own role; the delete procedure re-checks and soft-deletes inline
  // (owner holds `delete`). Without this, an approved delete proposal was a
  // silent no-op.
  registerProposalExecutor({
    key: "entity/delete",
    async execute({ proposal, payload, userId, input, deps }) {
      void payload;
      const innerData = ((proposal.data as Record<string, unknown>)?.data ??
        {}) as Record<string, unknown>;
      const entityId = (innerData.id as string) || proposal.targetId;
      // Workspace-scoped: verify the approver's membership + role. Pod-wide
      // (null workspace): the approver owns the pod, run at pod scope.
      const wsId = proposal.workspaceId ?? undefined;
      let workspaceRole = "owner";
      if (wsId) {
        const membership = await getWorkspaceMembership(db, wsId, userId);
        if (!membership) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "No workspace access",
          });
        }
        workspaceRole = membership.role;
      }
      const entityCaller = regularEntitiesRouter.createCaller({
        db,
        authenticated: true as const,
        userId,
        ...(wsId ? { workspaceId: wsId } : {}),
        workspaceRole,
      } as unknown as Context);
      await entityCaller.delete({ id: entityId, source: "system" });

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

      // Provider-driven account resolution. Connectors with per-user accounts
      // (Unipile/Stalwart) require a messaging_accounts row; server-managed
      // connectors (Discord — shared bot token) do NOT, and ignore accountId.
      const connector = await getMessagingConnector(platform);
      const needsAccount = connector ? connector.requiresAccount() : true;

      let accountId = "";
      if (needsAccount) {
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
        accountId = msgAccount.id;
      }

      // Guard: only execute if not already approved (external sends are irreversible).
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      // BYPASS the capability gate: this send is already past governance (the
      // proposal was approved). `alreadyApproved` makes sendExternalMessage
      // dispatch directly, exactly once — no double-gate on re-entry.
      const { success: sent } = await sendExternalMessage({
        threadId,
        accountId,
        body,
        userId,
        alreadyApproved: true,
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

  // ── capability.run (proposalType-only) — AGNOSTIC CAPABILITY LAST-MILE ───────
  // Re-entry for a `propose` verdict from POST /capabilities/execute (and any
  // other capability launcher): approve → run the backing skill through the SAME
  // post-gate runResolvedSkill the door uses (ONE kind-branch, two doors) so an
  // approved declarative/builtin verb routes to its correct tier. The gate
  // already ran when the proposal was created, so this does NOT re-gate.
  // Idempotent: skip if already APPROVED.
  registerProposalExecutor({
    key: "capability.run",
    async execute({ proposal, payload, userId, input, deps }) {
      const data = (proposal.data ?? {}) as Record<string, unknown>;
      const skillId = data.skillId as string | undefined;
      const parameters = (data.parameters ?? {}) as Record<string, unknown>;

      if (!skillId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "capability.run requires skillId in proposal data",
        });
      }

      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      // Route through the SAME post-gate runner the door uses, so an approved
      // `declarative`/`builtin` verb is executed by its correct tier instead of
      // being blindly shipped to the IS isolate. Load the row the runner needs.
      const [skillRow] = await db
        .select({
          id: skills.id,
          name: skills.name,
          kind: skills.kind,
          providerSpec: skills.providerSpec,
        })
        .from(skills)
        .where(eq(skills.id, skillId))
        .limit(1);
      if (!skillRow) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `capability.run skill "${skillId}" not found`,
        });
      }
      const runOutcome = await runResolvedSkill(skillRow, parameters, {
        userId,
        workspaceId: proposal.workspaceId ?? null,
        connectionSelector:
          (data.connectionSelector as ConnectionSelector | null) ?? null,
      });
      if (runOutcome.kind === "not_found") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: runOutcome.message,
        });
      }
      if (runOutcome.kind === "deny") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: runOutcome.reason,
        });
      }
      const runResult = runOutcome.result;

      const materializedPayload = {
        ...payload,
        runResult,
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

  // NOTE (W3b): the `connector.action.trigger` executor (Nango named-action 3rd
  // path) was RETIRED. The agnostic `provider.action` executor below + the shared
  // `triggerProviderAction()` dispatcher (Nango `proxyRequest`) is the ONE governed
  // external-action door — there is no separate named-action path to keep in sync.

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
        baseUrlOverride:
          (data.baseUrlOverride as string | undefined) ?? undefined,
        workspaceId: (data.workspaceId as string | undefined) ?? undefined,
        // Governed Door-2 re-entry: a human already approved this proposal, so
        // bypass the capability-execution gate (no re-propose) — exactly once.
        alreadyApproved: true,
        sourceProposalId: input.proposalId,
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

  // ── capability/run — CAPABILITY-EXECUTION LAST-MILE (Wave 3a) ────────────────
  // Materializes a `propose`/`propose-each` verdict from rung 2.6: on approval,
  // RE-ENTER the same execute path the auto-path uses, so approve-path and
  // auto-path share ONE execution impl. Mirrors provider.action: idempotent
  // (skip if already APPROVED), flips APPROVED + emitProposalReviewed.
  //
  // ── The `alreadyApproved` bypass contract (for Wave 3b) ──────────────────────
  // The chokepoint Wave 3b wires (triggerProviderAction / skill-execute /
  // automation nodes) calls `gateCapabilityExecution()` FIRST. On the auto path
  // the gate returns `{ decision: "run" }` and the chokepoint dispatches inline.
  // On the propose path the gate returns `{ decision: "propose", … }`, a
  // `capability/run` proposal is created, and THIS executor runs on approval —
  // re-entering the SAME dispatch. To stop the re-entry from proposing a SECOND
  // time, the chokepoint's execute input MUST carry an `alreadyApproved: true`
  // (a.k.a. `bypassGovernance`) flag that SHORT-CIRCUITS the gate to `run`. The
  // contract Wave 3b must honor:
  //   • input field name: `alreadyApproved?: boolean` on the capability-execute
  //     call (and `sourceProposalId?: string` for audit).
  //   • when `alreadyApproved === true`, the chokepoint SKIPS
  //     `gateCapabilityExecution()` entirely and dispatches directly — exactly
  //     once — so an approved proposal never loops back into a new proposal.
  //   • only THIS executor (and the auto `run` decision) may set it true; no
  //     external caller may supply it.
  registerProposalExecutor({
    key: "capability/run",
    async execute({ proposal, userId, input, deps }) {
      const data = (proposal.data ?? {}) as Record<string, unknown>;
      const capabilityKind = data.capabilityKind as
        | "tool"
        | "skill"
        | "command"
        | undefined;
      const capabilityId = data.capabilityId as string | undefined;

      if (!capabilityKind || !capabilityId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "capability/run proposal requires capabilityKind and capabilityId in proposal data",
        });
      }

      // Guard: only execute once (the run may be an irreversible external write).
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      // Re-enter the SAME execute path the auto path uses. The `alreadyApproved`
      // bypass (documented above) is set so the chokepoint does NOT re-propose.
      if (capabilityKind === "tool") {
        const provider = (data.provider as string | undefined) ?? capabilityId;
        const method = (data.method as string | undefined) ?? "POST";
        const path = (data.path as string | undefined) ?? "/";
        const { success: executed, error: providerError } =
          await triggerProviderAction({
            userId,
            provider,
            method,
            path,
            body: data.body as Record<string, unknown> | undefined,
            accountHint: data.accountHint as string | undefined,
            baseUrlOverride:
              (data.baseUrlOverride as string | undefined) ?? undefined,
            workspaceId: (data.workspaceId as string | undefined) ?? undefined,
            // Replay the caller's run-time connection pick so the approved run
            // uses the SAME credential that was selected at propose time (not the
            // capability's default). Persisted into proposal.data at propose time.
            connectionSelector:
              (data.connectionSelector as
                | { connectionId?: string; contextObjectId?: string }
                | null
                | undefined) ?? undefined,
            // BYPASS the capability-execution gate: a human already approved THIS
            // proposal, so this is the governed Door-2 re-entry — dispatch directly,
            // exactly once, without re-proposing (Wave 3a `alreadyApproved` contract).
            alreadyApproved: true,
            sourceProposalId: input.proposalId,
          });
        if (!executed) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message:
              providerError ??
              "Failed to execute granted capability — connector not configured or no connection",
          });
        }
      }
      // skill / command dispatch is wired by Wave 3b (skill-execute door); the
      // approval + status flip below still apply so the proposal closes cleanly.

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
