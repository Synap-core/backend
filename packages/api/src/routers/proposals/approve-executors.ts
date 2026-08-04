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

import { TRPCError } from "@trpc/server";
import {
  db,
  proposals,
  projects,
  ProjectRepository,
  EventRepository,
  eventRepository,
  DocumentRepository,
  type CreateDocumentInput,
  sql,
  skills,
  tools,
  focusSessions,
  eq,
  getWorkspaceMembership,
  normalizeDocumentType,
  ProfileResolutionService,
  mergeEntities,
  PropertyIndexService,
  type MergeMaterializedStamp,
  entities,
  links,
  relations,
  projectMembers,
  workspaces,
  and,
  isNull,
  drizzleSql,
  type LinkEndpointType,
  type LinkType,
  knowledgeRepository,
  resolveMaterializedEntityWorkspaceId,
  isDomainHomeWorkspace,
  DOMAIN_INTO_NON_DOMAIN_HOME_MESSAGE,
} from "@synap/database";
import { randomUUID } from "crypto";
import { createLogger } from "@synap-core/core";
import { ProposalStatus } from "@synap/database/schema";
import { emitAiDecision } from "../../utils/ai-feedback-events.js";
import {
  isEntityMergeProposalData,
  type ProposalMaterializedRecord,
} from "@synap-core/types";
import type { RendererRef } from "@synap/database";
import { storage } from "@synap/storage";
import { setProfileRenderer } from "../../services/profiles/set-profile-renderer.js";
import { createAndLinkPropertyDef } from "../../services/profiles/create-and-link-property-def.js";
import { reconcileApprovedProperties } from "../../services/proposals/reconcile-proposal-properties.js";
import { auditLog } from "../../utils/audit-log.js";
import { emitHubRealtimeEvent } from "../../utils/domain-event-bridge.js";
import { emitSideEffects } from "@synap/events";
import { channelsRouter } from "../channels.js";
import {
  entitiesRouter as regularEntitiesRouter,
  mergeSystemData,
} from "../entities.js";
import { projectsRouter } from "../projects.js";
import { viewsRouter } from "../views.js";
import { profilesRouter } from "../profiles.js";
import {
  sendExternalMessage,
  triggerProviderAction,
  type ConnectionSelector,
} from "../../connectors/external-dispatch.js";
import { getMessagingConnector } from "../../connectors/index.js";
import {
  runResolvedSkill,
  assertApprovalTargetResolves,
} from "../../services/capabilities/execute-capability.js";
import { applyMarketInstall } from "../../services/capabilities/marketplace-install.js";
import type { CatalogKind } from "@synap/jobs";
import type { Context } from "../../context.js";
import {
  registerProposalExecutor,
  attachFailureMeta,
  type StoredProposalData,
  type ProposalExecutorDeps,
  type ProposalRow,
} from "./execution-registry.js";
import type { FailureErrorClass } from "../../connectors/external-dispatch.js";
// Type-only (erased at compile) so it can't trip the skills.ts circular-import
// the value paths below avoid via dynamic `import("../skills.js")`.
import type { InsertSkillGovernedInput } from "../skills.js";
import { workspaceRuntimePrimarySurfaceSchema } from "../../schemas/workspace-primary-surface.js";

const logger = createLogger({ module: "proposal-approve-executors" });

let registered = false;

/**
 * Fire the "approved" IS-telemetry outcome (fire-and-forget — never blocks).
 * Extracted verbatim from the ~38 byte-identical call sites across the approve
 * executors below; the argument construction is unchanged.
 */
function reportApproved(
  deps: ProposalExecutorDeps,
  proposal: ProposalRow,
  proposalId: string
): void {
  deps.reportProposalOutcome({
    proposalId,
    outcome: "approved",
    sourceMessageId: proposal.sourceMessageId,
    agentUserId: proposal.agentUserId,
    targetType: proposal.targetType,
    proposalType: proposal.proposalType,
    source: (proposal.data as Record<string, unknown> | null)?.source as
      string | undefined,
  });
}

/**
 * At-most-once external dispatch with the ratified HYBRID failure policy — the
 * ONE door for the four irreversible external executors (messaging.external.send,
 * capability.run, provider.action, capability/run). Wraps the side effect so it
 * fires at most once and, critically, so the proposal NEVER flips to APPROVED
 * unless the side effect is confirmed delivered:
 *
 *  - CAS-claims `external_dispatched_at` before running. Claim LOST (a prior
 *    attempt that failed-and-kept its claim, or a concurrent approval owns it):
 *    throw CONFLICT — the caller must NOT mark APPROVED; we didn't send and can't
 *    confirm the other attempt did. Surfaces as APPROVAL_FAILED (actionable),
 *    never a silent false-success (the bug the prior unconditional fall-through
 *    to APPROVED introduced).
 *  - `send()` returns `{ delivered: false }` — a DEFINITE not-sent (connector
 *    refused, skill not_found/deny, provider !executed): RELEASE the claim so a
 *    Retry re-dispatches cleanly, then throw.
 *  - `send()` THROWS — ambiguous (the call may have reached the far side): KEEP
 *    the claim (at-most-once: never risk a double-send on retry) and rethrow.
 *    Lands APPROVAL_FAILED — honestly "uncertain", not falsely sent.
 *  - `send()` returns `{ delivered: true }`: return normally; caller marks
 *    APPROVED exactly once.
 *
 * The `send` closure OWNS its own logging of the specific failure reason (this
 * helper only knows delivered-or-not) and captures any result into caller-scoped
 * variables for the materialized payload.
 */
