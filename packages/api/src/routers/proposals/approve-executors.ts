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
  projects,
  ProjectRepository,
  EventRepository,
  sql,
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
  mergeEntities,
  PropertyIndexService,
  type MergeMaterializedStamp,
  entities,
  links,
  relations,
  projectMembers,
  and,
  drizzleSql,
  type LinkEndpointType,
  type LinkType,
} from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import {
  isEntityMergeProposalData,
  type ProposalMaterializedRecord,
} from "@synap-core/types";
import type { RendererRef } from "@synap/database";
import { storage } from "@synap/storage";
import { setProfileRenderer } from "../../services/profiles/set-profile-renderer.js";
import { createAndLinkPropertyDef } from "../../services/profiles/create-and-link-property-def.js";
import { auditLog } from "../../utils/audit-log.js";
import { emitHubRealtimeEvent } from "../../utils/domain-event-bridge.js";
import { emitSideEffects } from "@synap/events";
import { channelsRouter } from "../channels.js";
import { entitiesRouter as regularEntitiesRouter } from "../entities.js";
import { projectsRouter } from "../projects.js";
import { viewsRouter } from "../views.js";
import {
  sendExternalMessage,
  triggerProviderAction,
  type ConnectionSelector,
} from "../../connectors/external-dispatch.js";
import { getMessagingConnector } from "../../connectors/index.js";
import { runResolvedSkill } from "../../services/capabilities/execute-capability.js";
import { applyMarketInstall } from "../../services/capabilities/marketplace-install.js";
import type { CatalogKind } from "@synap/jobs";
import type { Context } from "../../context.js";
import {
  registerProposalExecutor,
  type StoredProposalData,
} from "./execution-registry.js";
// Type-only (erased at compile) so it can't trip the skills.ts circular-import
// the value paths below avoid via dynamic `import("../skills.js")`.
import type { InsertSkillGovernedInput } from "../skills.js";

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

  // ── property_def / create ───────────────────────────────────────────────────
  // A gated createPropertyDef (AI caller outside DEFAULT_AUTO_APPROVE, or a
  // SAFE-mode workspace) lands here on approval. Uses the SAME
  // `createAndLinkPropertyDef` helper as the direct-apply branch in
  // hub-protocol/profiles.ts#createPropertyDef, so approval always performs
  // BOTH the property-def create AND the profile_properties link — a
  // property def is invisible to its profile until linked.
  registerProposalExecutor({
    key: "property_def/create",
    async execute({ proposal, payload, userId, input, deps }) {
      const innerData = ((proposal.data as Record<string, unknown>)?.data ??
        {}) as Record<string, unknown>;
      const proposalWorkspaceId = proposal.workspaceId || null;
      const workspaceId =
        (innerData.workspaceId as string | undefined) ?? proposalWorkspaceId;
      if (!workspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Property def proposal is missing workspaceId",
        });
      }

      await createAndLinkPropertyDef({
        userId,
        workspaceId,
        profileId: innerData.profileId as string | undefined,
        slug: innerData.slug as string,
        valueType: innerData.valueType as
          | "string"
          | "number"
          | "boolean"
          | "object"
          | "array"
          | "date"
          | "secret"
          | "entity_id",
        constraints: innerData.constraints as
          Record<string, unknown> | undefined,
        uiHints: innerData.uiHints as Record<string, unknown> | undefined,
        overlay: innerData.overlay === true,
        required: innerData.required as boolean | undefined,
        defaultValue: innerData.defaultValue,
        displayOrder: innerData.displayOrder as number | undefined,
      });

      // No revert path exists for property_def creates (mirrors "no delete
      // endpoints exposed to agents" — see module docstring), so `materialized`
      // is intentionally left empty rather than misusing `entityIds`/
      // `documentIds` for a row type ProposalMaterializedRecord has no field
      // for; revert correctly reports "unsupported" for this proposal type.
      const materialized: ProposalMaterializedRecord = {};
      const approvedPayload: StoredProposalData = {
        ...(payload as StoredProposalData),
        materialized,
      };

      await db
        .update(proposals)
        .set({
          status: ProposalStatus.APPROVED,
          data: approvedPayload,
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

  // ── project / create ─────────────────────────────────────────────────────────
  // A gated createProject (a workspace member whose role lacks `create`, filed as
  // a reviewable proposal) lands here on approval. Without this executor the `*/*`
  // catch-all threw NOT_IMPLEMENTED and the proposal could never materialize.
  // Materializes via the SAME projectsRouter.create the direct path uses — re-run
  // as the APPROVER (no agentUserId ⇒ the operator is the authority ⇒ the
  // re-entrant gate auto-grants), so audit/events/placement match the direct
  // create exactly. Mirrors entity/create's membership-scoped caller +
  // focus_session/create's idempotency guard.
  //
  // DATA-SHAPE NOTE: the propose gate (routers/projects.ts + hub-protocol/rest/
  // projects.ts) stores only { name } in the proposal `data`, so only the name is
  // reconstructed today — description/status/settings/metadata are NOT carried
  // through the proposal and fall to create-time defaults (create-then-configure:
  // a name is the minimum for the project to exist). The other fields are read
  // defensively so a future gate-`data` widening flows through with no change here.
  registerProposalExecutor({
    key: "project/create",
    async execute({ proposal, userId, input, deps }) {
      const innerData = ((proposal.data as Record<string, unknown>)?.data ??
        {}) as Record<string, unknown>;
      const name = innerData.name as string | undefined;
      if (!name) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Project proposal is missing name",
        });
      }
      const workspaceId = proposal.workspaceId ?? null;
      if (!workspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Project creation proposal is missing a valid workspaceId",
        });
      }

      // Idempotency: approve is not status-guarded before dispatch, so skip if
      // this proposal was already materialized (createCaller mints a fresh id
      // each run — a re-approve without this guard would double-create).
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      const membership = await getWorkspaceMembership(db, workspaceId, userId);
      if (!membership) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "No workspace access",
        });
      }
      const projectCaller = projectsRouter.createCaller({
        db,
        authenticated: true as const,
        userId,
        workspaceId,
        workspaceRole: membership.role,
      } as unknown as Context);
      await projectCaller.create({
        name,
        description: innerData.description as string | undefined,
        status: innerData.status as
          "active" | "archived" | "completed" | undefined,
        settings: innerData.settings as Record<string, unknown> | undefined,
        metadata: innerData.metadata as Record<string, unknown> | undefined,
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

  // ── project / archive ─────────────────────────────────────────────────────────
  // The librarian archiver (packages/jobs) files these: a stale ACTIVE project
  // (>30d old, zero belongs_to_project members, zero project_members) is proposed
  // for archival. On approval the project's status flips to `archived`.
  //
  // Runs the flip via ProjectRepository.update as the project's OWNER (not the
  // approver) — mirrors entity/merge's "act as the data owner" so it works for
  // POD-WIDE (null-workspace) projects too (workspaceProcedure requires a
  // workspace, so the direct-router path can't archive a pod-wide project). The
  // proposal data is flat (insertPendingProposal), so the project id is read from
  // proposal.targetId.
  registerProposalExecutor({
    key: "project/archive",
    async execute({ proposal, userId, input, deps }) {
      const projectId = proposal.targetId;

      // Idempotency: approve is not status-guarded before dispatch.
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      const project = await db.query.projects.findFirst({
        where: eq(projects.id, projectId),
        columns: { id: true, userId: true, workspaceId: true, status: true },
      });
      if (!project) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Project to archive no longer exists",
        });
      }

      // Workspace-scoped projects: verify the approver has workspace access.
      if (project.workspaceId) {
        const membership = await getWorkspaceMembership(
          db,
          project.workspaceId,
          userId
        );
        if (!membership) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "No workspace access",
          });
        }
      }

      // Re-validate zero-gravity AT APPROVAL TIME: the librarian proposed this
      // days ago possibly — if entities or members accrued since, the stale
      // "0 links for 30 days" rationale no longer holds. No-op instead of
      // archiving a now-active project (approval still closes the proposal).
      const [{ linkCount }] = await db
        .select({ linkCount: drizzleSql<number>`count(*)::int` })
        .from(relations)
        .where(
          and(
            eq(relations.targetEntityId, projectId),
            eq(relations.type, "belongs_to_project")
          )
        );
      const [{ memberCount }] = await db
        .select({ memberCount: drizzleSql<number>`count(*)::int` })
        .from(projectMembers)
        .where(eq(projectMembers.projectId, projectId));
      const gravityAppeared = Number(linkCount) > 0 || Number(memberCount) > 0;

      if (!gravityAppeared && project.status !== "archived") {
        const eventRepo = new EventRepository(sql);
        const projectRepo = new ProjectRepository(db, eventRepo);
        // Act as the OWNER — ProjectRepository.update gates on userId, and
        // pod-wide projects are owned by their creator.
        await projectRepo.update(
          projectId,
          { status: "archived" },
          project.userId
        );

        auditLog({
          subjectType: "project",
          action: "update",
          phase: "completed",
          subjectId: projectId,
          userId: project.userId,
          workspaceId: project.workspaceId ?? undefined,
        });

        emitSideEffects({
          subjectType: "project",
          action: "update",
          subjectId: projectId,
          userId: project.userId,
          workspaceId: project.workspaceId ?? undefined,
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

  // ── view / create ────────────────────────────────────────────────────────────
  // A gated createView (agent-authored — the views router threads agentUserId +
  // source into the gate — or a member whose role lacks `create`) lands here on
  // approval. Without this executor the `*/*` catch-all threw NOT_IMPLEMENTED.
  // Materializes via the SAME viewsRouter.create the direct path uses — re-run as
  // the APPROVER (no agentUserId ⇒ the re-entrant gate auto-grants for the
  // operator authority), so the canvas-document / config / ViewEvents side-effects
  // match the direct create exactly. Pod-wide (null workspace) views run at pod
  // scope; workspace-scoped views verify the approver's membership (entity/create).
  //
  // DATA-SHAPE NOTE: the propose gate (routers/views.ts + hub-protocol/views.ts)
  // stores only { name, type, scopeProfileIds } — enough to materialize a
  // structured view; `config` / `initialContent` (bento layout, canvas content)
  // are NOT carried through the proposal and fall to create-time defaults
  // (create-then-configure). Fields are read defensively so a future gate-`data`
  // widening flows through unchanged.
  registerProposalExecutor({
    key: "view/create",
    async execute({ proposal, userId, input, deps }) {
      const innerData = ((proposal.data as Record<string, unknown>)?.data ??
        {}) as Record<string, unknown>;
      const name = innerData.name as string | undefined;
      const type = innerData.type as string | undefined;
      if (!name || !type) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "View proposal is missing name/type",
        });
      }

      // Idempotency: skip if already materialized (createCaller mints a fresh
      // view id each run).
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      const workspaceId = proposal.workspaceId ?? null;
      let viewCallerCtx: {
        db: typeof db;
        authenticated: true;
        userId: string;
        workspaceId: string | null;
        workspaceRole: string;
      };
      if (workspaceId) {
        const membership = await getWorkspaceMembership(
          db,
          workspaceId,
          userId
        );
        if (!membership) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "No workspace access",
          });
        }
        viewCallerCtx = {
          db,
          authenticated: true as const,
          userId,
          workspaceId,
          workspaceRole: membership.role,
        };
      } else {
        viewCallerCtx = {
          db,
          authenticated: true as const,
          userId,
          workspaceId: null,
          workspaceRole: "owner",
        };
      }

      const viewCaller = viewsRouter.createCaller(
        viewCallerCtx as unknown as Context
      );
      const createArgs = {
        name,
        type,
        workspaceId: workspaceId ?? undefined,
        scopeProfileIds: innerData.scopeProfileIds as string[] | undefined,
        description: innerData.description as string | undefined,
        config: innerData.config as Record<string, unknown> | undefined,
        initialContent: innerData.initialContent,
      };
      await viewCaller.create(
        createArgs as Parameters<typeof viewCaller.create>[0]
      );

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

  // ── skill / create ───────────────────────────────────────────────────────────
  // (object-proposal manifest W1) A gated skill create (agent-authored, or a
  // member whose role lacks `create`) lands here on approval. Materializes via
  // the SAME insertSkillGoverned door the direct paths use — re-run as the
  // APPROVER (no agentUserId ⇒ the re-entrant gate auto-grants for the operator
  // authority), so audit / side-effects / born-approved rules match the direct
  // create exactly. The propose gate widened `data` to the full insert shape, so
  // kind/code/body/scope/providerSpec/… all flow through here.
  //
  // targetId NOTE (decision B): insertSkillGoverned mints its own skillId and
  // ignores a caller-supplied id, so the materialized skill's id is NOT yet the
  // proposal's pre-minted targetId — adoption is a follow-up (see wave report).
  registerProposalExecutor({
    key: "skill/create",
    async execute({ proposal, userId, input, deps }) {
      const innerData = ((proposal.data as Record<string, unknown>)?.data ??
        {}) as Record<string, unknown>;
      const name = innerData.name as string | undefined;
      if (!name) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Skill proposal is missing name",
        });
      }

      // Idempotency: insertSkillGoverned mints a fresh id each run, so a
      // re-approve without this guard would double-create.
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      const { insertSkillGoverned } = await import("../skills.js");
      const result = await insertSkillGoverned({
        ...(innerData as Record<string, unknown>),
        // Own the skill as the APPROVER (mirrors project/view) — no agentUserId
        // so the re-entrant gate auto-grants for the operator authority. `id` in
        // innerData is stripped by insertSkillGoverned (it mints its own).
        userId,
        agentUserId: undefined,
        auditSource: "proposal_approval",
      } as unknown as InsertSkillGovernedInput);
      if (result.status === "denied") {
        throw new TRPCError({ code: "FORBIDDEN", message: result.reason });
      }
      if (result.status === "proposed") {
        // The approver IS the authority — the re-entrant gate should auto-grant.
        // A nested proposal means the approver lacks create rights; surface it
        // rather than silently flipping the proposal APPROVED with nothing built.
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Skill approval unexpectedly re-proposed",
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

  // ── automation / create ──────────────────────────────────────────────────────
  // (object-proposal manifest W1) A gated automation create (agent-authored —
  // the automations router only gates the `agentUserId` path) lands here on
  // approval. Materializes via the SAME automationsRouter.create the direct path
  // uses — re-run as the APPROVER with NO agentUserId, which takes the operator
  // branch (RBAC verify, then direct insert, never re-propose). The propose gate
  // widened `data` to the full create input, so triggerConfig / flowDefinition /
  // status / metadata / state all flow through (flowDefinition is required).
  //
  // targetId NOTE (decision B): automationsRouter.create does not accept a
  // caller-supplied id (DB-generated) — adoption is a follow-up.
  registerProposalExecutor({
    key: "automation/create",
    async execute({ proposal, userId, input, deps }) {
      const innerData = ((proposal.data as Record<string, unknown>)?.data ??
        {}) as Record<string, unknown>;
      const name = innerData.name as string | undefined;
      const triggerType = innerData.triggerType as string | undefined;
      const flowDefinition = innerData.flowDefinition;
      if (!name || !triggerType || !flowDefinition) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Automation proposal is missing name/triggerType/flowDefinition",
        });
      }

      // Idempotency: createCaller mints a fresh automation id each run.
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      const { automationsRouter } = await import("../automations.js");
      const automationCaller = automationsRouter.createCaller({
        db,
        authenticated: true as const,
        userId,
      } as unknown as Context);
      const createArgs = {
        workspaceId: proposal.workspaceId ?? undefined,
        name,
        description: innerData.description as string | undefined,
        triggerType,
        triggerConfig: innerData.triggerConfig as
          Record<string, unknown> | undefined,
        flowDefinition,
        status: innerData.status as string | undefined,
        metadata: innerData.metadata as Record<string, unknown> | undefined,
        state: innerData.state as Record<string, unknown> | undefined,
      };
      await automationCaller.create(
        createArgs as Parameters<typeof automationCaller.create>[0]
      );

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

  // ── playbook / create ────────────────────────────────────────────────────────
  // (object-proposal manifest W1) A gated playbook RAW create lands here on
  // approval (the promote path emits `playbook/promote` — its own executor
  // below — so this key materializes exactly one shape). Materializes via the
  // SAME playbooksRouter.create the direct path uses — re-run as the APPROVER
  // with NO agentUserId + no source, so the gate auto-grants for the operator.
  // The propose gate widened `data` to the full create input (goalTemplate is
  // required by createInputSchema).
  //
  // targetId NOTE (decision B): playbooksRouter.create does not accept a
  // caller-supplied id (DB-generated) — adoption is a follow-up.
  registerProposalExecutor({
    key: "playbook/create",
    async execute({ proposal, userId, input, deps }) {
      const innerData = ((proposal.data as Record<string, unknown>)?.data ??
        {}) as Record<string, unknown>;
      const name = innerData.name as string | undefined;
      const goalTemplate = innerData.goalTemplate as string | undefined;
      if (!name || !goalTemplate) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Playbook proposal is missing name/goalTemplate",
        });
      }
      const workspaceId = proposal.workspaceId ?? null;
      if (!workspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Playbook creation proposal is missing a valid workspaceId",
        });
      }

      // Idempotency: createCaller mints a fresh playbook id each run.
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      const membership = await getWorkspaceMembership(db, workspaceId, userId);
      if (!membership) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "No workspace access",
        });
      }
      const { playbooksRouter } = await import("../playbooks.js");
      const playbookCaller = playbooksRouter.createCaller({
        db,
        authenticated: true as const,
        userId,
        workspaceId,
        workspaceRole: membership.role,
      } as unknown as Context);
      const createArgs = {
        name,
        description: innerData.description as string | undefined,
        goalTemplate,
        params: innerData.params as Record<string, unknown>[] | undefined,
        inputStrategy: innerData.inputStrategy as
          Record<string, unknown> | undefined,
        channelSpec: innerData.channelSpec as
          Record<string, unknown> | undefined,
        expectedOutputs: innerData.expectedOutputs as
          Record<string, unknown>[] | undefined,
        stages: innerData.stages as Record<string, unknown>[] | undefined,
        subjectProfile: innerData.subjectProfile as
          Record<string, unknown> | undefined,
        schedule: innerData.schedule,
        executor: innerData.executor,
        status: innerData.status,
        // The propose gate stores the Layer-2 context skill in `data`; without
        // reading it back here an APPROVED playbook materialized with no context
        // skill at all — i.e. the feature was a no-op on the agent-proposed path,
        // which is exactly the path that needs a generated HOW. Note this
        // re-runs with NO agentUserId, so the skill is born approved: the human
        // approval genuinely covers it, and the executor will inject it.
        contextSkill: innerData.contextSkill as
          { name?: string; body: string } | undefined,
      };
      await playbookCaller.create(
        createArgs as Parameters<typeof playbookCaller.create>[0]
      );

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

  // ── playbook / promote ───────────────────────────────────────────────────────
  // (object-proposal manifest W1) A gated session→playbook PROMOTE lands here on
  // approval (the promote gate emits `playbook/promote`, distinct from raw
  // create). Materializes via the SAME playbooksRouter.promote the direct path
  // uses — re-run as the APPROVER with NO agentUserId + no source; promote is a
  // protectedProcedure that loads the session by id and gates on the LOADED
  // session's workspace, so the caller ctx needs only userId. The stored `data`
  // carries { sessionId, name, description } — the rest is snapshotted FROM the
  // session by promoteSessionToPlaybook, so no further widening is needed.
  //
  // targetId NOTE (decision B): promoteSessionToPlaybook mints the playbook id —
  // adoption is a follow-up.
  registerProposalExecutor({
    key: "playbook/promote",
    async execute({ proposal, userId, input, deps }) {
      const innerData = ((proposal.data as Record<string, unknown>)?.data ??
        {}) as Record<string, unknown>;
      const sessionId = innerData.sessionId as string | undefined;
      if (!sessionId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Playbook promote proposal is missing sessionId",
        });
      }

      // Idempotency: promoteSessionToPlaybook mints a fresh playbook id each run.
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      const { playbooksRouter } = await import("../playbooks.js");
      const playbookCaller = playbooksRouter.createCaller({
        db,
        authenticated: true as const,
        userId,
      } as unknown as Context);
      const promoteArgs = {
        sessionId,
        name: innerData.name as string | undefined,
        description: innerData.description as string | undefined,
      };
      await playbookCaller.promote(
        promoteArgs as Parameters<typeof playbookCaller.promote>[0]
      );

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
        "list" | "detail" | "dashboard" | undefined;
      const ref = innerData.ref as RendererRef | null | undefined;
      const scope =
        (innerData.scope as "workspace" | "pod" | undefined) ?? "workspace";
      if (!profileSlug || !slot || ref === undefined) {
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

  // ── entity / merge ───────────────────────────────────────────────────────
  // Pod Hygiene W0: near-duplicate → glass-box merge. ALWAYS proposal-gated
  // (`merge` ∈ DESTRUCTIVE_ACTIONS). Materializes via EntityMergeService only
  // (one door). Stamps data.materialized.merge + full snapshots for unmerge.
  registerProposalExecutor({
    key: "entity/merge",
    async execute({ proposal, payload, userId, input, deps }) {
      void payload;
      const raw = proposal.data;
      if (!isEntityMergeProposalData(raw)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "entity/merge proposal data is missing winnerId/loserId/confidence/method",
        });
      }

      // Membership: workspace-scoped proposals require access; pod-wide (null)
      // runs as the approver who owns the entities (mergeEntities checks userId).
      const wsId = proposal.workspaceId ?? undefined;
      if (wsId) {
        const membership = await getWorkspaceMembership(db, wsId, userId);
        if (!membership) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "No workspace access",
          });
        }
      }

      // mergeEntities asserts entity.userId === input.userId. Run as the
      // DATA OWNER (sourceId / winner row), not the approver — admins may
      // review but the data plane is still the owner's graph.
      const winnerRow = await db.query.entities.findFirst({
        where: eq(entities.id, raw.winnerId),
        columns: {
          id: true,
          userId: true,
          profileId: true,
          workspaceId: true,
          properties: true,
        },
      });
      if (!winnerRow) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Winner entity not found",
        });
      }
      const ownerUserId =
        (typeof raw.sourceId === "string" && raw.sourceId) || winnerRow.userId;

      let result;
      try {
        result = await mergeEntities(db, {
          winnerId: raw.winnerId,
          loserId: raw.loserId,
          userId: ownerUserId,
        });
      } catch (err) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: err instanceof Error ? err.message : "Entity merge failed",
        });
      }

      // Winner properties may have grown (fill-null) — reindex hot props
      // (email etc.) so identity/filter paths stay correct.
      if (winnerRow.profileId) {
        try {
          const indexService = new PropertyIndexService(db);
          const winnerAfter = await db.query.entities.findFirst({
            where: eq(entities.id, result.winnerId),
            columns: { properties: true, profileId: true, workspaceId: true },
          });
          if (winnerAfter?.profileId) {
            await indexService.reindexEntity(
              result.winnerId,
              (winnerAfter.properties as Record<string, unknown>) ?? {},
              winnerAfter.profileId,
              winnerAfter.workspaceId
            );
          }
        } catch (err) {
          // Best-effort — merge already committed; search side-effects still run.
          void err;
        }
      }

      // Invertibility stamp for full unmerge (mirrors MergeMaterializedStamp).
      const m = result.materialized;
      const mergeStamp: NonNullable<ProposalMaterializedRecord["merge"]> &
        MergeMaterializedStamp & { winnerId: string; loserId: string } = {
        winnerId: result.winnerId,
        loserId: result.loserId,
        movedSignalIds: m.movedSignalIds,
        movedExternalLinkIds: m.movedExternalLinkIds,
        movedFacetIds: m.movedFacetIds,
        rewiredRelations: m.rewiredRelations,
        documentMoved: m.documentMoved,
        // Also stamp bare ids for older clients that still read rewiredRelationIds.
        rewiredRelationIds: m.rewiredRelations.map((r) => r.id),
      };
      if (m.winnerFacetIds?.length)
        mergeStamp.winnerFacetIds = m.winnerFacetIds;
      if (m.rewiredMessageLinkIds?.length) {
        mergeStamp.rewiredMessageLinkIds = m.rewiredMessageLinkIds;
      }
      if (m.rewiredLinkIds?.length)
        mergeStamp.rewiredLinkIds = m.rewiredLinkIds;
      if (m.deletedRelationIds?.length) {
        mergeStamp.deletedRelationIds = m.deletedRelationIds;
      }

      // Full pre-merge snapshots from mergeEntities (title/preview/properties/
      // documentId/systemData). Overlay detector snapshots so review UI fields
      // (profileSlug etc.) are preserved while unmerge always has enough.
      const fullWinnerSnapshot = {
        title: result.previousWinnerSnapshot.title,
        preview: result.previousWinnerSnapshot.preview,
        properties: result.previousWinnerSnapshot.properties,
        documentId: result.previousWinnerSnapshot.documentId,
        systemData: result.previousWinnerSnapshot.systemData,
      };
      const fullLoserSnapshot = {
        title: result.previousLoserSnapshot.title,
        preview: result.previousLoserSnapshot.preview,
        properties: result.previousLoserSnapshot.properties,
        documentId: result.previousLoserSnapshot.documentId,
        systemData: result.previousLoserSnapshot.systemData,
      };

      const nextData = {
        ...raw,
        sourceId: raw.sourceId ?? ownerUserId,
        // Detector fields (profileSlug etc.) first; merge-time projection
        // overwrites title/preview/properties/documentId/systemData so unmerge
        // restores the exact pre-merge entity state.
        previousWinnerSnapshot: {
          ...(raw.previousWinnerSnapshot ?? {}),
          ...fullWinnerSnapshot,
        },
        previousLoserSnapshot: {
          ...(raw.previousLoserSnapshot ?? {}),
          ...fullLoserSnapshot,
        },
        materialized: {
          ...(typeof raw.materialized === "object" && raw.materialized
            ? raw.materialized
            : {}),
          merge: mergeStamp,
        },
      };

      await db
        .update(proposals)
        .set({
          status: ProposalStatus.APPROVED,
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
          data: nextData as unknown as Record<string, unknown>,
        })
        .where(eq(proposals.id, input.proposalId));

      // Search/embeddings/realtime — mergeEntities is data-plane only.
      const governanceWorkspaceId = proposal.workspaceId ?? null;
      emitSideEffects({
        subjectType: "entity",
        action: "update",
        subjectId: result.winnerId,
        userId: ownerUserId,
        workspaceId: governanceWorkspaceId,
        data: { reason: "entity.merge", loserId: result.loserId },
      });
      emitSideEffects({
        subjectType: "entity",
        action: "delete",
        subjectId: result.loserId,
        userId: ownerUserId,
        workspaceId: governanceWorkspaceId,
        data: { reason: "entity.merge", winnerId: result.winnerId },
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

  // ── facet / attach ───────────────────────────────────────────────────────
  // Kind + Facets (Wave 1C). Approval re-runs the FULL attachFacet door (incl.
  // the facet emit chain) as the approver, mirroring entity/update. Pod-wide
  // facets (null workspace) run at pod scope like entity/delete.
  registerProposalExecutor({
    key: "facet/attach",
    async execute({ proposal, payload, userId, input, deps }) {
      void payload;
      const innerData = ((proposal.data as Record<string, unknown>)?.data ??
        {}) as Record<string, unknown>;
      const entityId = innerData.entityId as string | undefined;
      if (!entityId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Facet attach proposal is missing entityId",
        });
      }
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
      await entityCaller.attachFacet({
        entityId,
        profileSlug: innerData.profileSlug as string | undefined,
        profileId: innerData.profileId as string | undefined,
        workspaceId:
          (innerData.workspaceId as string | null | undefined) ?? undefined,
        contextEntityId:
          (innerData.contextEntityId as string | null | undefined) ?? undefined,
        status: innerData.status as string | undefined,
        properties: innerData.properties as Record<string, unknown> | undefined,
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

  // ── facet / update ─────────────────────────────────────────────────────────
  registerProposalExecutor({
    key: "facet/update",
    async execute({ proposal, payload, userId, input, deps }) {
      void payload;
      const innerData = ((proposal.data as Record<string, unknown>)?.data ??
        {}) as Record<string, unknown>;
      const facetId = innerData.facetId as string | undefined;
      if (!facetId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Facet update proposal is missing facetId",
        });
      }
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
      await entityCaller.updateFacet({
        facetId,
        status: innerData.status as string | undefined,
        properties: innerData.properties as Record<string, unknown> | undefined,
        workspaceId:
          (innerData.workspaceId as string | null | undefined) ?? undefined,
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

  // ── facet / detach ─────────────────────────────────────────────────────────
  registerProposalExecutor({
    key: "facet/detach",
    async execute({ proposal, payload, userId, input, deps }) {
      void payload;
      const innerData = ((proposal.data as Record<string, unknown>)?.data ??
        {}) as Record<string, unknown>;
      const facetId = innerData.facetId as string | undefined;
      if (!facetId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Facet detach proposal is missing facetId",
        });
      }
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
      await entityCaller.detachFacet({ facetId, source: "system" });

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

  // ── workspace / create ─────────────────────────────────────────────────────
  // A gated createWorkspace (packages.apply / MCP synap_create_workspace /
  // agent-authored freehand invent) lands here on approval. Without this
  // executor the `*/*` catch-all flips APPROVED but never materializes the
  // workspace — the definition was discarded at the gate (name-only) and
  // approve had no door to call. Materializes via the SAME
  // `materializeWorkspaceCore` the Hub packages.apply path uses on grant —
  // re-run as the APPROVER (userId) so audit/membership attribute to the
  // reviewer. The full PackageApply / WorkspaceDefinitionInput lives on
  // `proposal.data.data.definition` (RequestShaped nested bag).
  //
  // DATA-SHAPE NOTE: the propose gates (hub-protocol/rest/packages.ts +
  // mcp/adapter.ts synap_create_workspace) store the full definition +
  // workspaceName/templateId/packageSlug/workspaceType/proposalId/createdBy
  // so re-approve can reconstruct the create exactly. `proposalId` prefers
  // the gate's stable key (package slug / caller idempotency key) and falls
  // back to the proposal row id so re-approve is always stable.
  registerProposalExecutor({
    key: "workspace/create",
    async execute({ proposal, payload, userId, input, deps }) {
      const inner = ((proposal.data as Record<string, unknown>)?.data ??
        proposal.data ??
        {}) as Record<string, unknown>;
      const name =
        (inner.name as string | undefined) ??
        (inner.workspaceName as string | undefined);
      if (!name || typeof name !== "string" || name.trim() === "") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Workspace proposal is missing name",
        });
      }

      // Idempotency: approve is not status-guarded before dispatch; skip if
      // already materialized (idempotent create would still re-hit deps/reconcile).
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      const {
        materializeWorkspaceCore,
        ComposeBaseUnavailableError,
        DependencyResolutionError,
        ComposeBaseNotFoundError,
        ComposeOverlayError,
      } = await import("../../services/workspace-materialization-service.js");

      let core: Awaited<ReturnType<typeof materializeWorkspaceCore>>;
      try {
        core = await materializeWorkspaceCore({
          definition: (inner.definition ??
            {}) as import("@synap/database").WorkspaceDefinitionInput,
          userId,
          agentUserId: proposal.agentUserId ?? undefined,
          proposalId:
            (inner.proposalId as string | undefined) ?? input.proposalId,
          workspaceName: (inner.workspaceName as string | undefined) ?? name,
          templateId: inner.templateId as string | undefined,
          packageSlug: inner.packageSlug as string | undefined,
          workspaceType: inner.workspaceType as
            "personal" | "agent" | "project" | "operational" | undefined,
          createdBy:
            (inner.createdBy as
              "user" | "provisioning" | "plugin" | undefined) ?? "provisioning",
        });
      } catch (e) {
        if (
          e instanceof DependencyResolutionError ||
          e instanceof ComposeBaseUnavailableError ||
          e instanceof ComposeOverlayError
        ) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: (e as Error).message,
          });
        }
        if (e instanceof ComposeBaseNotFoundError) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: (e as Error).message,
          });
        }
        throw e;
      }

      // deferCreate is never set here — core is "created" | "composed" (both
      // carry workspaceId). Narrow so the "resolved"-only union arm is excluded.
      if (core.status === "resolved") {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message:
            "Workspace materialize returned resolved-without-create (unexpected on approve path)",
        });
      }
      const workspaceId = core.workspaceId;

      // Stamp the produced workspaceId onto the proposal row so clients/revert
      // can recover it (ProposalMaterializedRecord has no workspaceIds field —
      // store as a sibling lifecycle key next to materialized).
      void payload;
      const updatedData = {
        ...((proposal.data as Record<string, unknown> | null | undefined) ??
          {}),
        materializedWorkspaceId: workspaceId,
        materializeStatus: core.status,
      };

      await db
        .update(proposals)
        .set({
          status: ProposalStatus.APPROVED,
          data: updatedData,
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(proposals.id, input.proposalId));

      // packages.apply: after workspace materialize, run the SAME post-workspace
      // layers as the grant path (enroll agent + caps/autos/playbooks/loops).
      // Without this, every agent package install silently dropped Phase 2.
      const source = inner.source as string | undefined;
      const definition = (inner.definition ?? {}) as Record<string, unknown>;
      const needsPost =
        source === "packages.apply" ||
        Boolean(
          definition.capabilities ||
          definition.automations ||
          definition.playbooks ||
          definition.loops ||
          definition.projectId
        );
      if (needsPost) {
        try {
          const { applyPackagePostWorkspace } =
            await import("../../services/package-apply-post-workspace.js");
          await applyPackagePostWorkspace({
            workspaceId,
            body: definition as Parameters<
              typeof applyPackagePostWorkspace
            >[0]["body"],
            userId,
            // Approver is authority for creates; still enroll the proposing
            // agent so follow-on agent writes don't collapse to join proposals.
            agentUserId: proposal.agentUserId ?? undefined,
            scopes: [],
          });
        } catch (e) {
          // Workspace already exists — surface post-layer failure rather than
          // leaving APPROVED with a silent partial package.
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: `Workspace created but package layers failed: ${(e as Error).message}`,
          });
        }
      }

      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return { success: true, primaryId: workspaceId };
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

  // ── workspace / declare_source ───────────────────────────────────────────────
  // (Enterprise-OS Wave 0, now GOVERNED) A gated `synap_declare_workspace_source`
  // / Hub `PATCH /workspaces/:id/source-edges` (agent-authored, or a member whose
  // role lacks `write`) lands here on approval. Rewiring pod-wide cross-workspace
  // read routing must go through review, not apply immediately — so this executor
  // is what makes approval actually merge the edge. Materializes via the SAME
  // `mergeWorkspaceSourceEdges` apply fn the direct/auto-approve path uses — re-run
  // as the APPROVER (userId) so the settings merge + `feeds`-link materialization
  // attribute to the reviewer. Without this executor the `*/*` catch-all would flip
  // the proposal APPROVED (emit `.validated`) but NEVER merge the edge — the
  // cross-workspace reads would silently never redirect.
  //
  // DATA-SHAPE NOTE: the propose gate stores exactly `{ sourceRoles,
  // defaultSources }` in the proposal `data.data` — the full input
  // `mergeWorkspaceSourceEdges` needs. The target workspace is `proposal.workspaceId`
  // (the consumer workspace the edge is declared ON), the SAME workspace the gate
  // RBAC-checked (mirrors project/create using proposal.workspaceId).
  registerProposalExecutor({
    key: "workspace/declare_source",
    async execute({ proposal, userId, input, deps }) {
      const innerData = ((proposal.data as Record<string, unknown>)?.data ??
        {}) as Record<string, unknown>;
      const workspaceId = proposal.workspaceId ?? null;
      if (!workspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Workspace source-edge proposal is missing a valid workspaceId",
        });
      }

      // Idempotency: approve is not status-guarded before dispatch, so skip if
      // this proposal was already materialized (a re-approve would re-merge —
      // harmless (mergeSettings is idempotent) but the guard mirrors the siblings).
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      const { WorkspaceSourceEdgeInputSchema, mergeWorkspaceSourceEdges } =
        await import("../../services/workspace-edge-service.js");
      const parsed = WorkspaceSourceEdgeInputSchema.safeParse({
        sourceRoles: innerData.sourceRoles,
        defaultSources: innerData.defaultSources,
      });
      if (
        !parsed.success ||
        (!parsed.data.sourceRoles && !parsed.data.defaultSources)
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Workspace source-edge proposal is missing sourceRoles/defaultSources",
        });
      }

      // Apply as the APPROVER — the same door the granted/direct path calls.
      await mergeWorkspaceSourceEdges(workspaceId, parsed.data, userId);

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

  // ── workspace / configure_public_projection ─────────────────────────────────
  // A gated Hub `PATCH /workspaces/:id/public-projection` (agent-authored, or a
  // member whose role lacks `write`) lands here on approval. Opting a workspace
  // into an UNAUTHENTICATED public projection must go through review, not apply
  // immediately — so this executor is what makes approval actually write the
  // config. Materializes via the SAME `setWorkspacePublicProjection` apply fn the
  // direct/auto-approve path uses — re-run as the APPROVER (userId) so the
  // settings merge attributes to the reviewer. Without this executor the `*/*`
  // catch-all would flip the proposal APPROVED (emit `.validated`) but NEVER
  // write the config — the public surface would silently never open.
  //
  // DATA-SHAPE NOTE: the propose gate stores exactly `{ enabled, roles, fields }`
  // in the proposal `data.data` — the full input `setWorkspacePublicProjection`
  // needs. The target workspace is `proposal.workspaceId` (the SAME workspace the
  // gate RBAC-checked, mirrors workspace/declare_source).
  registerProposalExecutor({
    key: "workspace/configure_public_projection",
    async execute({ proposal, userId, input, deps }) {
      const innerData = ((proposal.data as Record<string, unknown>)?.data ??
        {}) as Record<string, unknown>;
      const workspaceId = proposal.workspaceId ?? null;
      if (!workspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Workspace public-projection proposal is missing a valid workspaceId",
        });
      }

      // Idempotency: approve is not status-guarded before dispatch, so skip if
      // this proposal was already materialized (a re-approve would re-write —
      // harmless (mergeSettings is idempotent) but the guard mirrors the siblings).
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      const { PublicProjectionInputSchema, setWorkspacePublicProjection } =
        await import("../../services/workspace-projection-service.js");
      const parsed = PublicProjectionInputSchema.safeParse({
        enabled: innerData.enabled,
        roles: innerData.roles,
        fields: innerData.fields,
      });
      if (!parsed.success) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Workspace public-projection proposal is missing a valid { enabled, roles, fields } config",
        });
      }

      // Apply as the APPROVER — the same door the granted/direct path calls.
      await setWorkspacePublicProjection(workspaceId, parsed.data, userId);

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

  // ── workspace / update ───────────────────────────────────────────────────────
  // Hub `POST /packages/apply` with `targetWorkspaceId` set (install-onto-
  // existing) proposes via `subjectType:"workspace", action:"update"` when the
  // caller can't auto-approve (workspace.update ∈ ADMIN_ACTIONS). Without this
  // executor the generic `*/*` catch-all only flipped the row APPROVED — the
  // additive reconcile never ran. Re-runs the SAME `materializeWorkspaceCore`
  // (targetWorkspaceId forces the `composeOntoBaseWorkspace` branch) the grant
  // path drives, from the FULL package body the route already stores as
  // `data.definition` (packages.ts:246-276), then the SAME phase-2
  // `applyPackagePostWorkspace` layers — stamping the APPROVER as the acting
  // userId (mirrors workspace/create's approve-as-authority above).
  registerProposalExecutor({
    key: "workspace/update",
    async execute({ proposal, payload, userId, input, deps }) {
      void payload;
      const inner = ((proposal.data as Record<string, unknown>)?.data ??
        proposal.data ??
        {}) as Record<string, unknown>;
      const targetWorkspaceId =
        (inner.targetWorkspaceId as string | undefined) ??
        proposal.workspaceId ??
        undefined;
      if (!targetWorkspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Workspace update proposal is missing targetWorkspaceId",
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

      const {
        materializeWorkspaceCore,
        ComposeBaseUnavailableError,
        DependencyResolutionError,
        ComposeBaseNotFoundError,
        ComposeOverlayError,
      } = await import("../../services/workspace-materialization-service.js");

      const definition = (inner.definition ?? {}) as Record<string, unknown>;

      let core: Awaited<ReturnType<typeof materializeWorkspaceCore>>;
      try {
        core = await materializeWorkspaceCore({
          definition:
            definition as unknown as import("@synap/database").WorkspaceDefinitionInput,
          userId,
          agentUserId: proposal.agentUserId ?? undefined,
          selfSlug: inner.packageSlug as string | undefined,
          targetWorkspaceId,
          proposalId:
            (inner.proposalId as string | undefined) ?? input.proposalId,
          workspaceName: inner.workspaceName as string | undefined,
          templateId: inner.templateId as string | undefined,
          packageSlug: inner.packageSlug as string | undefined,
          packageVersion: inner.packageVersion as string | undefined,
          workspaceType: inner.workspaceType as
            "personal" | "agent" | "project" | "operational" | undefined,
        });
      } catch (e) {
        if (
          e instanceof DependencyResolutionError ||
          e instanceof ComposeBaseUnavailableError ||
          e instanceof ComposeOverlayError
        ) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: (e as Error).message,
          });
        }
        if (e instanceof ComposeBaseNotFoundError) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: (e as Error).message,
          });
        }
        throw e;
      }

      // targetWorkspaceId always forces the "composed" branch inside
      // materializeWorkspaceCore (never "created"/"resolved") — narrow so the
      // rest of this executor can read workspaceId unconditionally.
      if (core.status !== "composed") {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Workspace update materialize returned unexpected status "${core.status}" for a targeted install`,
        });
      }
      const workspaceId = core.workspaceId;

      const updatedData = {
        ...((proposal.data as Record<string, unknown> | null | undefined) ??
          {}),
        materializedWorkspaceId: workspaceId,
        materializeStatus: core.status,
      };

      await db
        .update(proposals)
        .set({
          status: ProposalStatus.APPROVED,
          data: updatedData,
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(proposals.id, input.proposalId));

      // Phase 2: same post-workspace layers the grant path always runs after a
      // "composed" outcome (packages.ts has no `unchanged` discriminator on
      // that branch — it always re-seeds, see packages.ts:450).
      try {
        const { applyPackagePostWorkspace } =
          await import("../../services/package-apply-post-workspace.js");
        await applyPackagePostWorkspace({
          workspaceId,
          body: definition as Parameters<
            typeof applyPackagePostWorkspace
          >[0]["body"],
          userId,
          agentUserId: proposal.agentUserId ?? undefined,
          scopes: [],
        });
      } catch (e) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Workspace updated but package layers failed: ${(e as Error).message}`,
        });
      }

      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return { success: true, primaryId: workspaceId };
    },
  });

  // ── workspace / adopt ────────────────────────────────────────────────────────
  // Hub `POST /pod/adopt` (`hub-protocol/rest/pod-adopt.ts`) proposes via
  // `subjectType:"workspace", action:"adopt"` for agent callers under the same
  // ADMIN_ACTIONS floor. Re-runs the SAME stamp-then-reconcile sequence the
  // grant path performs inline: `WorkspaceRepository.mergeSettings` (lifts
  // packageSlug/proposalId onto the workspace settings) then
  // `reconcileWorkspaceFromDefinition({ mergeCapabilities: true })` — never
  // destructive, never a second workspace. The template is re-resolved FRESH at
  // approval time via `resolveWorkspaceTemplate` (mirrors the grant path, which
  // also resolves at call time rather than trusting a stale snapshot) — only
  // `templateSlug` needs to survive from propose to approve.
  registerProposalExecutor({
    key: "workspace/adopt",
    async execute({ proposal, payload, userId, input, deps }) {
      void payload;
      const inner = ((proposal.data as Record<string, unknown>)?.data ??
        proposal.data ??
        {}) as Record<string, unknown>;
      const templateSlug = inner.templateSlug as string | undefined;
      const workspaceId =
        (inner.workspaceId as string | undefined) ??
        proposal.workspaceId ??
        undefined;
      if (!templateSlug || !workspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Workspace adopt proposal is missing templateSlug or workspaceId",
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

      const { resolveWorkspaceTemplate } =
        await import("../../services/capabilities/resolve-workspace-template.js");
      const resolved = await resolveWorkspaceTemplate(templateSlug);
      if (!resolved) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Unknown template: ${templateSlug}`,
        });
      }

      const {
        getDb,
        eventRepository,
        WorkspaceRepository,
        reconcileWorkspaceFromDefinition,
      } = await import("@synap/database");

      const settingsPatch: Partial<
        import("@synap/database").WorkspaceSettings
      > = {
        packageSlug: templateSlug,
        proposalId: templateSlug,
        ...(resolved.version ? { packageVersion: resolved.version } : {}),
      };
      const dbConn = await getDb();
      const workspaceRepo = new WorkspaceRepository(dbConn, eventRepository);
      // Approver is the authority — same as workspace/create above.
      await workspaceRepo.mergeSettings(workspaceId, settingsPatch, userId);

      const report = await reconcileWorkspaceFromDefinition({
        workspaceId,
        userId,
        definition: resolved.workspaceDefinition as unknown as Parameters<
          typeof reconcileWorkspaceFromDefinition
        >[0]["definition"],
        mergeCapabilities: true,
      });

      const updatedData = {
        ...((proposal.data as Record<string, unknown> | null | undefined) ??
          {}),
        materializedWorkspaceId: workspaceId,
        reconcile: {
          profilesAdded: report.profiles.added.length,
          propertiesAdded: report.properties.added.length,
          viewsAdded: report.views.added.length,
          entityLinksAdded: report.entityLinks.added.length,
        },
      };

      await db
        .update(proposals)
        .set({
          status: ProposalStatus.APPROVED,
          data: updatedData,
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
      return { success: true, primaryId: workspaceId };
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

  // ── capability.install (Wave 3b) — MARKETPLACE INSTALL LAST-MILE ────────────
  // Materializes an agent-initiated `market.install` (always proposed — see
  // runMarketInstall's doc). Approval runs `applyMarketInstall` — the SAME
  // kind-routed applier the operator-direct path in the builtin verb handler
  // calls — so an approved agent install can never diverge from an operator's
  // own install. Idempotent per kind (each door's own natural key: capability
  // name+workspace, template packageSlug/proposalId, cell typeKey+workspaceId,
  // automation name+workspace) — re-approving a stale proposal converges.
  registerProposalExecutor({
    key: "capability.install",
    async execute({ proposal, payload, userId, input, deps }) {
      const data = (proposal.data ?? {}) as Record<string, unknown>;
      const slug = data.slug as string | undefined;
      const kind = data.kind as CatalogKind | undefined;
      if (!slug || !kind) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "capability.install requires slug and kind in proposal data",
        });
      }

      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      const installResult = await applyMarketInstall({
        kind,
        slug,
        version: data.version as string | null | undefined,
        params: (data.params ?? {}) as Record<string, unknown>,
        userId,
        workspaceId: proposal.workspaceId ?? null,
      });

      const materializedPayload = {
        ...payload,
        installResult,
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

  // ── capability.enable (Wave 3b) — DRAFT → APPROVED, via the EXISTING gate ───
  // (P2.2-b): approver scope mirrors `skills.setApproved` exactly (workspace
  // owner, or pod-admin for a pod-wide skill) — this executor is a thin call
  // through that already-gated path, no new authority model. The CREATION call
  // site (e.g. the DRAFT-deny error hint proposing "enable this capability") is
  // a different wave's concern; this registers the proposal TYPE + its executor
  // so that wiring has somewhere to land.
  registerProposalExecutor({
    key: "capability.enable",
    async execute({ proposal, payload, userId, input, deps }) {
      const data = (proposal.data ?? {}) as Record<string, unknown>;
      const skillId = data.skillId as string | undefined;
      if (!skillId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "capability.enable requires skillId in proposal data",
        });
      }

      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      // Reuse setApproved AS-IS: it re-derives the approver's role from the
      // skill's OWN workspace, so the proposal review IS the gate — the
      // approving user must already be able to call setApproved directly.
      const { skillsRouter } = await import("../skills.js");
      const caller = skillsRouter.createCaller({
        db,
        authenticated: true as const,
        userId,
        workspaceId: proposal.workspaceId ?? null,
      } as unknown as Context);
      await caller.setApproved({ id: skillId, approved: true });

      const materializedPayload = {
        ...payload,
        enabled: true,
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
        "tool" | "skill" | "command" | undefined;
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
          string | undefined,
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