export async function dispatchExternalOnce(
  proposalId: string,
  send: () => Promise<
    // P1: a not-delivered result MAY carry structured failure scalars (from the
    // dispatch envelope) so the thrown error can propagate a next action.
    | {
        delivered: false;
        reason?: string;
        errorClass?: FailureErrorClass;
        providerRef?: string;
      }
    | { delivered: true }
  >,
  executor: Pick<typeof db, "update"> = db
): Promise<void> {
  const [claim] = await executor
    .update(proposals)
    .set({ externalDispatchedAt: new Date() })
    .where(
      and(eq(proposals.id, proposalId), isNull(proposals.externalDispatchedAt))
    )
    .returning({ id: proposals.id });

  if (!claim) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "This action is already being dispatched — nothing was re-sent.",
    });
  }

  const result = await send(); // ambiguous throw → claim kept, propagates

  if (!result.delivered) {
    await executor
      .update(proposals)
      .set({ externalDispatchedAt: null })
      .where(eq(proposals.id, proposalId));
    // P1: attach the structured failure scalars so `dispatchProposalApproval`'s
    // catch can persist a next action alongside the human message (unchanged).
    throw attachFailureMeta(
      new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: `Couldn't apply — ${result.reason ?? "the external action was not dispatched"}.`,
      }),
      { errorClass: result.errorClass, providerRef: result.providerRef }
    );
  }
}

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

      // External URL reference: no bytes to store. Mirror the auto-approved
      // external branch in documents.ts (storageUrl = url, storageKey = NULL,
      // metadata.external = true) — skip the MinIO upload + version snapshot
      // entirely. Without this, an approved external-reference proposal would
      // wrongly upload empty content and build a normal content document.
      // Route both branches through the ONE document door
      // (DocumentRepository.create) instead of raw inserts — killing the
      // hand-inlined uploadDocumentVersionSnapshot + documentVersions insert.
      // BEHAVIOR NOTE: create() emits `document.create.completed` (which the prior
      // raw inserts did NOT) and defaults the row's provenance columns (previously
      // NULL). The approval/proposal-status flow below is untouched.
      const docRepo = new DocumentRepository(db, eventRepository);
      if (typeof data.url === "string" && data.url) {
        const docUserId = (data.userId as string) || userId;
        await docRepo.create(
          {
            id: documentId,
            title: (data.title as string) || "Untitled",
            type: normalizeDocumentType(
              (data.type as string) || "markdown",
              "markdown"
            ) as CreateDocumentInput["type"],
            storageUrl: data.url,
            storageKey: null,
            size: 0,
            mimeType: null,
            metadata: { external: true },
            userId: docUserId,
            workspaceId: proposal.workspaceId,
            sourceProposalId: input.proposalId,
          },
          docUserId
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

        // Report to IS telemetry (fire-and-forget — never blocks)
        reportApproved(deps, proposal, input.proposalId);

        deps.emitProposalReviewed(
          input.proposalId,
          proposal.workspaceId,
          "approved",
          userId
        );
        return { success: true };
      }

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

      // ONE door: create() writes the row + the immutable v1 snapshot atomically
      // (its `content` arg replaces the hand-inlined uploadDocumentVersionSnapshot
      // + documentVersions insert). The row's mimeType stays "text/markdown"
      // exactly as the prior raw insert (the computed `mimeType` above is only the
      // storage content-type, unchanged). Provenance stamped from the proposal.
      await docRepo.create(
        {
          id: documentId,
          title: (data.title as string) || "Untitled",
          type: docType as CreateDocumentInput["type"],
          storageUrl: metadata.url,
          storageKey: metadata.path,
          size: metadata.size,
          mimeType: "text/markdown",
          userId: docUserId,
          workspaceId: proposal.workspaceId,
          content, // → writes the v1 document_versions snapshot
          sourceProposalId: input.proposalId,
        },
        docUserId
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

      // Report to IS telemetry (fire-and-forget — never blocks)
      reportApproved(deps, proposal, input.proposalId);

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

      // Report to IS telemetry (fire-and-forget — never blocks)
      reportApproved(deps, proposal, input.proposalId);

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

      // Report to IS telemetry (fire-and-forget — never blocks)
      reportApproved(deps, proposal, input.proposalId);

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

      // Report to IS telemetry (fire-and-forget — never blocks)
      reportApproved(deps, proposal, input.proposalId);

      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return { success: true };
    },
  });

  // ── channel / bind ─────────────────────────────────────────────────────────
  // Approve a bindChannel proposal (hub-protocol channels.bindChannel): point an
  // ALREADY-EXISTING channel at a context object, optionally stamping the firewall
  // role. Structurally identical to create_external — resolve the membership floor,
  // build the governed channelsRouter caller, and DELEGATE the write to
  // updateChannel (which sets context_object_id and routes branchPurpose through
  // the setChannelBranchPurpose one-door). NO raw UPDATE here.
  //
  // Data shape: the bind door files via checkPermissionOrPropose(source:
  // "intelligence") → createProposal, which stores the gate data REQUEST-SHAPED
  // (nested under proposal.data.data), like entity/create. We read nested-first
  // with a flat fallback so the executor is robust to either envelope.
  //
  // FIREWALL: updateChannel wraps setChannelBranchPurpose and rethrows a
  // ChannelFirewallImmutableError as FORBIDDEN — so approving a bind that would
  // flip an already-client-comms channel FAILS LOUDLY (the proposal lands in
  // APPROVAL_FAILED), never silently reclassifying a real client's conversation.
  registerProposalExecutor({
    key: "channel/bind",
    async execute({ proposal, payload, userId, input, deps }) {
      void payload;
      const outer = (proposal.data ?? {}) as Record<string, unknown>;
      const data = (outer.data ?? outer ?? {}) as Record<string, unknown>;
      const bindWorkspaceId = proposal.workspaceId || null;
      if (!bindWorkspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Proposal is missing a valid workspaceId",
        });
      }
      const channelId = data.channelId as string | undefined;
      const contextObjectId = data.contextObjectId as string | undefined;
      if (!channelId || !contextObjectId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "channel/bind proposal is missing channelId or contextObjectId",
        });
      }
      const membership = await getWorkspaceMembership(
        db,
        bindWorkspaceId,
        userId
      );
      if (!membership) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "No workspace access",
        });
      }
      const bindCallerCtx = {
        db,
        authenticated: true as const,
        userId,
        workspaceId: bindWorkspaceId,
        workspaceRole: membership.role,
      };
      const caller = channelsRouter.createCaller(
        bindCallerCtx as unknown as Context
      );
      await caller.updateChannel({
        channelId,
        contextObjectType:
          (data.contextObjectType as
            "entity" | "document" | "view" | undefined) ?? "entity",
        contextObjectId,
        ...(typeof data.branchPurpose === "string"
          ? { branchPurpose: data.branchPurpose }
          : {}),
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

      // Report to IS telemetry (fire-and-forget — never blocks)
      reportApproved(deps, proposal, input.proposalId);

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

      // I3 (resolve-early-and-persist): land where the create door already
      // resolved (`data.resolvedWorkspaceId`), never re-derived from ambient /
      // getEntityScope alone. Same helper as jobs materializer.
      const entityHome = resolveMaterializedEntityWorkspaceId(
        innerData,
        proposalWorkspaceId
      );

      if (entityHome) {
        const filingTarget = await db.query.workspaces.findFirst({
          where: eq(workspaces.id, entityHome),
          columns: {
            workspaceType: true,
            systemSlug: true,
            settings: true,
          },
        });
        if (
          filingTarget &&
          !isDomainHomeWorkspace({
            workspaceType: filingTarget.workspaceType,
            systemSlug: filingTarget.systemSlug,
            settings: filingTarget.settings as {
              surfaceClass?: string | null;
              systemSlug?: string | null;
            } | null,
          })
        ) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: DOMAIN_INTO_NON_DOMAIN_HOME_MESSAGE,
          });
        }
      }

      let entityCallerCtx: {
        db: typeof db;
        authenticated: true;
        userId: string;
        workspaceId: string | null;
        workspaceRole: string;
      };

      if (entityHome === null) {
        // Pod-wide home (persisted null, or legacy global): null ctx is OK.
        entityCallerCtx = {
          db,
          authenticated: true as const,
          userId,
          workspaceId: null,
          workspaceRole: "owner",
        };
      } else {
        const membership = await getWorkspaceMembership(db, entityHome, userId);
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
          workspaceId: entityHome,
          workspaceRole: membership.role,
        };
      }

      const entityCaller = regularEntitiesRouter.createCaller(
        entityCallerCtx as unknown as Context
      );
      const storedEntityId = innerData.id as string | undefined;

      // Property reconciliation (approve-side): match each proposed property key
      // against the target kind's def slugs. Un-modeled free-form keys the AI
      // invented (e.g. `Geo`, `Funding`) are remapped onto a close def slug,
      // or promoted to a first-class def so they become queryable/rendered —
      // instead of being stored verbatim and invisible. Honors the reviewer's
      // per-field `propertyDecisions`. Best-effort: on def-create failure the
      // value is still stored verbatim (no data loss). See
      // services/proposals/reconcile-proposal-properties.ts.
      const profileService = new ProfileResolutionService(db);
      const reconciledProfile = await profileService.resolveProfile(
        profileSlug,
        userId,
        entityCallerCtx.workspaceId
      );
      const reconciledCreate = await reconcileApprovedProperties({
        properties: innerData.properties as Record<string, unknown> | undefined,
        profileId: reconciledProfile?.id ?? profileSlug,
        workspaceId: entityCallerCtx.workspaceId,
        userId,
        decisions: input.propertyDecisions,
      });

      // `proposedEntityId` is the id minted at PROPOSE time. `entities.create`
      // honors it when nothing matches, but its identity-first dedup may return
      // a DIFFERENT, pre-existing entity (strong email/phone/url match) with
      // `deduplicated: true` — the whole point of routing approval through the
      // one create door. Read the RETURNED id below for every downstream write.
      //
      // I3 pin: when entityHome is set, pass it as rung-1 `targetWorkspaceId`
      // so create does not re-derive from ambient. Null home → no pin (pod).
      const createdEntity = (await entityCaller.create({
        proposedEntityId: storedEntityId,
        profileSlug,
        title: (innerData.title as string) || "Untitled",
        description: innerData.description as string | undefined,
        properties: reconciledCreate.properties,
        content: innerData.content as string | undefined,
        // `entities.create` persists `documentId` into the proposal data
        // (entities.ts) but this replay historically dropped it — so an approved
        // entity-with-document proposal (a proposed file upload, or any
        // long-content entity that proposed) lost its document link. Forward it.
        documentId: innerData.documentId as string | undefined,
        ...(entityHome ? { targetWorkspaceId: entityHome } : {}),
        source: "system",
      })) as { id?: string; deduplicated?: boolean };

      // Approve-time FACET channel (single-entity twin of the composite path):
      // Prefer facets stored on the proposal at propose time (R2 — entities.create
      // persists data.facets). Approver can still pass/override via input.facets.
      // Domain-agnostic; duplicate slugs collapsed. Best-effort — never aborts.
      // `entityCaller` is human-approved ctx → attachFacet lands directly.
      type FacetSpec = {
        profileSlug: string;
        status?: string;
        properties?: Record<string, unknown>;
        contextEntityId?: string | null;
      };
      const proposedFacets = Array.isArray(innerData.facets)
        ? (innerData.facets as FacetSpec[])
        : [];
      const approveFacets = input.facets ?? [];
      // Merge: proposal facets first, then approve-time facets (later wins slug).
      const facetBySlug = new Map<string, FacetSpec>();
      for (const f of [...proposedFacets, ...approveFacets]) {
        if (!f?.profileSlug) continue;
        facetBySlug.set(f.profileSlug, f);
      }
      if (createdEntity?.id && facetBySlug.size > 0) {
        for (const facet of facetBySlug.values()) {
          try {
            await entityCaller.attachFacet({
              entityId: createdEntity.id,
              profileSlug: facet.profileSlug,
              ...(facet.status ? { status: facet.status } : {}),
              ...(facet.properties ? { properties: facet.properties } : {}),
              ...(facet.contextEntityId
                ? { contextEntityId: facet.contextEntityId }
                : {}),
              // Do NOT force proposal.workspaceId as the facet lens — for
              // pod-wide parents that may be ambient Admin / non-domain.
              // attachFacet derives role home from ontology (rung 2) or parent.
              source: "system",
            });
          } catch (err) {
            logger.warn(
              {
                err,
                entityId: createdEntity.id,
                profileSlug: facet.profileSlug,
              },
              "Skipping single-entity approve facet (entity kept)"
            );
          }
        }
      }

      // Did this approval MERGE onto an entity that already existed independently
      // of this proposal? `deduplicated` alone isn't enough: a retry (re-approve,
      // or an approve after APPROVAL_FAILED) re-runs this executor and dedups onto
      // the row the FIRST attempt created — same id as the pre-minted one, and
      // ours to own. A merge onto a DIFFERENT id is a pre-existing entity.
      const mergedOntoExisting =
        createdEntity?.deduplicated === true &&
        !!createdEntity.id &&
        createdEntity.id !== storedEntityId;

      // Mirror the composite path (proposals.ts): only entities this proposal
      // actually CREATED are ours to undo / to claim as session output / to file
      // into the proposal's project. A merged-onto entity is recorded nowhere, so
      // `revert` can never delete (nor `belongs_to_project`-widen) a row this
      // proposal did not create. Revert of a merged approval consequently fails
      // loud ("could not undo") rather than destroying the pre-existing subject —
      // the same stance planProposalRevert takes for update proposals.
      const createMaterialized: ProposalMaterializedRecord =
        createdEntity?.id && !mergedOntoExisting
          ? { entityIds: [createdEntity.id] }
          : {};
      const createPayload: StoredProposalData = {
        ...(payload as StoredProposalData),
        materialized: createMaterialized,
      };

      if (proposal.sessionId && createdEntity?.id && !mergedOntoExisting) {
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
      if (createdEntity?.id && !mergedOntoExisting) {
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

      // Report to IS telemetry (fire-and-forget — never blocks)
      reportApproved(deps, proposal, input.proposalId);

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

      // Report to IS telemetry (fire-and-forget — never blocks)
      reportApproved(deps, proposal, input.proposalId);

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
  // Gate data may include subjectEntityId / channelId / expectedOutputs / agentIds
  // (create-session.ts). workspaceId / projectId come from the proposal row.
  // After insert, ensureSessionChannel mints a room if channelId is still null.
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

      // Gate 2: mint work channel if none (parity with createFocusSession).
      if (created && !created.channelId) {
        const { ensureSessionChannel } =
          await import("../../services/focus-sessions/ensure-session-channel.js");
        await ensureSessionChannel({
          sessionId: created.id,
          userId,
          workspaceId: created.workspaceId,
          goal: created.goal,
        });
      }

      // Mirror create-session so the browser mirrors the new session live.
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

      // Report to IS telemetry (fire-and-forget — never blocks)
      reportApproved(deps, proposal, input.proposalId);

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

      // Report to IS telemetry (fire-and-forget — never blocks)
      reportApproved(deps, proposal, input.proposalId);

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

      // Report to IS telemetry (fire-and-forget — never blocks)
      reportApproved(deps, proposal, input.proposalId);

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

      // Report to IS telemetry (fire-and-forget — never blocks)
      reportApproved(deps, proposal, input.proposalId);

      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return { success: true };
    },
  });

  // ── profile / create ─────────────────────────────────────────────────────────
  // A gated createProfile (agent-authored, or a member whose role lacks
  // `create`) lands here on approval. Without this executor the `*/*` catch-all
  // threw NOT_IMPLEMENTED (the flat profile payload is not request-shaped) and
  // the proposal could never materialize. Materializes via the SAME
  // profilesRouter.create the direct path uses — re-run as the APPROVER (no
  // agentUserId ⇒ the re-entrant gate auto-grants for the operator authority),
  // so audit / events / the workspace bento + sidebar side-effects match the
  // direct create exactly. Mirrors view/create's caller construction +
  // idempotency guard. profiles.create is idempotent on slug, so a re-approve
  // returns the existing profile rather than a second row.
  //
  // CONSERVATIVE NOTE: the propose gate (profiles.create) stores only
  // { id, slug, displayName, parentProfileId, uiHints, defaultValues, scope,
  // entityScope, profileKind, applicableKinds } — so `allowedWorkspaceIds` (the
  // extra shared-scope grants) is NOT carried through and defaults to none here.
  // Widening it would require widening that gate `data` (flagged for review).
  registerProposalExecutor({
    key: "profile/create",
    async execute({ proposal, userId, input, deps }) {
      const innerData = ((proposal.data as Record<string, unknown>)?.data ??
        {}) as Record<string, unknown>;
      const slug = innerData.slug as string | undefined;
      const displayName = innerData.displayName as string | undefined;
      if (!slug || !displayName) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Profile proposal is missing slug/displayName",
        });
      }
      const workspaceId = proposal.workspaceId ?? null;
      if (!workspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Profile creation proposal is missing a valid workspaceId",
        });
      }

      // Idempotency: approve is not status-guarded before dispatch, so skip if
      // this proposal was already materialized (createCaller mints a fresh id
      // each run — profiles.create is slug-idempotent, but the status guard
      // avoids re-running the workspace side-effects on a re-approve).
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
      const profileCaller = profilesRouter.createCaller({
        db,
        authenticated: true as const,
        userId,
        workspaceId,
        workspaceRole: membership.role,
      } as unknown as Context);
      const result = await profileCaller.create({
        slug,
        displayName,
        parentProfileId: innerData.parentProfileId as string | undefined,
        uiHints: innerData.uiHints as Record<string, unknown> | undefined,
        defaultValues: innerData.defaultValues as
          Record<string, unknown> | undefined,
        scope: innerData.scope as
          "system" | "shared" | "workspace" | "user" | undefined,
        entityScope: innerData.entityScope as "pod" | "workspace" | undefined,
        profileKind: innerData.profileKind as "kind" | "role" | undefined,
        applicableKinds: innerData.applicableKinds as string[] | undefined,
      });
      // The approver IS the authority — the re-entrant gate should auto-grant.
      // A nested proposal means the approver lacks profile.create rights; surface
      // it rather than silently flipping the proposal APPROVED with nothing built
      // (mirrors the skill/create executor's guard below).
      if (
        result &&
        typeof result === "object" &&
        "status" in result &&
        result.status === "proposed"
      ) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Profile approval unexpectedly re-proposed",
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
      reportApproved(deps, proposal, input.proposalId);

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

      // Declarative-verb WIRING on the AGENT (proposal) path. The create doors
      // (`capabilities.createVerb` / MCP `synap_create_verb`) call `wireCreatedVerb`
      // ONLY on their synchronous `created` branch; a GOVERNED create returns
      // `proposed`, so the verb was materialized HERE by insertSkillGoverned with
      // NO requires-edge / container-attach / catalogue entry — born ORPHANED (the
      // T4 bug, re-opened on the approval path). Re-run the SAME shared wiring now
      // that the skill row exists.
      //
      // Signal (identical to the create doors): a `declarative` skill whose
      // `providerSpec` names a parent tool. Resolve that tool by name under the
      // APPROVER's visibility + the skill's own workspace lens via `parentToolWhere`
      // (the one shared predicate). Non-fatal throughout — if the tool can't be
      // resolved or wiring fails, log-and-continue (wireCreatedVerb's own posture);
      // never break the approval, whose skill row is already committed.
      const materializedSkill = result.skill;
      const providerSpec = materializedSkill.providerSpec;
      if (
        materializedSkill.kind === "declarative" &&
        providerSpec &&
        typeof providerSpec.tool === "string" &&
        providerSpec.tool.trim() !== ""
      ) {
        try {
          const { wireCreatedVerb, parentToolWhere } =
            await import("../../services/capabilities/create-declarative-verb.js");
          const wsLens = materializedSkill.workspaceId ?? null;
          const [parentTool] = await db
            .select({ id: tools.id })
            .from(tools)
            .where(
              parentToolWhere({
                userId,
                toolName: providerSpec.tool,
                workspaceId: wsLens,
              })
            )
            .limit(1);
          if (parentTool) {
            await wireCreatedVerb(
              {
                db,
                authenticated: true as const,
                userId,
                ...(wsLens ? { workspaceId: wsLens } : {}),
              } as unknown as Parameters<typeof wireCreatedVerb>[0],
              {
                skillId: materializedSkill.id,
                parentToolId: parentTool.id,
                verbName: materializedSkill.name,
                ...(materializedSkill.description
                  ? { description: materializedSkill.description }
                  : {}),
                parameters: materializedSkill.parameters ?? undefined,
              }
            );
          } else {
            logger.warn(
              {
                skillId: materializedSkill.id,
                toolName: providerSpec.tool,
                workspaceId: wsLens,
              },
              "skill/create approval: parent tool for declarative verb not resolvable — verb left unwired"
            );
          }
        } catch (err) {
          logger.error(
            { skillId: materializedSkill.id, err },
            "skill/create approval: wireCreatedVerb failed (non-fatal — approval proceeds)"
          );
        }
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
      reportApproved(deps, proposal, input.proposalId);

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
  // approval. The canonical internal materializer re-validates the stored
  // definition and data contract, preserves the originating agent as creator,
  // and uses the proposal target id as the stable automation id. The propose
  // gate widened `data` to the full create input, so triggerConfig /
  // flowDefinition / status / metadata / state all flow through
  // (flowDefinition is required).
  //
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

      // Fast retry guard; the stable target id below also closes the concurrent
      // approval race before this status update becomes visible.
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      const automationAuthorId =
        proposal.agentUserId ?? proposal.createdBy ?? undefined;
      if (!automationAuthorId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Automation proposal is missing its author identity",
        });
      }

      const { materializeApprovedAutomation } =
        await import("../automations.js");
      await materializeApprovedAutomation({
        database: db,
        agentUserId: automationAuthorId,
        stableId: proposal.targetId,
        definition: {
          workspaceId: proposal.workspaceId ?? undefined,
          name,
          description: innerData.description as string | undefined,
          triggerType: triggerType as "event" | "cron" | "webhook" | "manual",
          triggerConfig:
            (innerData.triggerConfig as Record<string, unknown> | undefined) ??
            {},
          flowDefinition: flowDefinition as {
            nodes: Array<Record<string, unknown>>;
            edges: Array<Record<string, unknown>>;
          },
          status:
            (innerData.status as
              "draft" | "active" | "paused" | "error" | undefined) ?? "draft",
          metadata: innerData.metadata as Record<string, unknown> | undefined,
          state: innerData.state as Record<string, unknown> | undefined,
          source: "ai" as const,
        },
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

      // Report to IS telemetry (fire-and-forget — never blocks)
      reportApproved(deps, proposal, input.proposalId);

      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return { success: true };
    },
  });

  // ── automation / execute ─────────────────────────────────────────────────────
  // A gated manual RUN of an existing automation (`automations.trigger` gates the
  // `agentUserId` path — running a flow is CODE EXECUTION, so `automation.execute`
  // is not auto-approved) lands here on approval.
  //
  // WHY THIS EXECUTOR EXISTS: without it the `*/*` catch-all flips the proposal
  // APPROVED and emits `automation.execute.validated`, but the materializer's
  // subject switch (packages/jobs/src/workers/materializer.ts) has NO `automation`
  // case — the job falls into `default:` ("Unknown subject type for
  // materialization") and returns. So approval was a silent no-op: the user
  // approved a run that never ran. (Contrast `command/execute`, which the
  // catch-all path DOES materialize via `materializeCommand` — that key
  // deliberately has no executor here; see the tests.)
  //
  // Materializes via the SAME automationsRouter.trigger the direct path uses —
  // re-run as the APPROVER with NO agentUserId, which takes the operator branch
  // (assertWorkspaceWrite on the LOADED row, then enqueue; never re-propose).
  //
  // targetId NOTE: the gate `data` carries no `id`/`entityId`/`documentId`, so
  // `proposals.targetId` is a RANDOM uuid for this key — the automation is
  // identified by `data.automationId` only. Never read targetId here.
  registerProposalExecutor({
    key: "automation/execute",
    async execute({ proposal, userId, input, deps }) {
      const innerData = ((proposal.data as Record<string, unknown>)?.data ??
        {}) as Record<string, unknown>;
      const automationId = innerData.automationId as string | undefined;
      if (!automationId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Automation run proposal is missing automationId",
        });
      }

      // Idempotency: trigger enqueues a NEW run each call, so a double-approve
      // would run the flow twice. Skip once the row is already APPROVED.
      // (APPROVAL_FAILED is intentionally NOT skipped — the dispatch site allows
      // re-approve to retry, and a failed trigger never enqueued a run.)
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
      // NO agentUserId — neither in the ctx literal above nor in the input below.
      // `trigger` computes `input.agentUserId ?? ctx.agentUserId ?? undefined`
      // and only calls checkPermissionOrPropose `if (agentUserId)`, so this
      // re-entry CANNOT re-trigger the gate (no proposal loop). RBAC is not
      // skipped: `trigger` still runs assertWorkspaceWrite against the LOADED
      // automation's workspace + owner for the approver.
      //
      // workspaceId is deliberately NOT passed: `trigger` rejects a mismatch
      // with the automation's own workspace, and the proposal's workspace lens
      // need not equal it (pod-wide automations carry a null workspace).
      const result = await automationCaller.trigger({
        id: automationId,
        subjectEntityId: innerData.subjectEntityId as string | undefined,
        payload: innerData.payload as Record<string, unknown> | undefined,
      });

      // Belt-and-braces on the no-re-gate invariant: if `trigger` ever returned
      // "proposed" from here it would mean the approval spawned ANOTHER proposal.
      // Fail loudly (proposal stays un-approved, dispatch site records
      // APPROVAL_FAILED and re-throws to the user) rather than reporting success.
      if (result.status !== "triggered") {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Approved automation run did not start (status="${result.status}")`,
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
      reportApproved(deps, proposal, input.proposalId);

      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return { success: true, primaryId: result.runId ?? undefined };
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
        // Propose-only governance marker (maintenance playbooks) — read back so
        // an AI-proposed playbook keeps `metadata.governance.forceProposeWrites`
        // when a human approves it.
        metadata: innerData.metadata as Record<string, unknown> | undefined,
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

      // Report to IS telemetry (fire-and-forget — never blocks)
      reportApproved(deps, proposal, input.proposalId);

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

      // Report to IS telemetry (fire-and-forget — never blocks)
      reportApproved(deps, proposal, input.proposalId);

      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return { success: true };
    },
  });

  // ── entity / renderer.set ───────────────────────────────────────────────────
  registerProposalExecutor({
    /**
     * Apply a per-ENTITY renderer override that was routed through review.
     *
     * WHY THIS MUST EXIST. Executors resolve on the composite key
     * `${targetType}/${proposalType}`. `entities.setEntityRenderer` proposes
     * with `subjectType: "entity"` + `action: "renderer.set"`, and there was no
     * `entity/renderer.set` entry and no entity-wide wildcard — so the proposal
     * fell through to the catch-all executor, which emits a `.validated` audit
     * event and flips the row to APPROVED **without writing anything**.
     *
     * `entity.renderer.set` is NOT in DEFAULT_AUTO_APPROVE, so that is the
     * ordinary path for an AI/MCP caller and for any workspace with
     * `forcePropose`: the reviewer approves, sees success, and the renderer
     * never changes. The door's docstring claimed parity with the profile door;
     * this is what makes that claim true.
     */
    key: "entity/renderer.set",
    async execute({ proposal, input }) {
      const innerData = ((proposal.data as Record<string, unknown>)?.data ??
        {}) as Record<string, unknown>;
      const entityId = innerData.entityId as string | undefined;
      const ref = innerData.ref as
        { kind: "cell"; cellKey: string } | null | undefined;
      if (!entityId || ref === undefined) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Entity renderer proposal is missing entityId/ref",
        });
      }

      // Idempotency, mirroring the profile executor: an already-APPROVED
      // proposal must not be applied twice.
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      const [row] = await db
        .select({ systemData: entities.systemData })
        .from(entities)
        .where(and(eq(entities.id, entityId), isNull(entities.deletedAt)))
        .limit(1);
      if (!row) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Entity no longer exists",
        });
      }

      // The SAME merge the direct door uses — siblings (`viewMode`,
      // `bentoViewId`, `onboardingScaffold`, `mergedInto`) must survive, and a
      // null ref deletes the key rather than leaving a tombstone.
      await db
        .update(entities)
        .set({
          systemData: mergeSystemData(row.systemData, { renderer: ref }),
          updatedAt: new Date(),
        })
        .where(eq(entities.id, entityId));

      return { success: true, primaryId: entityId };
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

      // Report to IS telemetry (fire-and-forget — never blocks)
      reportApproved(deps, proposal, input.proposalId);

      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return { success: true };
    },
  });

  // ── cell / define ────────────────────────────────────────────────────────────
  // A gated `synap_create_cell` (agent-authored AI-generated renderer source —
  // the MCP adapter threads agentUserId into the gate) lands here on approval.
  // Materializes via the SAME `defineCell` door the operator auto-apply path uses,
  // so the widget_definitions upsert + realtime refresh event match exactly.
  // Without this executor the `*/*` catch-all would flip the proposal APPROVED and
  // emit a `cell.define.validated` event that NO worker handles (the materializer
  // `cell` case is `cell.create`/cell-instances only) — the definition would never
  // be written. The distinct action (`cell.define`) keeps it off that path.
  registerProposalExecutor({
    key: "cell/define",
    async execute({ proposal, userId, input, deps }) {
      const innerData = ((proposal.data as Record<string, unknown>)?.data ??
        {}) as Record<string, unknown>;
      const name = innerData.name as string | undefined;
      const rendererSource = innerData.rendererSource as string | undefined;
      if (!name || !rendererSource) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Cell proposal is missing name/rendererSource",
        });
      }

      // Idempotency: defineCell upserts, but skip the whole apply once the row
      // has already been flipped APPROVED (double-click / retried re-approve).
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      const { defineCell } =
        await import("../../services/cells/define-cell.js");
      await defineCell({
        name,
        rendererSource,
        workspaceId:
          (innerData.workspaceId as string | null | undefined) ??
          proposal.workspaceId ??
          null,
        description:
          (innerData.description as string | null | undefined) ?? null,
        // View-renderer affinity, carried in the gate `data` by the doors that
        // accept it (Hub `POST /cells/define`, MCP `synap_create_cell`).
        // Absent ⇒ undefined ⇒ defineCell leaves any stored affinity untouched.
        viewTypes: Array.isArray(innerData.viewTypes)
          ? (innerData.viewTypes as string[])
          : undefined,
        userId,
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

      // Report to IS telemetry (fire-and-forget — never blocks)
      reportApproved(deps, proposal, input.proposalId);

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

      // Property reconciliation (approve-side) — same contract as entity/create:
      // resolve the entity's kind, then match/remap/promote each proposed property
      // key against that kind's def slugs (honoring `propertyDecisions`). Best-effort;
      // verbatim fallback on def-create failure. See entity/create for the rationale.
      let reconciledUpdateProps = innerData.properties as
        Record<string, unknown> | undefined;
      if (
        reconciledUpdateProps &&
        Object.keys(reconciledUpdateProps).length > 0
      ) {
        const targetEntity = await db.query.entities.findFirst({
          where: eq(entities.id, entityId),
          columns: { profileId: true, workspaceId: true },
        });
        if (targetEntity?.profileId) {
          const reconciled = await reconcileApprovedProperties({
            properties: reconciledUpdateProps,
            profileId: targetEntity.profileId,
            workspaceId:
              proposal.workspaceId ?? targetEntity.workspaceId ?? null,
            userId,
            decisions: input.propertyDecisions,
          });
          reconciledUpdateProps = reconciled.properties;
        }
      }

      await entityCaller.update({
        id: entityId,
        title: innerData.title as string | undefined,
        description: innerData.description as string | undefined,
        properties: reconciledUpdateProps,
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

      // Report to IS telemetry (fire-and-forget — never blocks)
      reportApproved(deps, proposal, input.proposalId);

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

      // Report to IS telemetry (fire-and-forget — never blocks)
      reportApproved(deps, proposal, input.proposalId);

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
        logger.warn(
          {
            proposalId: input.proposalId,
            err: err instanceof Error ? err.message : String(err),
          },
          "entity/merge executor failed"
        );
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Couldn't apply — the merge could not be completed.",
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

      // Report to IS telemetry (fire-and-forget — never blocks)
      reportApproved(deps, proposal, input.proposalId);

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

      // Report to IS telemetry (fire-and-forget — never blocks)
      reportApproved(deps, proposal, input.proposalId);

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

      // Report to IS telemetry (fire-and-forget — never blocks)
      reportApproved(deps, proposal, input.proposalId);

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

      // Report to IS telemetry (fire-and-forget — never blocks)
      reportApproved(deps, proposal, input.proposalId);

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
          // leaving APPROVED with a silent partial package. Scrub the raw cause
          // (it can carry DB/connector internals) to the operator log; the client
          // gets a fixed message, not the interpolated exception text (E1).
          logger.warn(
            { proposalId: input.proposalId, err: (e as Error).message },
            "workspace create: package layers failed post-workspace"
          );
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message:
              "Workspace created, but applying its package layers failed.",
          });
        }
      }

      // Report to IS telemetry (fire-and-forget — never blocks)
      reportApproved(deps, proposal, input.proposalId);

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

      // Report to IS telemetry (fire-and-forget — never blocks)
      reportApproved(deps, proposal, input.proposalId);

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

      // Report to IS telemetry (fire-and-forget — never blocks)
      reportApproved(deps, proposal, input.proposalId);

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

      // Report to IS telemetry (fire-and-forget — never blocks)
      reportApproved(deps, proposal, input.proposalId);

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

      if (inner.operation === "set_primary_surface") {
        const parsedSurface = workspaceRuntimePrimarySurfaceSchema
          .nullable()
          .safeParse(inner.primarySurface);
        if (!parsedSurface.success) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Workspace start proposal has an invalid primary surface",
          });
        }

        const { getDb, eventRepository, WorkspaceRepository } =
          await import("@synap/database");
        const dbConn = await getDb();
        const workspaceRepo = new WorkspaceRepository(dbConn, eventRepository);
        await workspaceRepo.setPrimarySurface(
          targetWorkspaceId,
          parsedSurface.data,
          userId
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

        reportApproved(deps, proposal, input.proposalId);
        deps.emitProposalReviewed(
          input.proposalId,
          proposal.workspaceId,
          "approved",
          userId
        );
        return { success: true, primaryId: targetWorkspaceId };
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
        // Scrub the raw cause to the operator log; the client gets a fixed
        // message, not interpolated exception text (E1).
        logger.warn(
          { proposalId: input.proposalId, err: (e as Error).message },
          "workspace update: package layers failed post-workspace"
        );
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Workspace updated, but applying its package layers failed.",
        });
      }

      // Report to IS telemetry (fire-and-forget — never blocks)
      reportApproved(deps, proposal, input.proposalId);

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

      // Report to IS telemetry (fire-and-forget — never blocks)
      reportApproved(deps, proposal, input.proposalId);

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
      // Stale-target preflight — before any at-most-once dispatch. Blocks
      // approving into a workspace the approver has left (phantom/lost-membership)
      // → the P1 recovery chip, no wasted provider call. See
      // assertApprovalTargetResolves.
      const targetFail = await assertApprovalTargetResolves(
        proposal.workspaceId ?? null,
        userId
      );
      if (targetFail) {
        throw attachFailureMeta(
          new TRPCError({
            code: "PRECONDITION_FAILED",
            message: `Couldn't apply — ${targetFail.message}.`,
          }),
          { errorClass: targetFail.errorClass }
        );
      }
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

      // At-most-once external dispatch (hybrid policy — see dispatchExternalOnce).
      // Only a confirmed-delivered send reaches the APPROVED flip below; a lost
      // claim / not-sent / ambiguous failure throws → APPROVAL_FAILED.
      await dispatchExternalOnce(input.proposalId, async () => {
        // BYPASS the capability gate: this send is already past governance (the
        // proposal was approved). `alreadyApproved` makes sendExternalMessage
        // dispatch directly, exactly once — no double-gate on re-entry.
        const {
          success: sent,
          errorClass,
          providerRef,
        } = await sendExternalMessage({
          threadId,
          accountId,
          body,
          userId,
          alreadyApproved: true,
        });
        if (!sent) {
          logger.warn(
            { proposalId: input.proposalId, threadId, platform },
            "messaging.external.send: connector reported not-sent"
          );
          return { delivered: false, errorClass, providerRef };
        }
        return { delivered: true };
      });

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

      // Report to IS telemetry (fire-and-forget — never blocks)
      reportApproved(deps, proposal, input.proposalId);

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
      // Stale-target preflight — before any at-most-once dispatch. Blocks
      // approving into a workspace the approver has left (phantom/lost-membership)
      // → the P1 recovery chip, no wasted provider call. See
      // assertApprovalTargetResolves.
      const targetFail = await assertApprovalTargetResolves(
        proposal.workspaceId ?? null,
        userId
      );
      if (targetFail) {
        throw attachFailureMeta(
          new TRPCError({
            code: "PRECONDITION_FAILED",
            message: `Couldn't apply — ${targetFail.message}.`,
          }),
          { errorClass: targetFail.errorClass }
        );
      }
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

      // At-most-once external dispatch (hybrid policy — see dispatchExternalOnce).
      // not_found / deny are DEFINITE not-run → { delivered: false } releases the
      // claim so Retry re-runs; a throw from runResolvedSkill is ambiguous → the
      // claim is kept (no resend).
      let runResult: unknown;
      await dispatchExternalOnce(input.proposalId, async () => {
        const runOutcome = await runResolvedSkill(skillRow, parameters, {
          userId,
          workspaceId: proposal.workspaceId ?? null,
          connectionSelector:
            (data.connectionSelector as ConnectionSelector | null) ?? null,
        });
        if (runOutcome.kind === "not_found") {
          logger.warn(
            {
              proposalId: input.proposalId,
              skillId,
              reason: runOutcome.message,
            },
            "capability.run executor: skill not found"
          );
          return { delivered: false, reason: runOutcome.message };
        }
        if (runOutcome.kind === "deny") {
          logger.warn(
            {
              proposalId: input.proposalId,
              skillId,
              reason: runOutcome.reason,
            },
            "capability.run executor: run denied"
          );
          return { delivered: false, reason: runOutcome.reason };
        }
        if (runOutcome.kind === "error") {
          // The run REACHED its handler and FAILED (code sandbox success:false, or
          // a provider verb error envelope). This is a DEFINITE not-delivered →
          // release the at-most-once claim so Retry re-runs. Previously this rode
          // through as a `kind:"run"` carrying success:false, which BURNED the claim
          // (delivered:true) and left the failed send stuck as "delivered".
          logger.warn(
            {
              proposalId: input.proposalId,
              skillId,
              reason: runOutcome.message,
            },
            "capability.run executor: run failed"
          );
          return {
            delivered: false,
            reason: runOutcome.message,
            errorClass: runOutcome.errorClass,
            providerRef: runOutcome.providerRef,
          };
        }
        runResult = runOutcome.result;
        return { delivered: true };
      });

      // Workstream 1 (capability-run observability contract): a delivered run
      // reaching this point was, until now, unobservable — no correlationId,
      // no run-ledger row, no recall deposit. Stamp a correlationId (the join
      // key `listCapabilityRuns`/getRun's "capability" branch read) so the run
      // becomes listable + diagnosable, mirroring the capture pattern exactly.
      const correlationId = randomUUID();

      const materializedPayload = {
        ...payload,
        runResult,
      } as unknown as typeof payload;

      await db
        .update(proposals)
        .set({
          status: ProposalStatus.APPROVED,
          data: materializedPayload,
          correlationId,
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(proposals.id, input.proposalId));

      // Emit the run's ONE timeline entry — correlationId-keyed, exactly like a
      // capture's ai_decision — so `diagnose(runId)`/getRun renders a timeline
      // instead of an empty activity list. Best-effort (emitAiDecision never
      // throws): a telemetry hiccup must not undo the already-delivered run.
      void emitAiDecision({
        action: "capability_run",
        userId,
        workspaceId: proposal.workspaceId,
        correlationId,
        data: {
          kind: "capability_run",
          skillId,
          verbId: (data.verbId as string | null) ?? null,
        },
      });

      // Recall deposit — the SAME door `remember_fact` uses to index a fact for
      // `ask`'s episodic substrate (`knowledgeRepository.saveFact`), not a
      // bespoke insert, so a capability run's result is recallable and shaped
      // like every other recall-indexed fact. Best-effort: embedding/index
      // failure must not undo the already-delivered run.
      try {
        let embedding: number[];
        try {
          const { generateEmbedding } = await import("@synap/ai-embeddings");
          embedding = await generateEmbedding(
            `Ran capability "${(data.verbId as string | null) ?? skillId}" → ${JSON.stringify(runResult).slice(0, 1000)}`
          );
        } catch {
          embedding = new Array(1536).fill(0);
        }
        await knowledgeRepository.saveFact({
          userId,
          fact: `Ran capability "${(data.verbId as string | null) ?? skillId}" → ${JSON.stringify(runResult).slice(0, 1000)}`,
          confidence: 0.9,
          embedding,
        });
      } catch (err) {
        logger.warn(
          { err, proposalId: input.proposalId, skillId },
          "capability.run executor: recall deposit failed (run kept delivered)"
        );
      }

      // Report to IS telemetry (fire-and-forget — never blocks)
      reportApproved(deps, proposal, input.proposalId);

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

      // Report to IS telemetry (fire-and-forget — never blocks)
      reportApproved(deps, proposal, input.proposalId);

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

      // Report to IS telemetry (fire-and-forget — never blocks)
      reportApproved(deps, proposal, input.proposalId);

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
      // Stale-target preflight — before any at-most-once dispatch. Blocks
      // approving into a workspace the approver has left (phantom/lost-membership)
      // → the P1 recovery chip, no wasted provider call. See
      // assertApprovalTargetResolves.
      const targetFail = await assertApprovalTargetResolves(
        proposal.workspaceId ?? null,
        userId
      );
      if (targetFail) {
        throw attachFailureMeta(
          new TRPCError({
            code: "PRECONDITION_FAILED",
            message: `Couldn't apply — ${targetFail.message}.`,
          }),
          { errorClass: targetFail.errorClass }
        );
      }
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

      // At-most-once external dispatch (hybrid policy — see dispatchExternalOnce).
      let providerBody: unknown;
      let providerStatus: unknown;
      await dispatchExternalOnce(input.proposalId, async () => {
        const {
          success: executed,
          body,
          status,
          error: providerError,
          errorClass,
          providerRef,
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
          logger.warn(
            {
              proposalId: input.proposalId,
              provider,
              method,
              path,
              providerError,
            },
            "provider.action executor failed"
          );
          return {
            delivered: false,
            reason: providerError,
            errorClass,
            providerRef,
          };
        }
        providerBody = body;
        providerStatus = status;
        return { delivered: true };
      });

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

      // Report to IS telemetry (fire-and-forget — never blocks)
      reportApproved(deps, proposal, input.proposalId);

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
      // Stale-target preflight — before any at-most-once dispatch. Blocks
      // approving into a workspace the approver has left (phantom/lost-membership)
      // → the P1 recovery chip, no wasted provider call. See
      // assertApprovalTargetResolves.
      const targetFail = await assertApprovalTargetResolves(
        proposal.workspaceId ?? null,
        userId
      );
      if (targetFail) {
        throw attachFailureMeta(
          new TRPCError({
            code: "PRECONDITION_FAILED",
            message: `Couldn't apply — ${targetFail.message}.`,
          }),
          { errorClass: targetFail.errorClass }
        );
      }
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

      // Captures the skill/command result so it can be materialized below —
      // only set on the "skill"/"command" branch; the "tool" branch's own
      // result handling is untouched (this executor does not persist a `data`
      // field for it, unchanged from before this wave).
      let skillRunResult: unknown;

      // Re-enter the SAME execute path the auto path uses. The `alreadyApproved`
      // bypass (documented above) is set so the chokepoint does NOT re-propose.
      if (capabilityKind === "tool") {
        const provider = (data.provider as string | undefined) ?? capabilityId;
        const method = (data.method as string | undefined) ?? "POST";
        const path = (data.path as string | undefined) ?? "/";

        // At-most-once external dispatch (hybrid policy — see dispatchExternalOnce).
        await dispatchExternalOnce(input.proposalId, async () => {
          const {
            success: executed,
            error: providerError,
            errorClass,
            providerRef,
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
            logger.warn(
              {
                proposalId: input.proposalId,
                provider,
                method,
                path,
                providerError,
              },
              "capability/run executor failed"
            );
            return {
              delivered: false,
              reason: providerError,
              errorClass,
              providerRef,
            };
          }
          return { delivered: true };
        });
      } else if (capabilityKind === "skill" || capabilityKind === "command") {
        // Was: flip to APPROVED with NO execution ("wired by Wave 3b" never
        // landed) — an approved skill/command run silently did nothing. Wire
        // it to the SAME post-gate runner the door + `capability.run` executor
        // use, so this shape can no longer diverge from either. A distinct
        // branch from "tool" above — no shared code path, no double-execute.
        const [skillRow] = await db
          .select({
            id: skills.id,
            name: skills.name,
            kind: skills.kind,
            providerSpec: skills.providerSpec,
          })
          .from(skills)
          .where(eq(skills.id, capabilityId))
          .limit(1);

        if (!skillRow) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: `capability/run ${capabilityKind} "${capabilityId}" not found`,
          });
        }

        // At-most-once external dispatch (hybrid policy — see dispatchExternalOnce).
        await dispatchExternalOnce(input.proposalId, async () => {
          const runOutcome = await runResolvedSkill(
            skillRow,
            (data.input as Record<string, unknown> | undefined) ?? {},
            {
              userId,
              workspaceId: (data.workspaceId as string | undefined) ?? null,
            }
          );
          if (runOutcome.kind !== "run") {
            const reason =
              runOutcome.kind === "deny"
                ? runOutcome.reason
                : runOutcome.kind === "error" || runOutcome.kind === "not_found"
                  ? runOutcome.message
                  : "unknown";
            logger.warn(
              {
                proposalId: input.proposalId,
                capabilityKind,
                capabilityId,
                reason,
              },
              "capability/run executor: skill/command run not delivered"
            );
            return {
              delivered: false,
              reason,
              // P1: an `error` outcome from a provider verb carries the scalars.
              errorClass:
                runOutcome.kind === "error" ? runOutcome.errorClass : undefined,
              providerRef:
                runOutcome.kind === "error"
                  ? runOutcome.providerRef
                  : undefined,
            };
          }
          skillRunResult = runOutcome.result;
          return { delivered: true };
        });
      }
      // Only the "skill"/"command" branch materializes a result (the "tool"
      // branch's own result handling is unchanged, pre-existing behavior).
      const materializedPayload =
        capabilityKind === "skill" || capabilityKind === "command"
          ? ({ ...data, runResult: skillRunResult } as unknown as Record<
              string,
              unknown
            >)
          : null;

      await db
        .update(proposals)
        .set({
          status: ProposalStatus.APPROVED,
          ...(materializedPayload ? { data: materializedPayload } : {}),
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(proposals.id, input.proposalId));

      // Report to IS telemetry (fire-and-forget — never blocks)
      reportApproved(deps, proposal, input.proposalId);

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
          // The CHANGE was authored by the proposing agent (the human here is
          // only the APPROVER, kept in data.approvedBy). Stamp the agent so the
          // resulting activity attributes to it — "the agent did this, you
          // approved it" — instead of collapsing under the operator. Absent
          // (operator-authored proposal) → owner write, is_agent stays null.
          // This mirrors `batchApprove`'s inline emit, which always carried the
          // stamp; routing batch through this executor would otherwise DROP it.
          agentUserId: proposal.agentUserId ?? undefined,
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
      reportApproved(deps, proposal, input.proposalId);

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
