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
  ne,
  desc,
  inArray,
  isNull,
  isNotNull,
  lt,
  entities,
  channels,
  users,
  getWorkspaceMembership,
  storedVersionValues,
  uploadDocumentVersionSnapshot,
  sql,
  links,
  type LinkEndpointType,
  type LinkType,
  linkEntityToProject,
  resolveProjectPlacement,
  setChannelBranchPurpose,
  ChannelFirewallImmutableError,
  isFacetVisibleForLens,
  unmergeEntities,
  assertUnmergeable,
  ProfileResolutionService,
  type MergeMaterializedStamp,
} from "@synap/database";
import type { EventRecord, PropertyDecisionMap } from "@synap/database";
import {
  ProposalStatus,
  workspaces,
  entityFacets,
  profiles,
  podMembers,
} from "@synap/database/schema";
import type { WorkspaceSettings } from "@synap/database/schema";
import type {
  ProposalReviewChange,
  ProposalReviewEvent,
  ProposalReviewModel,
  StoredProposalData,
  ProposalMaterializedRecord,
} from "@synap-core/types";
import {
  isDocumentContentProposalData,
  isRequestShapedProposalData,
  isCompositeProposalData,
  buildRequestFromProposal,
  buildFallbackTitle,
  isLikelyUUID,
  opRef,
  PRIMARY_REF,
  PROPOSAL_REJECTION_REASONS,
} from "@synap-core/types/proposals";
import type {
  UpdateRequest,
  ProposalReviewGraph,
  CompositeProposalData,
  CompositeProposalOperation,
  CompositeCreateEntityOp,
  CompositeCreateRelationOp,
} from "@synap-core/types/proposals";
import { storage } from "@synap/storage";
import {
  dispatchProposalApproval,
  type ProposalExecutorDeps,
  type ProposalExecutorResult,
} from "./proposals/execution-registry.js";
import { registerApproveExecutors } from "./proposals/approve-executors.js";
import {
  applyGraphDispositions,
  survivingEntityDecisionSlices,
  survivingEntityFacetSlices,
  foldFacetsIntoOps,
  type GraphDispositionMap,
  type FacetSpec,
} from "./proposals/graph-dispositions.js";
import { mergeProposalRevision } from "../services/proposals/proposals-service.js";
import { assertProposalVisibleTo } from "../utils/proposal-visibility.js";
import { assertReviewedRevision } from "../utils/reviewed-revision.js";
import { isPodAdmin } from "../utils/workspace-role.js";
import { requireUserId } from "../utils/user-scoped.js";
import { userVisibleWhere } from "../utils/user-visible-where.js";
import { auditLog } from "../utils/audit-log.js";
import { emitAiCorrection } from "../utils/ai-feedback-events.js";
import { AI_KIND } from "../lib/ai-events.js";
import { createEventBackedProposal } from "../utils/event-backed-proposal.js";
import { materializeCompositeGraph } from "../utils/materialize-composite.js";
import { reconcileApprovedProperties } from "../services/proposals/reconcile-proposal-properties.js";
import { createLogger } from "@synap-core/core";
import { getDefaultActiveService } from "../utils/intelligence-routing.js";
import { entitiesRouter as regularEntitiesRouter } from "./entities.js";
import { relationsRouter } from "./relations.js";
import { documentsRouter } from "./documents.js";
import { messages } from "@synap/database/schema";
import { emitChatEvent } from "../utils/chat-realtime-broadcast.js";
import { SERVER_CONVERSATION_EVENTS } from "../realtime/socket-events.js";
import { emitSideEffects, getBoss } from "@synap/events";
import { notifications } from "@synap/database/schema";
import { paginatedInput, buildPaginatedResponse } from "../utils/pagination.js";
import {
  collapseProposalsToClusters,
  type ClusterInputRow,
} from "../services/proposals/fingerprint.js";
import {
  automationStepRuns,
  automationRuns,
  automations,
  focusSessions,
  playbooks,
  skills,
  governanceRules,
  type GovernanceScope,
  type GovernanceTarget,
} from "@synap/database";
import type { FlowDefinition } from "@synap/database";

const logger = createLogger({ module: "proposals" });

// Register every approve executor against the proposal-execution registry.
// Idempotent — the dispatch table the approve mutation resolves against.
registerApproveExecutors();

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
 * Stamp `entity --belongs_to_project--> project` membership for entities created
 * on the synchronous approve path (the worker hook does the same for the async
 * path). Resolves the project with the lens-context priority: the proposal's
 * explicit `projectId` first, then the producing session's `projectId`.
 *
 * No-op when the proposal carries neither. Idempotent (relations unique index).
 */
async function stampProjectMembership(
  proposal: {
    projectId: string | null;
    sessionId: string | null;
    workspaceId: string | null;
  },
  entityIds: string[],
  userId: string
): Promise<void> {
  if (entityIds.length === 0) return;
  // The ONE deterministic door (explicit proposal.projectId → producing
  // session's project). Only real context stamps membership on approve.
  const placement = await resolveProjectPlacement(db, {
    userId,
    explicitProjectId: proposal.projectId,
    sessionId: proposal.sessionId,
  });
  if (!placement.projectId) return;
  for (const entityId of entityIds) {
    await linkEntityToProject(db, {
      entityId,
      projectId: placement.projectId,
      userId,
      workspaceId: proposal.workspaceId ?? null,
    });
  }
}

/**
 * Fire-and-forget: notify connected clients that a proposal was reviewed.
 * The bell panel uses this to remove the item immediately without a refetch.
 * Also enqueues automation-trigger-match for the proposal_event trigger type.
 */
function emitProposalReviewed(
  proposalId: string,
  workspaceId: string | null | undefined,
  status: "approved" | "rejected" | "reopened" | "withdrawn",
  userId?: string
): void {
  // A null-workspace (pod-wide) proposal still needs its reviewed event so the
  // bell clears — route it to the user's room instead of a workspace room.
  // Workspace is an optional lens, never a delivery requirement.
  if (!workspaceId && !userId) return;
  emitChatEvent({
    event: SERVER_CONVERSATION_EVENTS.PROPOSAL_REVIEWED,
    data: { proposalId, status, ...(workspaceId ? { workspaceId } : {}) },
    ...(workspaceId ? { workspaceId } : { userId: userId! }),
  });
  // "reopened" (rejected → pending) and "withdrawn" (proposer retracts a pending
  // proposal) must NOT fire the approve/reject automation triggers or notify a
  // waiting agent of a terminal review. A reopen leaves the pending notification
  // (the proposal is actionable again); a withdrawal is terminal, so its pending
  // notification is cleared. The realtime event above moves it out of / back
  // into the pending queue on every client.
  if (status === "reopened") return;
  if (status === "withdrawn") {
    markProposalNotificationActioned(proposalId);
    return;
  }
  // Automation side-effects (proposal.approved/rejected.completed) are
  // workspace-scoped triggers; only emit them when a workspace is present.
  if (workspaceId) {
    emitSideEffects({
      subjectType: "proposal",
      action: status,
      subjectId: proposalId,
      userId: userId ?? "",
      workspaceId,
      data: { proposalStatus: status },
    });
  }
  // Mark the corresponding notification as actioned (fire-and-forget)
  markProposalNotificationActioned(proposalId);
  // Notify the originating channel so waiting agents can continue (fire-and-forget)
  enqueueProposalReviewedNotify(proposalId, status);
}

/**
 * Fire-and-forget: enqueue a pg-boss job that posts a status message back to
 * the channel where the proposal originated, so agents waiting for approval
 * can resume work.
 */
function enqueueProposalReviewedNotify(
  proposalId: string,
  status: string
): void {
  void (async () => {
    try {
      await getBoss().send("proposal-reviewed-notify", { proposalId, status });
    } catch (err) {
      logger.warn(
        { err, proposalId },
        "Failed to enqueue proposal-reviewed-notify (non-fatal)"
      );
    }
  })();
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
  proposalType?: string | null | undefined;
  source?: string | null | undefined;
  rejectionReason?: string | null | undefined;
}): void {
  // Fire for AI proposals (have an agentUserId) AND for capture proposals
  // (no agentUserId, identified by proposalType 'capture.graph' or source 'capture')
  // so rejected captures also feed the IS learning sink.
  const isCaptureProposal =
    params.proposalType === "capture.graph" || params.source === "capture";
  if (!params.agentUserId && !isCaptureProposal) return;

  void (async () => {
    try {
      // Resolve hub endpoint + per-connection key from DB (registered IS)
      const { endpoint: hubUrl, apiKey } = await getDefaultActiveService();
      if (!apiKey) return; // No registered IS — skip telemetry (non-fatal)

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

      await fetch(`${hubUrl}/api/telemetry/proposal-outcome`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": apiKey,
        },
        body: JSON.stringify({
          traceId,
          proposalId: params.proposalId,
          outcome: params.outcome,
          targetType: params.targetType,
          proposalType: params.proposalType,
          source: params.source,
          rejectionReason: params.rejectionReason,
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

type ProposalApprovalPolicy = "admins_only" | "any_editor" | "owner_and_admins";

/**
 * Single source of truth for "may this member review (approve / reject / revert)
 * this workspace-scoped proposal?" — the SAME ladder that `approve`,
 * `batchApprove`, `revert`, and the list's `viewerCanReview` flag all read, so
 * the button shows iff the mutation would succeed. Pod-wide proposals (no
 * workspace) skip this entirely and are decided by the caller.
 */
function canReviewProposal(args: {
  policy: ProposalApprovalPolicy;
  memberRole: string | undefined;
  isOwner: boolean;
}): boolean {
  // Workspace `owner` is the TOP role — it satisfies every policy (owner ≥ admin
  // ≥ editor). The previous ladder matched only `=== "admin"`, so an actual
  // workspace OWNER was locked out of approving agent proposals under the default
  // `owner_and_admins` policy: `isOwner` here means "approver IS the proposer"
  // (sourceId === userId), NOT "workspace owner" — and agent proposals carry
  // sourceId = the agent, so that flag never helps the human owner. Net effect was
  // the 403 "Not authorized to approve this proposal" for the workspace owner.
  const isAdmin = args.memberRole === "admin" || args.memberRole === "owner";
  const isEditor = args.memberRole === "editor" || isAdmin;
  return args.policy === "admins_only"
    ? isAdmin
    : args.policy === "any_editor"
      ? isEditor
      : /* owner_and_admins */ args.isOwner || isAdmin;
}

/**
 * A short, DISPLAY-ONLY code (+ the enum it's drawn from) explaining WHY
 * `canReviewProposal`'s verdict came out the way it did. Never a decision
 * input — purely narrates the SAME boolean the ladder already computed, so
 * the UI can render "You can approve because…" instead of a bare checkmark.
 */
export type ReviewAuthorityReason =
  "pod-wide" | "owner" | "agent-owner" | "admin" | "editor" | "not-authorized";

/**
 * Format the reviewer-authority reason from the EXACT inputs `canReviewProposal`
 * gates on, plus its own verdict — so the explanation can never disagree with
 * the decision. `isAgentOwner` distinguishes "you proposed this yourself"
 * (owner) from "you own the agent that proposed this" (agent-owner); callers
 * that don't resolve agent ownership (e.g. the batched `list` computation)
 * simply omit it and get "owner" for both.
 */
function formatReviewAuthorityReason(args: {
  hasWorkspace: boolean;
  policy: ProposalApprovalPolicy;
  memberRole: string | undefined;
  isOwner: boolean;
  isAgentOwner?: boolean;
  allowed: boolean;
}): ReviewAuthorityReason {
  if (!args.hasWorkspace) return "pod-wide";
  if (!args.allowed) return "not-authorized";
  if (args.isAgentOwner) return "agent-owner";
  if (args.isOwner) return "owner";
  const isAdmin = args.memberRole === "admin" || args.memberRole === "owner";
  if (isAdmin) return "admin";
  return "editor";
}

/**
 * Human-readable suffix for a "not-authorized" verdict (which authority WOULD
 * satisfy this workspace's policy) — the "requires admin" half of the spec'd
 * `"not-authorized: requires admin"` display string.
 */
function reviewAuthorityRequirement(policy: ProposalApprovalPolicy): string {
  return policy === "any_editor" ? "editor" : "admin";
}

/**
 * "May this user APPROVE this proposal?" — the shared, byte-identical
 * authorization COMPUTATION that `approve` and `batchApprove` used to inline
 * verbatim (settings → policy → membership → `canReviewProposal`). Returns
 * `{ allowed, reason }`: `allowed` is the SAME boolean as before (each caller
 * keeps its OWN failure behavior — `approve` throws FORBIDDEN, `batchApprove`
 * records `{success:false}` and continues the batch — so this changes NO
 * observable denial behavior); `reason` is purely additive, narrating WHY, for
 * a caller that wants to surface it (e.g. an error message or the AuthorityRow
 * once threaded through `proposals.list`). Pod-wide proposals (no workspaceId)
 * are decided by the caller, so this returns `{allowed:true, reason:"pod-wide"}`
 * (mirrors the inline `if (proposal.workspaceId)` guard skipping the check
 * entirely). NOT the same as `assertCanReviewProposal` below, which serves the
 * reject/reopen path and throws with a different verb.
 */
async function computeCanReviewApproval(args: {
  proposal: {
    workspaceId: string | null;
    data: unknown;
    agentUserId?: string | null;
  };
  userId: string;
}): Promise<{ allowed: boolean; reason: ReviewAuthorityReason }> {
  const { proposal, userId } = args;
  if (!proposal.workspaceId) return { allowed: true, reason: "pod-wide" };

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
  const proposalData = proposal.data as Record<string, unknown> | null;
  let isOwner = proposalData?.sourceId === userId;
  let isAgentOwner = false;

  // An agent-authored proposal carries `sourceId` = the acting agent's user
  // row, never the human's — so the direct match above can never admit the
  // human who OWNS that agent. Resolve the agent's creator (`users.createdByUserId`)
  // and admit ONLY that one human as owner too — this is the sole widening;
  // it never touches the role ladder or any other user. One extra query, only
  // when the direct sourceId match already failed.
  if (!isOwner && proposal.agentUserId) {
    const [agent] = await db
      .select({ createdByUserId: users.createdByUserId })
      .from(users)
      .where(eq(users.id, proposal.agentUserId))
      .limit(1);
    isOwner = agent?.createdByUserId === userId;
    isAgentOwner = isOwner;
  }

  const resolvedPolicy = policy as ProposalApprovalPolicy;
  const allowed = canReviewProposal({
    policy: resolvedPolicy,
    memberRole: membership?.role,
    isOwner,
  });
  const reason = formatReviewAuthorityReason({
    hasWorkspace: true,
    policy: resolvedPolicy,
    memberRole: membership?.role,
    isOwner,
    isAgentOwner,
    allowed,
  });
  return { allowed, reason };
}

/**
 * Authorize a `revise` re-target of `proposals.workspaceId` onto a NEW
 * destination — closes the gap where `revise` only checked authority against
 * the proposal's CURRENT workspace, so a workspace-W reviewer could move a
 * proposal into a workspace they cannot access (queue injection), or clear
 * `workspaceId` to `null` to widen it to pod-wide (a data-scope escalation).
 *
 * - destination = a real workspace → require the SAME reviewer-authority
 *   ladder `computeCanReviewApproval` already enforces on the source side,
 *   evaluated against the DESTINATION workspace's own policy/membership (a
 *   plain member of the destination is not enough if its policy requires
 *   admin, exactly as if the proposal had originated there).
 * - destination = `null` (pod-wide downgrade) → require pod-admin
 *   (`isPodAdmin`) — a workspace reviewer must never be able to widen a
 *   proposal's visibility to the whole pod.
 */
async function assertCanRetargetProposalDestination(args: {
  proposal: { data: unknown; agentUserId?: string | null };
  destWorkspaceId: string | null;
  userId: string;
}): Promise<void> {
  const { proposal, destWorkspaceId, userId } = args;

  if (destWorkspaceId === null) {
    if (!(await isPodAdmin(userId))) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message:
          "Only pod administrators can widen a proposal to pod-wide (clear its workspace).",
      });
    }
    return;
  }

  const { allowed: canReviewDest } = await computeCanReviewApproval({
    proposal: {
      workspaceId: destWorkspaceId,
      data: proposal.data,
      agentUserId: proposal.agentUserId,
    },
    userId,
  });
  if (!canReviewDest) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "Not authorized to move this proposal into the destination workspace",
    });
  }
}

/**
 * Authority gate shared by `reject` / `reopen` / `batchReject` — the SAME
 * `canReviewProposal` ladder (and identical DB reads) that `approve` and
 * `revert` enforce inline. Throws FORBIDDEN when the caller may not review this
 * workspace-scoped proposal. Pod-wide proposals (no workspaceId) skip the check
 * entirely, mirroring approve/revert. `action` only shapes the error-message
 * verb; the code + policy are identical to approve's.
 *
 * SECURITY: without this, reject/reopen/batchReject only enforced
 * `requireUserId` — any authenticated member could reject/reopen ANY proposal
 * by id. This closes that gap while leaving an authorized reviewer's behavior
 * byte-identical (they already passed the same ladder).
 */
async function assertCanReviewProposal(args: {
  proposal: {
    workspaceId: string | null;
    data: unknown;
    agentUserId?: string | null;
  };
  userId: string;
  action: "reject" | "reopen";
}): Promise<void> {
  const { proposal, userId, action } = args;
  if (!proposal.workspaceId) return;

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
  const proposalData = proposal.data as Record<string, unknown> | null;
  let isOwner = proposalData?.sourceId === userId;

  // Same widening as `computeCanReviewApproval`: an agent-authored proposal's
  // `sourceId` is the agent, never the human — admit ONLY the one human who
  // owns that agent (`users.createdByUserId`), so they can reject/reopen their
  // own agent's proposal too. One extra query, only on the failure path.
  if (!isOwner && proposal.agentUserId) {
    const [agent] = await db
      .select({ createdByUserId: users.createdByUserId })
      .from(users)
      .where(eq(users.id, proposal.agentUserId))
      .limit(1);
    isOwner = agent?.createdByUserId === userId;
  }

  const canReview = canReviewProposal({
    policy: policy as ProposalApprovalPolicy,
    memberRole: membership?.role,
    isOwner,
  });

  if (!canReview) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `Not authorized to ${action} this proposal`,
    });
  }
}

async function enrichProposalsForDisplay(
  rows: ProposalRow[],
  userId: string
): Promise<DisplayEnrichedProposal[]> {
  const requests = rows.map((row) => buildRequestFromProposal(row));

  // B2: entity ids referenced as RELATION ENDPOINTS — for standalone relation
  // proposals (`data.sourceEntityId`/`targetEntityId`) and for composite
  // `create_relation` ops whose source/target ref is a real (pre-existing) entity
  // UUID. Joined below so the graph / link preview can render real titles instead
  // of `entity <8hex>` shortIds.
  // B4: facet ids for facet-UPDATE proposals — so the live-current before-state
  // of the role's properties can be diffed against the proposed values.
  const relationEndpointIds: string[] = [];
  const facetIds: string[] = [];
  // Roles v2: entity ids for which the graph needs the entity's CURRENT roles
  // (isNew:false) — composite create_entity ops that link a PRE-EXISTING entity
  // (`existingEntityId`) rather than minting a new one. Batch-joined below.
  const existingRoleEntityIds: string[] = [];
  rows.forEach((row, idx) => {
    const request = requests[idx]!;
    const payload =
      request.data && typeof request.data === "object"
        ? (request.data as Record<string, unknown>)
        : undefined;
    const src = stringProp(payload, "sourceEntityId");
    const tgt = stringProp(payload, "targetEntityId");
    if (src && isLikelyUUID(src)) relationEndpointIds.push(src);
    if (tgt && isLikelyUUID(tgt)) relationEndpointIds.push(tgt);
    const raw = row.data as StoredProposalData | null | undefined;
    if (isCompositeProposalData(raw)) {
      for (const op of raw.operations) {
        if (op.op === "create_relation") {
          if (isLikelyUUID(op.sourceRef))
            relationEndpointIds.push(op.sourceRef);
          if (isLikelyUUID(op.targetRef))
            relationEndpointIds.push(op.targetRef);
        } else if (
          op.op === "create_entity" &&
          op.existingEntityId &&
          isLikelyUUID(op.existingEntityId)
        ) {
          existingRoleEntityIds.push(op.existingEntityId);
        }
      }
    }
    if (row.targetType === "facet" && row.proposalType === "update") {
      const fid = stringProp(payload, "facetId");
      if (fid && isLikelyUUID(fid)) facetIds.push(fid);
    }
  });

  const entityIds = uniqueStrings([
    ...requests
      .filter((request) => request.targetType === "entity")
      .map((request) => request.targetId)
      .filter(isLikelyUUID),
    ...relationEndpointIds,
  ]);
  const uniqueFacetIds = uniqueStrings(facetIds);
  const uniqueRoleEntityIds = uniqueStrings(existingRoleEntityIds);
  const userIds = uniqueStrings(
    rows.flatMap((row, idx) => [
      row.agentUserId ?? undefined,
      row.createdBy ?? undefined,
      requests[idx]?.sourceId || undefined,
    ])
  );
  // correlation_id is a uuid column — clamp to valid uuids so the batch query's
  // ::uuid[] cast can't throw on a legacy non-uuid value.
  const correlationIds = uniqueStrings(
    requests.map((request) => request.correlationId)
  ).filter(isLikelyUUID);

  const eventRepo = new EventRepository(sql);
  const [
    entityRows,
    userRows,
    traceEntries,
    facetRows,
    roleFacetRows,
    viewerIsPodMember,
  ] = await Promise.all([
    entityIds.length > 0
      ? db
          .select({
            id: entities.id,
            title: entities.title,
            preview: entities.preview,
            type: entities.type,
            properties: entities.properties,
            workspaceId: entities.workspaceId,
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
    // ONE batched query for ALL correlation ids on this page (was N+1: one
    // round-trip per proposal → pool exhaustion). Grouped in memory below.
    correlationIds.length > 0
      ? eventRepo
          .getCorrelatedEventsBatch(correlationIds, userId)
          .then((events) => {
            const grouped = new Map<string, EventRecord[]>();
            for (const ev of events) {
              const key = ev.correlationId;
              if (!key) continue;
              const bucket = grouped.get(key);
              if (bucket) bucket.push(ev);
              else grouped.set(key, [ev]);
            }
            return Array.from(grouped.entries()) as Array<
              readonly [string, EventRecord[]]
            >;
          })
      : Promise.resolve([] as Array<readonly [string, EventRecord[]]>),
    // B4: current role-facet state for facet-UPDATE proposals (live-current
    // before→after). One batched query for every facetId on the page.
    uniqueFacetIds.length > 0
      ? db
          .select({
            id: entityFacets.id,
            status: entityFacets.status,
            properties: entityFacets.properties,
            workspaceId: entityFacets.workspaceId,
            userId: entityFacets.userId,
          })
          .from(entityFacets)
          .where(inArray(entityFacets.id, uniqueFacetIds))
      : Promise.resolve(
          [] as Array<{
            id: string;
            status: string | null;
            properties: unknown;
            workspaceId: string | null;
            userId: string;
          }>
        ),
    // Roles v2: CURRENT live role-facets of every pre-existing entity a composite
    // op links (`existingEntityId`), joined to profiles for the role slug. ONE
    // batched query for the whole page; the per-proposal workspace lens (MF2) is
    // applied in memory below so a role in another workspace can't leak.
    uniqueRoleEntityIds.length > 0
      ? db
          .select({
            entityId: entityFacets.entityId,
            profileSlug: profiles.slug,
            status: entityFacets.status,
            workspaceId: entityFacets.workspaceId,
            userId: entityFacets.userId,
          })
          .from(entityFacets)
          .innerJoin(profiles, eq(entityFacets.profileId, profiles.id))
          .where(
            and(
              inArray(entityFacets.entityId, uniqueRoleEntityIds),
              isNull(entityFacets.deletedAt)
            )
          )
      : Promise.resolve(
          [] as Array<{
            entityId: string;
            profileSlug: string;
            status: string | null;
            workspaceId: string | null;
            userId: string;
          }>
        ),
    // B4/Roles v2: resolve the viewer's pod membership ONCE for the whole page
    // (mirrors AccessContext.podMembership()'s single indexed lookup) so the
    // `isFacetVisibleForLens` calls below can admit a legitimately pod-shared
    // facet/role to a pod-member reviewer, not just its own owner — only run
    // when a facet/role is actually being visibility-checked below.
    uniqueFacetIds.length > 0 || uniqueRoleEntityIds.length > 0
      ? db
          .select({ userId: podMembers.userId })
          .from(podMembers)
          .where(eq(podMembers.userId, userId))
          .limit(1)
          .then((rows) => rows.length > 0)
      : Promise.resolve(false),
  ]);

  const entityById = new Map(entityRows.map((row) => [row.id, row]));
  const userById = new Map(userRows.map((row) => [row.id, row]));
  const traceByCorrelationId = new Map<string, EventRecord[]>(traceEntries);
  const facetById = new Map(facetRows.map((row) => [row.id, row]));
  // Roles v2: group live role-facets by their entity id (unfiltered — the
  // workspace lens is applied per-proposal below via `rolesForLens`).
  const roleFacetsByEntityId = new Map<
    string,
    Array<{
      profileSlug: string;
      status: string | null;
      workspaceId: string | null;
      userId: string;
    }>
  >();
  for (const rf of roleFacetRows) {
    const bucket = roleFacetsByEntityId.get(rf.entityId);
    if (bucket) bucket.push(rf);
    else roleFacetsByEntityId.set(rf.entityId, [rf]);
  }
  // B2 + MF2 (workspace scoping): resolve a batch-joined entity title by id, but
  // ONLY when the endpoint entity is visible under the proposal's own workspace
  // lens — same workspace as the proposal, or pod-wide (workspaceId null, visible
  // everywhere). A composite `create_relation` can name a pre-existing entity in a
  // DIFFERENT workspace the viewer cannot see; resolving its title here would leak
  // it. Cross-workspace endpoints return undefined → caller falls back to the
  // `entity <8hex>` shortId. The viewer is already authorized for the proposal's
  // workspace (list/get access-check it), so same-workspace + pod-wide is safe.
  const resolveEntityTitle = (
    entityId: string,
    allowedWorkspaceId: string | null
  ): string | undefined => {
    const meta = entityById.get(entityId);
    if (!meta) return undefined;
    if (meta.workspaceId !== null && meta.workspaceId !== allowedWorkspaceId) {
      return undefined;
    }
    return meta.title ?? meta.preview ?? undefined;
  };

  return rows.map((row, idx) => {
    const request = requests[idx]!;
    const payload =
      request.data && typeof request.data === "object"
        ? request.data
        : undefined;
    const entityMeta = entityById.get(request.targetId);
    const targetName =
      request.targetName ??
      titleFieldOverrideValue(request.targetType, payload) ??
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

    // MF2: bind the workspace-scoped resolver to THIS proposal's workspace lens
    // so an endpoint/facet in another workspace can never leak its title/props.
    const resolveEntityTitleScoped = (entityId: string): string | undefined =>
      resolveEntityTitle(entityId, row.workspaceId);

    // B2: for a standalone relation proposal, resolve the endpoint titles onto
    // the enriched payload. The frontend link preview prefers data.sourceLabel /
    // data.targetLabel over the raw UUID, so populating them here kills the
    // `entity <8hex>` shortId without any contract change.
    let enrichedData = request.data;
    const srcId = stringProp(payload, "sourceEntityId");
    const tgtId = stringProp(payload, "targetEntityId");
    if (payload && (srcId || tgtId)) {
      const srcLabel = srcId ? resolveEntityTitleScoped(srcId) : undefined;
      const tgtLabel = tgtId ? resolveEntityTitleScoped(tgtId) : undefined;
      if (srcLabel || tgtLabel) {
        enrichedData = {
          ...payload,
          ...(srcLabel ? { sourceLabel: srcLabel } : {}),
          ...(tgtLabel ? { targetLabel: tgtLabel } : {}),
        };
      }
    }

    // B4: for a facet-UPDATE proposal, the live-current before-state is the
    // role-facet's CURRENT properties (fetched batched above), not the parent
    // entity's columns. Feed it through the same `current` slot the entity-update
    // diff uses so property changes render before→after. MF2: only when the facet
    // sits under the proposal's own workspace lens (or pod-wide) — a facet in
    // another workspace must not leak its properties into this review.
    let reviewCurrent:
      | {
          title?: string | null;
          preview?: string | null;
          type?: string | null;
          properties?: unknown;
        }
      | undefined = entityMeta;
    if (row.targetType === "facet" && row.proposalType === "update") {
      const fid = stringProp(payload, "facetId");
      const facetRow = fid ? facetById.get(fid) : undefined;
      if (
        facetRow &&
        isFacetVisibleForLens(
          facetRow,
          row.workspaceId,
          userId,
          viewerIsPodMember
        )
      ) {
        reviewCurrent = { properties: facetRow.properties };
      }
    }

    // Roles v2: the CURRENT roles of every pre-existing entity this composite
    // links, filtered to THIS proposal's workspace lens + owner floor via the
    // shared `isFacetVisibleForLens` predicate (the in-memory twin of
    // `facetVisibilityConditions()` — SSOT, no hand-copied rule). Keyed by
    // entity id → `buildProposalGraph` attaches them to the matching
    // `existingEntityId` op as `isNew:false` roles.
    let existingRolesByEntityId:
      | Map<string, Array<{ profileSlug: string; status?: string | null }>>
      | undefined;
    if (
      roleFacetsByEntityId.size > 0 &&
      isCompositeProposalData(row.data as StoredProposalData | null | undefined)
    ) {
      const lensWorkspaceId = row.workspaceId;
      const scoped = new Map<
        string,
        Array<{ profileSlug: string; status?: string | null }>
      >();
      for (const [eid, facets] of roleFacetsByEntityId) {
        const visible = facets.filter((f) =>
          isFacetVisibleForLens(f, lensWorkspaceId, userId, viewerIsPodMember)
        );
        if (visible.length > 0) {
          scoped.set(
            eid,
            visible.map((f) => ({
              profileSlug: f.profileSlug,
              status: f.status,
            }))
          );
        }
      }
      if (scoped.size > 0) existingRolesByEntityId = scoped;
    }

    return {
      ...row,
      authorName,
      targetName,
      request: {
        ...request,
        data: enrichedData,
        targetName,
        summary,
      },
      review: buildProposalReviewModel({
        row,
        request: {
          ...request,
          data: enrichedData,
          targetName,
          summary,
        },
        authorName,
        targetName,
        current: reviewCurrent,
        resolveEntityTitle: resolveEntityTitleScoped,
        existingRolesByEntityId,
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
  /** Current state of the target entity (for update before→after diffs). */
  current?: {
    title?: string | null;
    preview?: string | null;
    type?: string | null;
    properties?: unknown;
  };
  /** B2: resolve a real entity title by id for composite relation endpoints. */
  resolveEntityTitle?: (entityId: string) => string | undefined;
  /** Roles v2: CURRENT roles (lens-filtered) of pre-existing entities the graph
   * links, keyed by entity id — attached as `isNew:false` roles. */
  existingRolesByEntityId?: Map<
    string,
    Array<{ profileSlug: string; status?: string | null }>
  >;
  events: Awaited<ReturnType<EventRepository["getCorrelatedEvents"]>>;
}): ProposalReviewModel {
  const {
    row,
    request,
    authorName,
    targetName,
    current,
    resolveEntityTitle,
    existingRolesByEntityId,
    events,
  } = params;
  const requestData =
    request.data && typeof request.data === "object" ? request.data : {};
  // Composite (graph) proposals store `{ operations: [...] }` in row.data, which
  // the flat `changes` model can't express. Detect and build a `graph` instead.
  const rawData = row.data as StoredProposalData | null | undefined;
  const graph = isCompositeProposalData(rawData)
    ? buildProposalGraph(rawData, resolveEntityTitle, existingRolesByEntityId)
    : undefined;
  // Durable before-snapshot captured at proposal-creation time (entity updates).
  // Preferred over the live `current` entity so the diff survives approval and
  // concurrent edits. Absent on legacy proposals → falls back to `current`.
  // `previousData` is declared on RequestShapedProposalData in @synap-core/types
  // (src); read it via a local shape so this compiles against the published dist
  // until the types package rebuilds.
  const previousData = isRequestShapedProposalData(rawData)
    ? (rawData as ProposalPreviousDataCarrier).previousData
    : undefined;
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
    changes: buildProposalChanges(
      requestData,
      request.changeType,
      current,
      previousData
    ),
    ...(graph ? { graph } : {}),
    events: reviewEvents,
  };
}

/**
 * Build the reviewable graph for a composite proposal.
 *
 * Pass 1: walk the create_entity ops, assigning each a stable ref (its own `ref`
 * or the positional `$opN`) and recording ref→title so relations can show human
 * labels. ROLES v2: each entity carries its `roles[]` — a KIND wears its roles.
 * Inline `op.facets` become `isNew:true` roles (this proposal ATTACHES them);
 * for an op that links a PRE-EXISTING entity (`existingEntityId`), that entity's
 * CURRENT live roles (looked up in the lens-filtered `existingRolesByEntityId`
 * map built in `enrichProposalsForDisplay`) become `isNew:false` roles — showing
 * the entity's existing roles as context beside the new one.
 * Pass 2: map each create_relation's source/target refs to those titles; a ref
 * that is a real, pre-existing entity UUID resolves to that entity's real title
 * via `resolveEntityTitle` (B2 — was a bare `entity <8hex>` shortId). When an
 * endpoint is one of THIS proposal's entities, its canonical entity ref is also
 * emitted (`sourceRef`/`targetRef`) so the UI can link the row to the entity.
 *
 * `resolveEntityTitle` looks up a batch-joined entity title by id (populated in
 * `enrichProposalsForDisplay` for every UUID referenced as a relation endpoint).
 * Absent → falls back to the short `entity <8hex>` label as before.
 *
 * Emits the PINNED ProposalReviewGraph contract — keep in sync with the frontend.
 */
function buildProposalGraph(
  data: CompositeProposalData,
  resolveEntityTitle?: (entityId: string) => string | undefined,
  existingRolesByEntityId?: Map<
    string,
    Array<{ profileSlug: string; status?: string | null }>
  >
): ProposalReviewGraph {
  const refToTitle = new Map<string, string>();
  // Every ref alias ($opN / op `ref` / $primary / a linked entity's UUID) → the
  // CANONICAL entity ref (the value in `entities[].ref`), so a relation endpoint
  // that is one of this proposal's entities resolves to that entity's ref.
  const refAliasToCanonical = new Map<string, string>();
  const entities: ProposalReviewGraph["entities"] = [];
  let firstEntitySeen = false;

  data.operations.forEach((op, index) => {
    if (op.op !== "create_entity") return;
    const entityOp = op as CompositeCreateEntityOp;
    const ref = entityOp.ref ?? opRef(index);
    const title = entityOp.title ?? "Untitled";
    refToTitle.set(ref, title);
    // Positional ref always resolves too (a relation may reference $opN even
    // when the op carries its own ref).
    refToTitle.set(opRef(index), title);
    // Canonical-ref aliases: positional, own ref, $primary (first entity only),
    // and a linked pre-existing entity's UUID all point at this entity's ref.
    refAliasToCanonical.set(ref, ref);
    refAliasToCanonical.set(opRef(index), ref);
    if (entityOp.ref) refAliasToCanonical.set(entityOp.ref, ref);
    if (!firstEntitySeen) refAliasToCanonical.set(PRIMARY_REF, ref);
    if (entityOp.existingEntityId)
      refAliasToCanonical.set(entityOp.existingEntityId, ref);
    firstEntitySeen = true;

    // ROLES v2: a KIND carries its roles ON the entity. Existing roles first
    // (isNew:false, from live entity_facets of a linked pre-existing entity),
    // then the roles this proposal attaches (isNew:true, from inline op.facets).
    const roles: NonNullable<ProposalReviewGraph["entities"][number]["roles"]> =
      [];
    if (entityOp.existingEntityId) {
      for (const existing of existingRolesByEntityId?.get(
        entityOp.existingEntityId
      ) ?? []) {
        roles.push({
          profileSlug: existing.profileSlug,
          isNew: false,
          ...(existing.status ? { status: existing.status } : {}),
        });
      }
    }
    for (const facet of entityOp.facets ?? []) {
      roles.push({
        profileSlug: facet.profileSlug,
        isNew: true,
        ...(facet.status ? { status: facet.status } : {}),
      });
    }

    entities.push({
      ref,
      profileSlug: entityOp.profileSlug,
      title,
      propertyCount: Object.keys(entityOp.properties ?? {}).length,
      hasContent: !!entityOp.content,
      ...(roles.length > 0 ? { roles } : {}),
    });
  });

  const labelForRef = (ref: string): string => {
    const known = refToTitle.get(ref);
    if (known) return known;
    // A ref that is a real UUID is a pre-existing entity linked into the graph.
    // Resolve its real title from the batch join (B2); fall back to the shortId.
    if (isLikelyUUID(ref)) {
      const resolved = resolveEntityTitle?.(ref);
      if (resolved) return resolved;
      return `entity ${ref.slice(0, 8)}`;
    }
    return ref;
  };

  const relations: ProposalReviewGraph["relations"] = [];
  // $relN ordinal — the stable per-item address for a relation (N counts
  // create_relation ops in operations order). `approve` recomputes this exact
  // ordinal to map a `$relN` disposition back to the Nth create_relation op, so
  // the counter MUST increment per create_relation op (matching the same
  // iteration order over data.operations).
  let relOrdinal = 0;
  for (const op of data.operations) {
    if (op.op !== "create_relation") continue;
    const relOp = op as CompositeCreateRelationOp;
    const itemRef = `$rel${relOrdinal}`;
    relOrdinal++;
    const sourceRef = refAliasToCanonical.get(relOp.sourceRef);
    const targetRef = refAliasToCanonical.get(relOp.targetRef);
    relations.push({
      type: relOp.type,
      sourceLabel: labelForRef(relOp.sourceRef),
      targetLabel: labelForRef(relOp.targetRef),
      ...(sourceRef ? { sourceRef } : {}),
      ...(targetRef ? { targetRef } : {}),
      itemRef,
    });
  }

  // facetCount = number of NEWLY-attached roles across all entities (isNew).
  const facetCount = entities.reduce(
    (sum, entity) =>
      sum + (entity.roles?.filter((role) => role.isNew).length ?? 0),
    0
  );

  return {
    entities,
    relations,
    entityCount: entities.length,
    relationCount: relations.length,
    facetCount,
  };
}

// ---------------------------------------------------------------------------

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

/** Before-snapshot persisted on an UPDATE proposal's stored data. Mirrors the
 * `previousData` field declared on RequestShapedProposalData in @synap-core/types. */
interface ProposalPreviousData {
  title?: string | null;
  description?: string | null;
  profileSlug?: string | null;
  documentId?: string | null;
  properties?: Record<string, unknown>;
}
/** Local read-shape so the persisted snapshot is accessible against the published
 * @synap-core/types dist before it rebuilds with the new field. */
type ProposalPreviousDataCarrier = { previousData?: ProposalPreviousData };

/**
 * Envelope/infra keys that must never surface as a user-facing change row in the
 * generic (non-entity) fallback in `buildProposalChanges`. Mirrors the frontend
 * INFRA_KEYS set (useProposalPresentation.ts) so the two derivations agree. The
 * entity path never consults this — it only walks the explicit
 * title/description/profileSlug/documentId + `properties.*` keys.
 */
// Cross-repo duplicate: intentionally kept in sync with `INFRA_KEYS` in
// synap-app/packages/core/proposal-types/src/useProposalPresentation.ts. No
// shared package exists across the backend/frontend repo boundary for this
// constant — MUST stay byte-identical when either side changes.
const NON_ENTITY_INFRA_KEYS = new Set([
  "source",
  "sourceId",
  "_summary",
  "summary",
  "changeType",
  "operations",
  "correlationId",
  "requestId",
  "requestedEventId",
  "validatedEventId",
  "completedEventId",
  "workspaceId",
  "targetType",
  "targetId",
  "data",
  "global",
  "reasoning",
  "id",
  "documentId",
  "content",
  "title",
  "description",
  "profileSlug",
]);

/**
 * Per-subjectType override for which flat payload field names the proposal card.
 * Consulted when resolving a proposal's `targetName` so a non-entity subject
 * (e.g. a flat `property_def` payload that carries no title/name) still gets a
 * human title (its slug) instead of falling through to "Untitled". Backend-local
 * — deliberately NOT a new published type field (reuses existing plumbing).
 */
const TITLE_FIELD_OVERRIDES: Record<string, string> = {
  property_def: "slug",
};

/** Resolve the title-override field value for a proposal's target type, if any. */
function titleFieldOverrideValue(
  targetType: string | undefined,
  payload: Record<string, unknown> | undefined
): string | undefined {
  if (!targetType) return undefined;
  const field = TITLE_FIELD_OVERRIDES[targetType];
  if (!field) return undefined;
  return stringProp(payload, field);
}

export function buildProposalChanges(
  data: Record<string, unknown>,
  changeType: string,
  current?: {
    title?: string | null;
    preview?: string | null;
    type?: string | null;
    properties?: unknown;
  },
  /**
   * Durable before-snapshot persisted at proposal-creation time (entity updates).
   * Preferred over `current` so the diff survives approval/materialization and
   * concurrent edits. Absent on legacy proposals → `current` is used.
   */
  previousData?: ProposalPreviousData
): ProposalReviewChange[] {
  const changes: ProposalReviewChange[] = [];
  const operation =
    changeType === "delete"
      ? "delete"
      : changeType === "create"
        ? "create"
        : "update";

  // Before-state lookup so update diffs show before→after (not just after).
  // Source of truth: the persisted `previousData` snapshot when present (durable),
  // otherwise the live `current` entity columns (legacy fallback).
  const snapshotProps =
    previousData?.properties && typeof previousData.properties === "object"
      ? previousData.properties
      : undefined;
  const currentProps =
    current?.properties && typeof current.properties === "object"
      ? (current.properties as Record<string, unknown>)
      : {};
  const beforeFor = (key: string): unknown => {
    if (operation !== "update") return undefined;
    if (previousData) {
      // The snapshot stores keys as title/description/profileSlug/documentId.
      const snapValue = previousData[key as keyof typeof previousData];
      if (snapValue !== undefined) return snapValue ?? undefined;
    }
    if (!current) return undefined;
    if (key === "title") return current.title ?? undefined;
    if (key === "description") return current.preview ?? undefined;
    if (key === "profileSlug") return current.type ?? undefined;
    return undefined;
  };

  for (const key of ["title", "description", "profileSlug", "documentId"]) {
    if (data[key] !== undefined) {
      changes.push({
        path: key,
        label: labelFromPath(key),
        operation,
        before: beforeFor(key),
        after: data[key],
        valueType: valueTypeOf(data[key]),
      });
    }
  }

  const beforePropFor = (key: string): unknown => {
    if (operation !== "update") return undefined;
    if (snapshotProps && key in snapshotProps) return snapshotProps[key];
    return currentProps[key];
  };

  const properties =
    data.properties && typeof data.properties === "object"
      ? (data.properties as Record<string, unknown>)
      : {};
  for (const [key, value] of Object.entries(properties)) {
    changes.push({
      path: `properties.${key}`,
      label: labelFromPath(key),
      operation,
      before: beforePropFor(key),
      after: value,
      valueType: valueTypeOf(value),
    });
  }

  // Generic fallback: a non-entity proposal (e.g. a flat `property_def` payload of
  // { slug, valueType, constraints, overlay, required, … }) matches none of the
  // entity-shape keys above, so `changes` is still empty and the review card would
  // render blank. Emit one change per non-infra top-level key (no "properties."
  // prefix) so the payload renders. Entity/document/composite/session payloads
  // always populate `changes` above, so this never fires for them — the entity
  // path is preserved byte-for-byte.
  if (changes.length === 0) {
    for (const [key, value] of Object.entries(data)) {
      if (NON_ENTITY_INFRA_KEYS.has(key)) continue;
      if (value === undefined) continue;
      changes.push({
        path: key,
        label: labelFromPath(key),
        operation,
        before: undefined,
        after: value,
        valueType: valueTypeOf(value),
      });
    }
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

/**
 * Find a flow node by id in an automation's live definition. Tolerant of a
 * missing/partial definition or an unknown nodeId (returns null). Used by
 * `proposals.source` to read the producing node's skill / playbook ref.
 */
function findFlowNode(
  flowDefinition: FlowDefinition | null | undefined,
  nodeId: string | undefined
): { type: string; data?: unknown } | null {
  if (!nodeId) return null;
  const nodes = flowDefinition?.nodes;
  if (!Array.isArray(nodes)) return null;
  for (const n of nodes) {
    if (n && typeof n === "object" && (n as { id?: unknown }).id === nodeId) {
      return n as { type: string; data?: unknown };
    }
  }
  return null;
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

/**
 * Resolve the user's messaging account for a given platform (linkedin / gmail /
 * whatsapp / telegram / slack). Reads the `messaging_accounts` table. Returns
 * null when no account is connected for that platform.
 */
async function resolveMessagingAccountForPlatform(
  database: typeof db,
  userId: string,
  platform?: string
): Promise<{ id: string } | null> {
  if (!platform) return null;
  await import("@synap/database/schema");
  const acct = await database.query.messagingAccounts.findFirst({
    where: (fields, { and, eq }) =>
      and(
        eq(fields.userId, userId),
        // The column is 'provider' (e.g. 'linkedin', 'gmail'); we resolve from
        // the proposal's `data.platform` which matches the same value.
        eq(fields.provider, platform)
      ),
    columns: { id: true },
  });
  return acct ?? null;
}

// ---------------------------------------------------------------------------
// Revert planning (pure — no DB, fully unit-testable)
// ---------------------------------------------------------------------------

/**
 * The concrete inverse a `revert` must apply. Either a list of soft-deletes /
 * deletes of the rows the proposal created, or `unsupported` with a loud reason.
 *
 * Effect verbs:
 *   - "delete-creations" → the proposal CREATED rows; the inverse is to delete
 *     them (entities/relations/documents the approval produced).
 *
 * Update/edit proposals carry no recoverable before-snapshot, so reverting them
 * is `unsupported` and the mutation FAILS LOUD rather than fabricating a state.
 *
 *   - "restore-delete" → the proposal DELETED an entity; entity deletes in this
 *     codebase are SOFT deletes (`entities.deletedAt`), so the inverse is to
 *     clear `deletedAt` — the row survives unless it was later hard-purged.
 */
export type ProposalRevertPlan =
  | {
      kind: "delete-creations";
      entityIds: string[];
      relationIds: string[];
      documentIds: string[];
    }
  | { kind: "restore-delete"; entityId: string }
  /**
   * Full entity-merge inverse: reverse signals/relations/links/facets and
   * restore both entities from pre-merge snapshots via `unmergeEntities`.
   */
  | {
      kind: "unmerge";
      winnerId: string;
      loserId: string;
    }
  | { kind: "unsupported"; reason: string };

/**
 * Minimal projection of a proposal row the planner needs. Keeps the planner
 * decoupled from drizzle's `$inferSelect` so it can be unit-tested with a
 * plain object.
 */
export interface RevertPlannerInput {
  status: string;
  targetType: string;
  targetId: string;
  proposalType: string;
  data: unknown;
}

/**
 * Decide the inverse of an approved proposal, reading ONLY the proposal's own
 * stored data — no schema change. The created ids come from:
 *   - `data.materialized.{entityIds,relationIds,documentIds}` — the canonical
 *     record the approve flow stamps (REQUIRED for inline-create + composite,
 *     whose ids are minted fresh and are otherwise unrecoverable);
 *   - falling back to `targetId` for the branches whose materialized id is the
 *     proposal target itself (generic `.validated` create where subjectId is the
 *     target; document create where documentId === targetId).
 *
 * Returns `unsupported` (→ fail loud) for update/edit proposals (no before-state)
 * and for anything we cannot positively map to created rows.
 */
export function planProposalRevert(
  proposal: RevertPlannerInput
): ProposalRevertPlan {
  const data =
    proposal.data && typeof proposal.data === "object"
      ? (proposal.data as StoredProposalData)
      : undefined;
  const materialized = data?.materialized;

  // Normalize the change kind. proposalType is a free string ("create",
  // "update", "edit", "delete", "create_branch", …) and request-shaped data
  // carries a `changeType`. Prefer changeType, fall back to proposalType.
  const changeType =
    (data && isRequestShapedProposalData(data) ? data.changeType : undefined) ??
    proposal.proposalType;
  const isCreate =
    proposal.proposalType === "create" ||
    changeType === "create" ||
    isCompositeProposalData(data ?? null);
  const isUpdate =
    !isCreate &&
    (proposal.proposalType === "update" ||
      proposal.proposalType === "edit" ||
      proposal.proposalType === "user_edit" ||
      changeType === "update");
  const isDelete =
    !isCreate &&
    !isUpdate &&
    (proposal.proposalType === "delete" || changeType === "delete");
  const isMerge =
    !isCreate &&
    !isUpdate &&
    !isDelete &&
    (proposal.proposalType === "merge" || changeType === "merge");

  // Update/edit: reverting needs the BEFORE-state, which is NOT persisted
  // anywhere on the row (the review enrich computes a before→after diff at read
  // time from the live entity, but the pre-approval snapshot is gone). Fail loud
  // rather than fabricate.
  if (isUpdate) {
    return {
      kind: "unsupported",
      reason:
        "Revert of an update/edit proposal is not supported without a before-snapshot (none is persisted on the proposal).",
    };
  }

  // Delete/archive: undoing a delete means RESTORING the target. Entity deletes
  // in this codebase are SOFT deletes (entities.ts sets `deletedAt`, the row
  // survives) — so an entity delete can be reverted by clearing `deletedAt`.
  // Whether the row is STILL restorable (not later hard-purged) is checked at
  // execution time in the `revert` mutation, since that requires a DB read.
  // Document/relation deletes are hard deletes today — no recoverable target.
  if (isDelete) {
    if (proposal.targetType === "entity" && proposal.targetId) {
      return { kind: "restore-delete", entityId: proposal.targetId };
    }
    return {
      kind: "unsupported",
      reason: `Revert of a '${proposal.targetType}' delete proposal is not supported: no recoverable soft-delete for this target type.`,
    };
  }

  // Entity merge: prefer FULL unmerge when invertibility stamp + snapshots are
  // present; fall back to soft-undelete of the loser for legacy stamps that
  // only recorded loserId (pre-B2 partial unmerge).
  if (isMerge) {
    const mergeStamp = materialized?.merge;
    const winnerId =
      (mergeStamp?.winnerId as string | undefined) ??
      (data &&
      typeof data === "object" &&
      typeof (data as { winnerId?: unknown }).winnerId === "string"
        ? ((data as { winnerId: string }).winnerId as string)
        : undefined);
    const loserId =
      (mergeStamp?.loserId as string | undefined) ??
      (data &&
      typeof data === "object" &&
      typeof (data as { loserId?: unknown }).loserId === "string"
        ? ((data as { loserId: string }).loserId as string)
        : undefined);

    const previousWinnerSnapshot =
      data &&
      typeof data === "object" &&
      (data as { previousWinnerSnapshot?: unknown }).previousWinnerSnapshot &&
      typeof (data as { previousWinnerSnapshot?: unknown })
        .previousWinnerSnapshot === "object"
        ? ((data as { previousWinnerSnapshot: unknown })
            .previousWinnerSnapshot as {
            title?: string | null;
            preview?: string | null;
            properties?: Record<string, unknown>;
            documentId?: string | null;
            systemData?: Record<string, unknown>;
          })
        : undefined;

    // Full unmerge when stamp has invertibility fields (rewiredRelations etc.).
    if (winnerId && loserId && previousWinnerSnapshot && mergeStamp) {
      try {
        assertUnmergeable({
          winnerId,
          loserId,
          previousWinnerSnapshot,
          materialized: mergeStamp as MergeMaterializedStamp,
        });
        return { kind: "unmerge", winnerId, loserId };
      } catch {
        // Incomplete stamp — fall through to legacy restore-delete if possible.
      }
    }

    if (loserId) {
      return { kind: "restore-delete", entityId: loserId };
    }
    return {
      kind: "unsupported",
      reason:
        "Revert of an entity merge requires materialized.merge.loserId (approve stamp missing).",
    };
  }

  if (isCreate) {
    const entityIds = [...(materialized?.entityIds ?? [])];
    const relationIds = [...(materialized?.relationIds ?? [])];
    const documentIds = [...(materialized?.documentIds ?? [])];

    // Fallback for branches whose created id IS the proposal target and which
    // therefore may not have stamped `materialized` (generic `.validated` entity
    // create; document create where documentId === targetId).
    if (
      entityIds.length === 0 &&
      relationIds.length === 0 &&
      documentIds.length === 0
    ) {
      if (proposal.targetType === "entity" && proposal.targetId) {
        entityIds.push(proposal.targetId);
      } else if (proposal.targetType === "document" && proposal.targetId) {
        documentIds.push(proposal.targetId);
      }
    }

    if (
      entityIds.length === 0 &&
      relationIds.length === 0 &&
      documentIds.length === 0
    ) {
      return {
        kind: "unsupported",
        reason: `Revert of a '${proposal.targetType}' create proposal is not supported: no materialized record of created rows.`,
      };
    }

    return { kind: "delete-creations", entityIds, relationIds, documentIds };
  }

  return {
    kind: "unsupported",
    reason: `Revert of proposal type '${proposal.targetType}/${proposal.proposalType}' is not supported.`,
  };
}

/**
 * Apply an APPROVED proposal — the ONE door both `approve` and `batchApprove`
 * go through, so a batch approve is exactly N single approves.
 *
 * Callers own AUTHORITY (who may approve) and STATUS eligibility; this owns
 * MATERIALIZATION. Order is the historical top-down if-chain:
 *   1. composite (multi-op graph)  — keyed off PAYLOAD SHAPE, not a type string
 *   2. document-content (AI edit)  — same
 *   3. governance.widen_lane (trusted-lane widen) — keyed off proposalType
 *   4. the proposal-execution registry (every typed key + the catch-all)
 *
 * Extracted because `batchApprove` used to inline ONLY step 3's generic
 * `.validated`-emit tail and never resolved an executor at all: "Approve all"
 * flipped the row to APPROVED and silently did nothing for every proposal type
 * the materializer has no case for (automation/execute, document/create,
 * project/create, playbook/*, capability.*, provider.action, …) and ran the
 * WRONG generic path for the ~13 it does. A second implementation that drifts
 * from the first is exactly the bug class that produced this — hence one door,
 * not two.
 */

/**
 * `governance.widen_lane` proposal payload (Governance Convergence Plan,
 * Phase D). Emitted ONLY by the trusted-lane scanner job (never inserted
 * directly) — approval here is the ONE door that turns it into a
 * `governance_rules` row. `verdict` is always "auto": a widen proposal only
 * ever opens the auto-approve door, never denies.
 */
export interface GovernanceWidenLaneProposalData {
  agentUserId: string;
  targetKind: GovernanceTarget;
  targetPattern: string;
  targetProfile?: string | null;
  scopeKind: GovernanceScope;
  workspaceId?: string | null;
  verdict: "auto";
  evidence: {
    total: number;
    approveRate: number;
    duplicateRate: number;
  };
}

async function applyProposalApproval(args: {
  proposal: NonNullable<
    Awaited<ReturnType<typeof db.query.proposals.findFirst>>
  >;
  userId: string;
  input: {
    proposalId: string;
    comment?: string;
    /** Composite-only per-item dispositions. Absent on the batch door. */
    dispositions?: GraphDispositionMap;
    /** Single-entity per-field property reconciliation decisions (entity/create + entity/update). */
    propertyDecisions?: PropertyDecisionMap;
    /**
     * Composite per-ENTITY property reconciliation, nested by the composite
     * item's ref (`entities[].ref` — `$opN`/op `ref` — the SAME key
     * `dispositions` uses). Each inner map is a single-entity `PropertyDecisionMap`.
     * Honored only by the composite branch; absent ref-slice ⇒ defaults apply.
     */
    propertyDecisionsByRef?: Record<string, PropertyDecisionMap>;
    /**
     * Approve-time FACET channel (domain-agnostic). Caller-NAMED facets to
     * attach to the entities this approval creates: `facetsByRef` (composite,
     * keyed by the SAME entity ref `op.ref ?? "$op<index>"` `dispositions` uses)
     * and `facets` (single `entity/create`). Attached verbatim — no defaults,
     * no kind/relation eligibility. An absent ref ⇒ no facets for that entity.
     */
    facets?: FacetSpec[];
    facetsByRef?: Record<string, FacetSpec[]>;
  };
  ctx: Context;
}): Promise<ProposalExecutorResult> {
  const { proposal, userId, input, ctx } = args;

  const payload = proposal.data as StoredProposalData | null | undefined;

  // B0: Composite (multi-op) GRAPH proposal — one approval creates N
  // entities AND M relations among them, atomically validated as a unit
  // (e.g. an imported note graph, or a Question + links to its captures).
  // Checked BEFORE the single-op branches. Pass 1 creates every
  // create_entity op via the canonical entity path (full side effects),
  // building a ref→realId map; pass 2 creates relations resolving each
  // sourceRef/targetRef ($opN / op `ref` / PRIMARY_REF / real UUID).
  // Linking is best-effort — an individual relation failure is logged but
  // never discards the (valid) created entities.
  if (isCompositeProposalData(payload)) {
    let compositeCtx: {
      db: typeof db;
      authenticated: true;
      userId: string;
      workspaceId: string | null;
      workspaceRole: string;
      // The session this proposal belongs to (import.graph carries it).
      // entities.create reads ctx.sessionId to write the
      // `session --produced--> entity` link and stamp the side-effect so
      // playbook automations fire for these entities. Mirrors the import
      // orchestrator's apply() path for the governed-approval route.
      sessionId: string | null;
    };
    if (proposal.workspaceId) {
      const membership = await getWorkspaceMembership(
        db,
        proposal.workspaceId,
        userId
      );
      if (!membership) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "No workspace access",
        });
      }
      compositeCtx = {
        db,
        authenticated: true as const,
        userId,
        workspaceId: proposal.workspaceId,
        workspaceRole: membership.role,
        sessionId: proposal.sessionId ?? null,
      };
    } else {
      compositeCtx = {
        db,
        authenticated: true as const,
        userId,
        workspaceId: null,
        workspaceRole: "owner",
        sessionId: proposal.sessionId ?? null,
      };
    }

    const entityCaller = regularEntitiesRouter.createCaller(
      compositeCtx as unknown as Context
    );
    const relationCaller = relationsRouter.createCaller(
      compositeCtx as unknown as Context
    );

    // Phase 2 — per-item dispositions (partial apply). When the reviewer
    // sent a `dispositions` map, filter the ops BEFORE materialize: drop
    // rejected entities, merge edits, cascade-drop relations/facets whose
    // endpoint is a rejected entity. Absent map ⇒ apply-all (byte-identical
    // to the whole-proposal path). `materializeCompositeGraph` is already
    // per-op resilient and needs no internal change — the cascade guarantees
    // no dangling ref reaches it.
    // Source of truth = the dispositions persisted incrementally by
    // `rejectItem` (immediate-commit deny), MERGED with any map the client
    // sends on Approve (which wins for last-second changes). Either alone
    // works — a purely staged client, or a purely immediate-commit flow.
    const persistedDisp = (payload as { dispositions?: GraphDispositionMap })
      .dispositions;
    const clientDisp = input.dispositions as GraphDispositionMap | undefined;
    const dispositions: GraphDispositionMap | undefined =
      persistedDisp || clientDisp
        ? { ...(persistedDisp ?? {}), ...(clientDisp ?? {}) }
        : undefined;
    const operationsToMaterialize =
      dispositions && Object.keys(dispositions).length > 0
        ? applyGraphDispositions(payload.operations, dispositions)
        : payload.operations;

    // Per-ENTITY property reconciliation (composite path) — the SAME orchestrator
    // the single-entity entity/create executor uses. For each ACCEPTED
    // create_entity op, classify its proposed property keys against the target
    // kind's def slugs: match → keep, high-confidence fuzzy → remap onto the def
    // slug, otherwise → keep as a first-class field (a def is created so it is
    // queryable/rendered) — honoring the reviewer's per-entity decision slice
    // `propertyDecisionsByRef[ref]`. Best-effort / no-data-loss (verbatim
    // fallback on def-create failure) is owned by reconcileApprovedProperties.
    //
    // REF IDENTITY: the outer key is the composite item's ref — `op.ref ??
    // opRef(originalIndex)`, the SAME key `dispositions` and the review UI use.
    // `operationsToMaterialize` preserves original order minus rejected ops, so
    // the surviving create_entity ops zip 1:1 (in order) with the surviving refs
    // recomputed on `payload.operations` — recovering the ref for ref-less
    // (`$opN`) ops after the disposition filter dropped their original index.
    // A refused item is already gone from `operationsToMaterialize` (never
    // reconciled, no def created); propertyDecisions only refine an ACCEPTED
    // item's fields.
    // Surviving entity ops → (ref, per-entity decision slice), in the SAME order
    // `applyGraphDispositions` emits them (pure/DB-free zip source; see helper).
    const decisionSlices = survivingEntityDecisionSlices(
      payload.operations,
      dispositions,
      input.propertyDecisionsByRef
    );
    let reconciledOperations: CompositeProposalOperation[] =
      operationsToMaterialize;
    if (operationsToMaterialize.some((op) => op.op === "create_entity")) {
      const profileService = new ProfileResolutionService(db);
      const rebuilt: CompositeProposalOperation[] = [];
      let survivingIdx = 0;
      for (const op of operationsToMaterialize) {
        if (op.op !== "create_entity") {
          rebuilt.push(op);
          continue;
        }
        const entityOp = op as CompositeCreateEntityOp;
        // Zip 1:1 with the surviving-entity slices (same order, rejects dropped
        // identically) — this recovers the ref for ref-less ($opN) ops.
        const { decisions } = decisionSlices[survivingIdx++] ?? {
          decisions: undefined,
        };
        const props = entityOp.properties;
        if (!props || Object.keys(props).length === 0) {
          rebuilt.push(op);
          continue;
        }
        // Def-creation lens for this op: a per-op workspace pin, else the
        // proposal's workspace (null ⇒ pod-wide → reconcile skips def creation
        // and stores new fields verbatim, exactly like the single-entity path).
        const opWorkspaceId =
          entityOp.targetWorkspaceId ?? compositeCtx.workspaceId;
        const profile = await profileService.resolveProfile(
          entityOp.profileSlug,
          userId,
          opWorkspaceId
        );
        const reconciled = await reconcileApprovedProperties({
          properties: props,
          profileId: profile?.id ?? entityOp.profileSlug,
          workspaceId: opWorkspaceId,
          userId,
          decisions,
        });
        rebuilt.push({ ...entityOp, properties: reconciled.properties });
      }
      reconciledOperations = rebuilt;
    }

    // Approve-time FACET channel (domain-agnostic) — attach the caller-NAMED
    // facets (`facetsByRef`, keyed by the SAME ref `dispositions`/
    // `propertyDecisionsByRef` use) to the surviving create_entity ops. Folded
    // into the ops' `.facets` right before materialize; pass 1.5 attaches them
    // through the wired `facetCaller`. Best-effort by construction — a facet
    // attach that fails is logged + skipped inside materialize, never aborting
    // the approve (mirrors the property-reconcile no-abort contract). Slices are
    // computed on the ORIGINAL ops + dispositions so a rejected entity yields no
    // facets. No default/eligibility logic — the backend attaches only what the
    // caller listed.
    if (input.facetsByRef) {
      const facetSlices = survivingEntityFacetSlices(
        payload.operations,
        dispositions,
        input.facetsByRef
      );
      reconciledOperations = foldFacetsIntoOps(
        reconciledOperations,
        facetSlices
      );
    }

    // Shared materialization: N entities → ref map → M relations.
    // Same logic the user-import (/import/apply) path uses.
    const {
      created: createdCount,
      linked,
      primaryId,
      entities: createdEntities,
      refToRealId,
    } = await materializeCompositeGraph(
      reconciledOperations,
      entityCaller,
      relationCaller,
      (err, type) =>
        logger.warn(
          { err, type },
          "composite proposal: relation create failed (entities kept)"
        ),
      // Workspace-scoped imports must pin their entities to the target
      // workspace on approval (overriding pod-default profile entityScope),
      // mirroring rest/capture.ts /import/apply. Only when the proposal is
      // workspace-bound; interactive pod-default approvals stay global.
      // `entityCaller` is the full entitiesRouter caller (same ctx), so it
      // doubles as the facetCaller — attaching declared facets (op.facets)
      // right after each entity materializes.
      {
        ...(proposal.workspaceId ? { workspaceScoped: true } : {}),
        facetCaller: entityCaller,
        // Graph submitters persist their origin in proposal data. Reuse it
        // on approval so source attribution survives the proposal boundary.
        ...(typeof payload.source === "string"
          ? { source: payload.source }
          : {}),
      }
    );

    // Record what we materialized so `revert` can compute the inverse.
    // Only entities CREATED here (not pre-existing linked ones) are ours to
    // undo. Relation ids aren't returned by the materializer, so revert of a
    // composite undoes the created entities (the cascade removes the
    // relations touching them).
    const compositeMaterialized: ProposalMaterializedRecord = {
      entityIds: createdEntities
        .filter((entity) => !entity.linked)
        .map((entity) => entity.entityId),
    };
    // `data.materialized` reflects ONLY the applied ops' created entities
    // (rejected ops never materialize, so they never appear) — `revert`'s
    // planner reads exactly this. Persist the disposition map alongside so
    // the partial-apply decision is durable (drives the review UI's
    // post-approve state + the item-scoped flywheel). We rebuild the WHOLE
    // `data` object here, so this is a full JSONB replace — no partial merge.
    const compositePayload: StoredProposalData = {
      ...payload,
      materialized: compositeMaterialized,
      ...(dispositions && Object.keys(dispositions).length > 0
        ? { dispositions }
        : {}),
    };

    // Provenance: record `session --produced--> entity` for every entity this
    // session created (the composite/AI-capture path doesn't flow through the
    // worker's materializeEntity hook). Together with that hook and the explicit
    // BYOA capture-back, the session room's Deliverable surface populates by
    // construction. Idempotent via the links unique-edge index.
    const producedEntityIds = compositeMaterialized.entityIds ?? [];
    if (proposal.sessionId && producedEntityIds.length > 0) {
      await db
        .insert(links)
        .values(
          producedEntityIds.map((entityId) => ({
            workspaceId: proposal.workspaceId ?? null,
            fromType: "session" as LinkEndpointType,
            fromId: proposal.sessionId as string,
            toType: "entity" as LinkEndpointType,
            toId: entityId,
            linkType: "produced" as LinkType,
            metadata: {},
          }))
        )
        .onConflictDoNothing();
    }
    // Membership: project lens (entity → belongs_to_project → project).
    await stampProjectMembership(proposal, producedEntityIds, userId);

    // ONBOARDING bindings: a graph proposal from /capture/graph may carry
    // `bindings` (Discord channel → entity ref + firewall role). Now that the
    // entities are materialized, bind each channel to its real entity id and
    // stamp its branchPurpose — so /whois + the firewall light up on accept.
    // Additive: only onboarding graph proposals carry bindings; every other
    // composite proposal skips this (no bindings) as a no-op.
    const graphBindings = (
      payload as {
        bindings?: Array<{
          externalChannelId: string;
          entityRef: string;
          branchPurpose?: string;
          title?: string;
        }>;
      }
    ).bindings;
    if (
      Array.isArray(graphBindings) &&
      graphBindings.length > 0 &&
      proposal.workspaceId
    ) {
      const { resolveOrCreateExternalChannel } =
        await import("../services/connectors/inbound-recorder.js");
      for (const b of graphBindings) {
        // Resolve the binding's entity ref to the materialized id. Skip (not
        // fall back to the raw ref) if the entity didn't materialize — binding
        // a channel to a non-id ref string would set a bogus contextObjectId.
        const entityId = refToRealId[b.entityRef];
        if (!b.externalChannelId || !entityId) continue;
        try {
          const { channelId } = await resolveOrCreateExternalChannel({
            provider: "discord",
            externalId: b.externalChannelId,
            userId,
            workspaceId: proposal.workspaceId,
            requireExistingWorkspace: true,
            title: b.title ?? b.externalChannelId,
          });
          await db
            .update(channels)
            .set({
              contextObjectType: "entity",
              contextObjectId: entityId,
              updatedAt: new Date(),
            })
            .where(eq(channels.id, channelId));
          // Firewall role goes through the ONE door (client-comms immutable).
          if (b.branchPurpose) {
            await setChannelBranchPurpose({
              channelId,
              branchPurpose: b.branchPurpose,
            });
          }
        } catch (err) {
          if (err instanceof ChannelFirewallImmutableError) {
            // Fail-SAFE: the channel stays client-comms (the protected
            // outcome). Surface it distinctly so it's not lost in generic
            // bind noise — an onboarding binding tried to reclassify a
            // client-comms channel and was refused.
            logger.warn(
              { channelId: err.channelId, binding: b },
              "onboarding: refused to reclassify a client-comms channel (firewall) — left unchanged"
            );
          } else {
            logger.warn(
              { err, binding: b },
              "onboarding: channel bind failed (entities kept)"
            );
          }
        }
      }
    }

    await db
      .update(proposals)
      .set({
        status: ProposalStatus.APPROVED,
        data: compositePayload,
        reviewedBy: userId,
        reviewedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(proposals.id, input.proposalId));

    // Report to IS telemetry (fire-and-forget — never blocks). This is the
    // CAPTURE lane: `reportProposalOutcome`'s guard is explicitly widened to
    // fire for capture proposals (no agentUserId) "so rejected captures also
    // feed the IS learning sink" — but the approve side never called it, so
    // the sink only ever saw captures the user REJECTED. That asymmetry
    // taught the AI its failures and none of its successes.
    reportProposalOutcome({
      proposalId: input.proposalId,
      outcome: "approved",
      sourceMessageId: proposal.sourceMessageId,
      agentUserId: proposal.agentUserId,
      targetType: proposal.targetType,
      proposalType: proposal.proposalType,
      source: (proposal.data as Record<string, unknown> | null)?.source as
        string | undefined,
    });

    emitProposalReviewed(
      input.proposalId,
      proposal.workspaceId,
      "approved",
      userId
    );

    // Per-item reasoned reject → flywheel, item-scoped (Phase 2, Gap 3).
    // For EACH item the reviewer rejected WITH a reason/reasonCode, emit an
    // item-scoped ai_correction: subjectId = the item's ref (rejected items
    // never materialize, so there is no created id to point at). Mirrors the
    // whole-proposal reject emit — fire on any reasoned rejection (no
    // capture.graph gate). Best-effort: emitAiCorrection swallows + never
    // fails the approve.
    if (dispositions) {
      for (const [itemRef, disp] of Object.entries(dispositions)) {
        if (disp.status !== "reject") continue;
        if (!disp.reason && !disp.reasonCode) continue;
        await emitAiCorrection({
          action: "reject",
          userId,
          subjectId: itemRef,
          workspaceId: proposal.workspaceId ?? undefined,
          data: {
            kind: AI_KIND.EXTRACT,
            correlationId: proposal.correlationId ?? input.proposalId,
            itemRef,
            ...(disp.reason ? { reason: disp.reason } : {}),
            ...(disp.reasonCode ? { reasonCode: disp.reasonCode } : {}),
          },
        });
      }
    }

    return { success: true, primaryId, created: createdCount, linked };
  }

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

    await storage.upload(document.storageKey, Buffer.from(content, "utf-8"), {
      contentType: document.mimeType || "text/plain",
    });
    const versionId = randomUUID();
    const snapshot = await uploadDocumentVersionSnapshot({
      userId,
      documentId: proposal.targetId,
      versionId,
      documentType: document.type,
      mimeType: document.mimeType || "text/plain",
      content,
    });

    await db.insert(documentVersions).values({
      id: versionId,
      documentId: proposal.targetId,
      version: newVersion,
      ...storedVersionValues(snapshot),
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

    // Report to IS telemetry (fire-and-forget — never blocks)
    reportProposalOutcome({
      proposalId: input.proposalId,
      outcome: "approved",
      sourceMessageId: proposal.sourceMessageId,
      agentUserId: proposal.agentUserId,
      targetType: proposal.targetType,
      proposalType: proposal.proposalType,
      source: (proposal.data as Record<string, unknown> | null)?.source as
        string | undefined,
    });

    emitProposalReviewed(
      input.proposalId,
      proposal.workspaceId,
      "approved",
      userId
    );
    return { success: true };
  }

  // B4: governance.widen_lane — Phase D trusted-lane widen. Keyed off
  // proposalType (not payload shape) so it stays inline rather than in the
  // registry (execution-registry.ts is out of scope for this change). The
  // ONLY place a `governance_rules` row is ever inserted — the scanner job
  // that emits this proposal type never writes the table directly.
  if (proposal.proposalType === "governance.widen_lane") {
    const widenData = payload as GovernanceWidenLaneProposalData | null;
    if (
      !widenData ||
      typeof widenData !== "object" ||
      !widenData.agentUserId ||
      !widenData.targetKind ||
      !widenData.targetPattern ||
      !widenData.scopeKind
    ) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Malformed governance.widen_lane proposal data.",
      });
    }

    await db.insert(governanceRules).values({
      principalKind: "agent",
      agentUserId: widenData.agentUserId,
      scopeKind: widenData.scopeKind,
      workspaceId:
        widenData.scopeKind === "workspace"
          ? (widenData.workspaceId ?? null)
          : null,
      targetKind: widenData.targetKind,
      targetPattern: widenData.targetPattern,
      targetProfile: widenData.targetProfile ?? null,
      verdict: "auto",
      sourceProposalId: proposal.id,
      createdBy: userId,
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

    reportProposalOutcome({
      proposalId: input.proposalId,
      outcome: "approved",
      sourceMessageId: proposal.sourceMessageId,
      agentUserId: proposal.agentUserId,
      targetType: proposal.targetType,
      proposalType: proposal.proposalType,
      source: (proposal.data as Record<string, unknown> | null)?.source as
        string | undefined,
    });

    emitProposalReviewed(
      input.proposalId,
      proposal.workspaceId,
      "approved",
      userId
    );
    return { success: true };
  }

  // ── Registry dispatch ──────────────────────────────────────────────────
  // Composite (above) and document-content (B3 above) stay inline because
  // they key off PAYLOAD SHAPE, not a type string. Everything else resolves
  // through the proposal-execution registry: exact `${targetType}/${proposalType}`
  // first (e.g. "entity/create", "document/create"), then proposalType-only
  // (e.g. "messaging.external.send", "provider.action"), then the catch-all
  // (the generic request-shaped `.validated`-emit path). Each executor's body
  // is the verbatim former branch — same callers, same db updates, same
  // emitProposalReviewed/reportProposalOutcome calls, same returns and
  // idempotency guards. NOT_IMPLEMENTED now fires ONLY for a truly-unregistered
  // key (the catch-all itself throws for non-request-shaped payloads),
  // eliminating the silent forgotten-branch failure mode.
  const approveDeps: ProposalExecutorDeps = {
    db,
    emitProposalReviewed,
    reportProposalOutcome,
    stampProjectMembership,
    resolveMessagingAccountForPlatform: (uid, platform) =>
      resolveMessagingAccountForPlatform(db, uid, platform),
    isRequestShapedProposalData,
  };

  // The executor flips status → APPROVED only on success. If it throws (e.g.
  // the target project/entity was deleted after the proposal was filed), the
  // proposal would otherwise stay PENDING forever — a zombie the user clicked
  // Approve on but can never resolve. We do NOT reject (the user's Approve
  // intent is real and feeds the AI flywheel); instead we record the terminal
  // failure as APPROVAL_FAILED + rejectionReason, then RE-THROW so the caller
  // still sees it: single approve → frontend toast; batch approve → that
  // item's `error` field, with every other item still attempted. A retry is
  // allowed — there is no PENDING-only status guard, so re-approving an
  // APPROVAL_FAILED proposal re-runs the executor and flips to APPROVED on
  // success.
  return await dispatchProposalApproval(
    {
      proposal: proposal as never,
      payload,
      userId,
      input,
      ctx,
      deps: approveDeps,
    },
    async (proposalId, errorMessage, failure) => {
      // Guard against a concurrent winner: if another approval attempt already
      // flipped this proposal to APPROVED (a confirmed external dispatch), do NOT
      // clobber it back to APPROVAL_FAILED. Only non-approved rows record failure.
      //
      // P1 "every failure carries a next action": stash the structured failure
      // scalars (errorClass/providerRef) into the proposal's existing `data` JSONB
      // under a `failure` key so the browser can derive a one-click action
      // ("Reconnect Google"). `rejectionReason` (the human string) is UNCHANGED —
      // this rides ALONGSIDE it. Free-form JSONB, no migration. Only written when a
      // scalar was actually classified (a governance/config failure carries none).
      const hasFailureMeta =
        !!failure &&
        (failure.errorClass !== undefined || failure.providerRef !== undefined);
      const nextData = hasFailureMeta
        ? {
            ...((proposal.data as Record<string, unknown> | null) ?? {}),
            failure: {
              ...(failure!.errorClass !== undefined
                ? { errorClass: failure!.errorClass }
                : {}),
              ...(failure!.providerRef !== undefined
                ? { providerRef: failure!.providerRef }
                : {}),
            },
          }
        : undefined;
      await db
        .update(proposals)
        .set({
          status: ProposalStatus.APPROVAL_FAILED,
          rejectionReason: errorMessage,
          ...(nextData !== undefined ? { data: nextData as never } : {}),
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(proposals.id, proposalId),
            ne(proposals.status, ProposalStatus.APPROVED)
          )
        );
    }
  );
}

/**
 * A facet to attach at approve time (approve-time FACET channel). The subset of
 * `entities.attachFacet` input a caller may supply per entity — domain-agnostic.
 */
const facetSpecInput = z.object({
  profileSlug: z.string(),
  status: z.string().optional(),
});

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
          // Widened beyond the original 5 materialized-object types to also
          // accept the config-object proposal targets (automation / playbook /
          // skill). Those rows are ALREADY stored — automation-governance and
          // permission-check write `targetType: singularType` — this filter
          // widening just unblocks querying them (e.g. the loops-map diff
          // overlay). Pure filter widening; no downstream code assumes only 5.
          .enum([
            "document",
            "entity",
            "whiteboard",
            "view",
            "profile",
            "automation",
            "playbook",
            "skill",
          ])
          .optional(),
        targetId: z.string().optional(),
        /**
         * Resolve a bounded notification batch through the normal list path.
         * This remains a filter only: workspace/user visibility predicates are
         * still applied below before any proposal can be returned.
         */
        proposalIds: z
          .array(z.string().uuid())
          .max(100)
          .transform((ids) => [...new Set(ids)])
          .optional(),
        /** Filter to proposals originating from a specific chat thread */
        threadId: z.string().uuid().optional(),
        /** Filter to proposals linked to a specific focus session via correlationId */
        correlationId: z.string().optional(),
        /** Filter to proposals linked to a specific focus session via session_id FK */
        sessionId: z.string().uuid().optional(),
        /** Filter to proposals created by a specific agent */
        agentUserId: z.string().optional(),
        /** When true, only return proposals where agentUserId is not null */
        agentOnly: z.boolean().optional(),
        status: z
          .enum(["pending", "validated", "rejected", "all"])
          .default("pending"),
        /** Cursor-based pagination: ISO timestamp of the last item's createdAt */
        cursor: z.string().optional(),
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
      } else {
        // undefined = user-wide queue. Scope to workspaces the caller belongs
        // to (+ pod-wide globals) — WITHOUT this, list leaks every workspace's
        // proposals (and their data payloads) to any authenticated user.
        conditions.push(
          userVisibleWhere(proposals.workspaceId, requireUserId(ctx.userId))
        );
      }

      if (input.targetType) {
        conditions.push(eq(proposals.targetType, input.targetType));
      }

      if (input.targetId) {
        conditions.push(eq(proposals.targetId, input.targetId));
      }

      if (input.proposalIds && input.proposalIds.length > 0) {
        conditions.push(inArray(proposals.id, input.proposalIds));
      }

      if (input.agentUserId) {
        conditions.push(eq(proposals.agentUserId, input.agentUserId));
      }

      if (input.agentOnly) {
        conditions.push(isNotNull(proposals.agentUserId));
      }

      if (input.threadId) {
        conditions.push(eq(proposals.threadId, input.threadId));
      }

      /** Filter to proposals with a specific correlationId (used to link back to focus sessions) */
      if (input.correlationId) {
        conditions.push(eq(proposals.correlationId, input.correlationId));
      }

      if (input.sessionId) {
        conditions.push(eq(proposals.sessionId, input.sessionId));
      }

      if (input.status === "pending") {
        // "Pending" = the actionable queue. APPROVAL_FAILED belongs here: the
        // user clicked Approve but execution failed, so the proposal is still
        // UNRESOLVED and needs their attention (retry or dismiss). Hiding it
        // (as a plain PENDING-only filter would) is exactly the zombie the user
        // can't see. Terminal states (approved/rejected/reverted/withdrawn) are
        // excluded as before.
        conditions.push(
          inArray(proposals.status, [
            ProposalStatus.PENDING,
            ProposalStatus.APPROVAL_FAILED,
          ])
        );
      } else if (input.status === "validated") {
        // "Approved" tab = applied proposals: BOTH human-approved AND
        // auto-approved (both are revertable, and the board's count folds
        // them together). Auto-approved AI mutations are the primary revert
        // target, so they must surface here, not only under "All".
        conditions.push(
          inArray(proposals.status, [
            ProposalStatus.APPROVED,
            ProposalStatus.AUTO_APPROVED,
          ])
        );
      } else if (input.status === "rejected") {
        conditions.push(eq(proposals.status, ProposalStatus.REJECTED));
      }

      // NOTE: proposals no longer carry a functional expiry (C2 lifecycle-hygiene
      // fix) — `expiresAt` is never set on new rows and is not filtered on here,
      // so a proposal never silently vanishes from this list while still being
      // counted elsewhere (e.g. `synap_orient`'s pending-review summary).

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

      // An explicitly empty batch is a valid no-results filter, rather than an
      // unbounded list request. This intentionally happens AFTER the concrete
      // workspace authorization check above, so it cannot turn an unauthorized
      // workspace probe into a successful response.
      if (input.proposalIds?.length === 0) {
        const { items, pagination } = buildPaginatedResponse([], input);
        return {
          items,
          pagination: { ...pagination, nextCursor: undefined },
          /** @deprecated Use `items` instead */
          proposals: items,
        };
      }

      // Cursor-based pagination: when cursor is provided, add a createdAt < cursor
      // condition and ignore offset.
      if (input.cursor) {
        conditions.push(lt(proposals.createdAt, new Date(input.cursor)));
      }

      const rows = await db.query.proposals.findMany({
        where: conditions.length > 0 ? and(...conditions) : undefined,
        orderBy: [desc(proposals.createdAt), desc(proposals.id)],
        limit: input.limit + 1,
        offset: input.cursor ? 0 : input.offset,
      });

      // Enrich each proposal with a pre-formed `request` object and resolved
      // display metadata. Eve/Studio can render useful labels without leaking
      // raw UUIDs into the main review surface.
      const reviewerId = requireUserId(ctx.userId);
      const enriched = await enrichProposalsForDisplay(rows, reviewerId);

      const { items, pagination } = buildPaginatedResponse(enriched, input);

      // viewerCanReview — per proposal, "can this user approve / reject / revert
      // it?" computed from the SAME ladder the mutations enforce, so the UI shows
      // review actions (Approve, Revert) iff the call would succeed. Batched:
      // one workspace-settings query + one membership query across all distinct
      // workspaces in the page. Pod-wide proposals (no workspace) are reviewable.
      const wsIds = [
        ...new Set(
          rows.map((r) => r.workspaceId).filter((w): w is string => Boolean(w))
        ),
      ];
      const policyByWs = new Map<string, ProposalApprovalPolicy>();
      const roleByWs = new Map<string, string>();
      if (wsIds.length > 0) {
        const { workspaceMembers } = await import("@synap/database/schema");
        const wsRows = await db
          .select({ id: workspaces.id, settings: workspaces.settings })
          .from(workspaces)
          .where(inArray(workspaces.id, wsIds));
        for (const w of wsRows) {
          const s = w.settings as WorkspaceSettings | undefined;
          policyByWs.set(
            w.id,
            (s?.aiGovernance?.proposalApprovalPolicy ??
              "owner_and_admins") as ProposalApprovalPolicy
          );
        }
        const memberRows = await db.query.workspaceMembers.findMany({
          where: and(
            eq(workspaceMembers.userId, reviewerId),
            inArray(workspaceMembers.workspaceId, wsIds)
          ),
        });
        for (const m of memberRows) roleByWs.set(m.workspaceId, m.role);
      }
      // Compute over the typed `rows` (not the casted enriched items) so the
      // workspaceId/data reads are compiler-checked and can't silently break if
      // enrichment ever reshapes the display payload.
      const viewerCanReviewById = new Map<string, boolean>();
      // viewerCanReviewReason — WHY, alongside the boolean above: a short enum
      // string (see `ReviewAuthorityReason`) an AuthorityRow can render as
      // "You can approve because…" / "Requires a workspace admin". Derived from
      // the EXACT SAME inputs `viewerCanReviewById` already computed per row (no
      // extra query), via the shared `formatReviewAuthorityReason` helper the
      // mutation-side `computeCanReviewApproval` also uses — so the reason can
      // never disagree with the boolean. NOTE: unlike `computeCanReviewApproval`,
      // this batched per-row pass does not resolve agent-ownership (would need an
      // extra query per distinct `agentUserId`), so an agent-authored proposal's
      // human owner sees "admin"/"editor" here rather than "agent-owner" — a
      // known, additive-only gap (display never disagrees with the `viewerCanReview`
      // boolean, which has the same limitation today).
      const viewerCanReviewReasonById = new Map<
        string,
        ReviewAuthorityReason
      >();
      for (const r of rows) {
        const data = r.data as Record<string, unknown> | null;
        const hasWorkspace = !!r.workspaceId;
        const policy =
          policyByWs.get(r.workspaceId ?? "") ?? "owner_and_admins";
        const memberRole = roleByWs.get(r.workspaceId ?? "");
        const isOwner = data?.sourceId === reviewerId;
        const allowed = !hasWorkspace
          ? true
          : canReviewProposal({ policy, memberRole, isOwner });
        viewerCanReviewById.set(r.id, allowed);
        viewerCanReviewReasonById.set(
          r.id,
          formatReviewAuthorityReason({
            hasWorkspace,
            policy,
            memberRole,
            isOwner,
            allowed,
          })
        );
      }
      // revertable — per proposal, "would `revert` succeed for this row?"
      // computed from the SAME planner the revert mutation uses (:1903), so the
      // UI can stop hand-mirroring the backend's revert logic (SSOT). Purely a
      // function of the proposal's own stored data (status/target/type/data) —
      // no extra DB round-trip. Only applied proposals (approved/auto_approved)
      // are candidates, mirroring the revert mutation's status gate; every other
      // status is non-revertable, and a plan of `kind: "unsupported"` (e.g. an
      // update/edit with no before-snapshot) → false.
      const revertableById = new Map<string, boolean>();
      for (const r of rows) {
        const isApplied =
          r.status === ProposalStatus.APPROVED ||
          r.status === ProposalStatus.AUTO_APPROVED;
        if (!isApplied) {
          revertableById.set(r.id, false);
          continue;
        }
        const plan = planProposalRevert({
          status: r.status,
          targetType: r.targetType,
          targetId: r.targetId,
          proposalType: r.proposalType,
          data: r.data,
        });
        revertableById.set(r.id, plan.kind !== "unsupported");
      }
      const itemsWithPermission = items.map((it) => {
        const viewerCanReview = viewerCanReviewById.get(it.id) ?? false;
        const revertable = revertableById.get(it.id) ?? false;
        const reasonCode =
          viewerCanReviewReasonById.get(it.id) ?? "not-authorized";
        // "not-authorized: requires admin" — the enum code plus which authority
        // would satisfy this workspace's policy, spelled out for a display string
        // that doesn't need its own lookup table on the frontend.
        const viewerCanReviewReason =
          reasonCode === "not-authorized"
            ? `not-authorized: requires ${reviewAuthorityRequirement(
                policyByWs.get(it.workspaceId ?? "") ?? "owner_and_admins"
              )}`
            : reasonCode;
        return { ...it, viewerCanReview, viewerCanReviewReason, revertable };
      });

      const nextCursor =
        pagination.hasMore && itemsWithPermission.length > 0
          ? itemsWithPermission[
              itemsWithPermission.length - 1
            ]!.createdAt.toISOString()
          : undefined;

      return {
        items: itemsWithPermission,
        pagination: { ...pagination, nextCursor },
        /** @deprecated Use `items` instead */
        proposals: itemsWithPermission,
      };
    }),

  /**
   * Pending proposals collapsed to ONE cluster card per FINGERPRINT — the
   * redesigned inbox centerpiece. A fingerprint = proposalType × targetType × a
   * normalized target-signature (see `computeProposalFingerprint`): identical
   * "update entity X" repeats, or repeated "create company Y" attempts, fold
   * into a single reviewable group with a count + sample + distinct sources.
   *
   * Access: reuses the EXACT scoping `list` uses — `userVisibleWhere` for the
   * user floor + the same workspaceId three-state + optional agentUserId filter,
   * and the same editor+ gate when a concrete workspace is named. No new access
   * logic: a cluster never counts a proposal the caller can't already see in
   * `list`. Grouping is defined over the PENDING actionable queue (PENDING +
   * APPROVAL_FAILED), the same set `list`'s default `status: "pending"` returns.
   */
  groups: protectedProcedure
    .input(
      z.object({
        /** Same three-state as `list`: string = that workspace, null = pod-wide
         *  only, undefined = the full user floor. */
        workspaceId: z.string().nullish(),
        /** Only proposals authored by this agent. */
        agentUserId: z.string().optional(),
        /** Only agent-authored proposals (agentUserId not null). */
        agentOnly: z.boolean().optional(),
        /** Max clusters returned (newest-active first). */
        limit: z.number().min(1).max(100).optional(),
        /** Max pending proposals scanned before grouping — guards a huge inbox. */
        scanLimit: z.number().min(1).max(2000).optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      const userId = requireUserId(ctx.userId);
      const limit = input.limit ?? 50;
      const scanLimit = input.scanLimit ?? 1000;

      // ── Same access predicate `list` builds (workspaceId three-state) ──────
      const conditions = [];
      if (input.workspaceId === null) {
        conditions.push(isNull(proposals.workspaceId));
      } else if (typeof input.workspaceId === "string") {
        conditions.push(eq(proposals.workspaceId, input.workspaceId));
      } else {
        conditions.push(userVisibleWhere(proposals.workspaceId, userId));
      }
      if (input.agentUserId) {
        conditions.push(eq(proposals.agentUserId, input.agentUserId));
      }
      if (input.agentOnly) {
        conditions.push(isNotNull(proposals.agentUserId));
      }
      // The actionable pending queue — identical membership to `list`'s
      // `status: "pending"` branch (PENDING keeps a user's Approve intent
      // visible even when execution later failed).
      conditions.push(
        inArray(proposals.status, [
          ProposalStatus.PENDING,
          ProposalStatus.APPROVAL_FAILED,
        ])
      );
      // NOTE: no expiry filter — see the matching note in `list` (C2 fix).

      // Same editor+ gate as `list` when a concrete workspace is named.
      if (input.workspaceId) {
        const { workspaceMembers } = await import("@synap/database/schema");
        const membership = await db.query.workspaceMembers.findFirst({
          where: and(
            eq(workspaceMembers.workspaceId, input.workspaceId),
            eq(workspaceMembers.userId, userId)
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

      const rows = await db
        .select({
          id: proposals.id,
          proposalType: proposals.proposalType,
          targetType: proposals.targetType,
          targetId: proposals.targetId,
          data: proposals.data,
          agentUserId: proposals.agentUserId,
          sessionId: proposals.sessionId,
          stepRunId: proposals.stepRunId,
          workspaceId: proposals.workspaceId,
          createdAt: proposals.createdAt,
        })
        .from(proposals)
        .where(and(...conditions))
        .orderBy(desc(proposals.createdAt))
        .limit(scanLimit);

      // Resolve provenance labels ONCE, batched, so the pure collapse stays
      // DB-free: stepRunId → automationId (the workflow-attribution chain) and
      // agentUserId → display name (same precedence the review UI uses).
      const stepRunIds = [
        ...new Set(
          rows.map((r) => r.stepRunId).filter((x): x is string => Boolean(x))
        ),
      ];
      const automationByStepRun = new Map<string, string>();
      if (stepRunIds.length > 0) {
        const arows = await db
          .select({
            stepRunId: automationStepRuns.id,
            automationId: automationRuns.automationId,
          })
          .from(automationStepRuns)
          .innerJoin(
            automationRuns,
            eq(automationRuns.id, automationStepRuns.runId)
          )
          .where(inArray(automationStepRuns.id, stepRunIds));
        for (const a of arows)
          automationByStepRun.set(a.stepRunId, a.automationId);
      }

      const agentIds = [
        ...new Set(
          rows.map((r) => r.agentUserId).filter((x): x is string => Boolean(x))
        ),
      ];
      const agentLabelById = new Map<string, string | undefined>();
      if (agentIds.length > 0) {
        const urows = await db
          .select({
            id: users.id,
            name: users.name,
            email: users.email,
            userType: users.userType,
            agentMetadata: users.agentMetadata,
          })
          .from(users)
          .where(inArray(users.id, agentIds));
        for (const u of urows) agentLabelById.set(u.id, displayNameForUser(u));
      }

      const clusterRows: ClusterInputRow[] = rows.map((r) => ({
        id: r.id,
        proposalType: r.proposalType,
        targetType: r.targetType,
        targetId: r.targetId,
        data: r.data,
        createdAt: r.createdAt,
        workspaceId: r.workspaceId ?? null,
        agentLabel: r.agentUserId
          ? (agentLabelById.get(r.agentUserId) ?? null)
          : null,
        sessionId: r.sessionId ?? null,
        automationId: r.stepRunId
          ? (automationByStepRun.get(r.stepRunId) ?? null)
          : null,
      }));

      const groups = collapseProposalsToClusters(clusterRows).slice(0, limit);
      return { groups };
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

      // Visibility gate — the SSOT shared with `source`, the channel-bind
      // chokepoint, and the AI-hydration path (workspace member editor+ / the
      // proposer for a pod-wide proposal).
      await assertProposalVisibleTo(input.proposalId, userId, { db });

      return {
        ...(await enrichProposalsForDisplay([proposal], userId))[0],
      };
    }),

  /**
   * Proposal → SOURCE lineage. Given a proposalId, return deeplink targets
   * branched by PROVENANCE — "where did this proposal come from?" — for the
   * redesign's source panel. All data is already stamped on the proposal row
   * (no columns added): session / channel / agent are direct refs; automation
   * provenance walks the stamped workflow chain
   * `stepRunId → automation_step_runs → automation_runs → automations` and reads
   * the producing flow node's skill / playbook from the run's live definition.
   *
   * Enforces the SAME access check as `get` (editor+ on the workspace, or the
   * proposer for a pod-wide proposal).
   */
  source: protectedProcedure
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

      // Identical access gate to `get` — the shared SSOT.
      await assertProposalVisibleTo(input.proposalId, userId, { db });

      type SourceTargetKind =
        "session" | "channel" | "automation" | "skill" | "playbook" | "agent";
      const targets: Array<{
        kind: SourceTargetKind;
        id: string;
        label: string;
        nodeId?: string;
      }> = [];

      // Provenance: automation (stamped step run) wins, else agent, else human.
      // `let` because a stamped automation whose chain has since been DELETED
      // resolves no automation target below — we downgrade provenance afterward
      // so it never claims "automation" with an empty/mismatched targets set.
      let provenance: "automation" | "agent" | "human" = proposal.stepRunId
        ? "automation"
        : proposal.agentUserId
          ? "agent"
          : "human";

      // ── Direct refs on the proposal row (present-when-stamped) ─────────────
      if (proposal.agentUserId) {
        const [u] = await db
          .select({
            id: users.id,
            name: users.name,
            email: users.email,
            userType: users.userType,
            agentMetadata: users.agentMetadata,
          })
          .from(users)
          .where(eq(users.id, proposal.agentUserId))
          .limit(1);
        targets.push({
          kind: "agent",
          id: proposal.agentUserId,
          label: (u && displayNameForUser(u)) || "Agent",
        });
      }

      if (proposal.sessionId) {
        const [s] = await db
          .select({ goal: focusSessions.goal })
          .from(focusSessions)
          .where(eq(focusSessions.id, proposal.sessionId))
          .limit(1);
        targets.push({
          kind: "session",
          id: proposal.sessionId,
          label: s?.goal || "Session",
        });
      }

      if (proposal.threadId) {
        const [c] = await db
          .select({ title: channels.title })
          .from(channels)
          .where(eq(channels.id, proposal.threadId))
          .limit(1);
        targets.push({
          kind: "channel",
          id: proposal.threadId,
          label: c?.title || "Thread",
        });
      }

      // ── Automation-made: walk the stamped workflow chain ──────────────────
      if (proposal.stepRunId) {
        const [chain] = await db
          .select({
            nodeId: automationStepRuns.nodeId,
            automationId: automationRuns.automationId,
            automationName: automations.name,
            flowDefinition: automations.flowDefinition,
          })
          .from(automationStepRuns)
          .innerJoin(
            automationRuns,
            eq(automationRuns.id, automationStepRuns.runId)
          )
          .innerJoin(
            automations,
            eq(automations.id, automationRuns.automationId)
          )
          .where(eq(automationStepRuns.id, proposal.stepRunId))
          .limit(1);

        if (chain) {
          targets.push({
            kind: "automation",
            id: chain.automationId,
            label: chain.automationName || "Automation",
          });

          // The producing flow node — prefer the proposal's stamped nodeId,
          // fall back to the step-run's. Read its skill / playbook ref from the
          // run's live flow definition (validate-flow.ts carries skillId/
          // skillName on a skill node, playbookId/playbookName on a playbook_run).
          const nodeId = proposal.nodeId ?? chain.nodeId ?? undefined;
          const node = findFlowNode(chain.flowDefinition, nodeId);
          if (node) {
            const data = (node.data ?? {}) as Record<string, unknown>;
            if (node.type === "skill") {
              const skillId =
                typeof data.skillId === "string" ? data.skillId : undefined;
              const skillName =
                typeof data.skillName === "string" ? data.skillName : undefined;
              let label =
                typeof data.skillTitle === "string"
                  ? data.skillTitle
                  : undefined;
              if (skillId && !label) {
                const [row] = await db
                  .select({ name: skills.name })
                  .from(skills)
                  .where(eq(skills.id, skillId))
                  .limit(1);
                label = row?.name ?? undefined;
              }
              const id = skillId ?? skillName;
              if (id) {
                targets.push({
                  kind: "skill",
                  id,
                  label: label || skillName || "Skill",
                  nodeId,
                });
              }
            } else if (node.type === "playbook_run") {
              const playbookId =
                typeof data.playbookId === "string"
                  ? data.playbookId
                  : undefined;
              const playbookName =
                typeof data.playbookName === "string"
                  ? data.playbookName
                  : undefined;
              let label =
                typeof data.label === "string" ? data.label : undefined;
              if (playbookId && !label) {
                const [row] = await db
                  .select({ name: playbooks.name })
                  .from(playbooks)
                  .where(eq(playbooks.id, playbookId))
                  .limit(1);
                label = row?.name ?? undefined;
              }
              const id = playbookId ?? playbookName;
              if (id) {
                targets.push({
                  kind: "playbook",
                  id,
                  label: label || playbookName || "Playbook",
                  nodeId,
                });
              }
            }
          }
        }
      }

      // Consistency floor: if the row was automation-stamped but the automation
      // chain has since been deleted (no automation target resolved), downgrade
      // provenance to match what `targets` actually contains — a "jump to
      // source" UI trusts provenance to have a corresponding target and would
      // otherwise render a broken/empty automation affordance.
      if (
        provenance === "automation" &&
        !targets.some((t) => t.kind === "automation")
      ) {
        provenance = proposal.agentUserId ? "agent" : "human";
      }

      return { provenance, targets };
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
        /**
         * Slice 5 — approval bound to the reviewed version. The
         * `revisionHistory.length` the reviewer's client last saw. When present
         * and it no longer matches the stored proposal (a concurrent revise
         * landed after they looked), approve throws CONFLICT before any
         * mutation. Omit ⇒ today's behavior (no version assertion).
         */
        expectedRevision: z.number().int().nonnegative().optional(),
        /**
         * Phase 2 — per-item accept/edit/reject on a COMPOSITE (graph) proposal.
         * Keyed by item ref: an entity's `entities[].ref` ($opN / op `ref`) or a
         * relation's `$relN` ordinal. Optional — absent ⇒ apply-all (today's
         * whole-proposal approve, byte-identical). Honored ONLY by the composite
         * branch; single-op/document approvals ignore it.
         */
        dispositions: z
          .record(
            z.string(),
            z.object({
              status: z.enum(["accept", "reject", "edit"]),
              reasonCode: z.enum(PROPOSAL_REJECTION_REASONS).optional(),
              reason: z.string().optional(),
              edits: z.record(z.string(), z.unknown()).optional(),
            })
          )
          .optional(),
        /**
         * Per-field property reconciliation, keyed by the PROPOSED property key.
         * Lets the reviewer accept/remap/refuse each free-form property an AI
         * proposed that doesn't match the target kind's def slugs. Honored by the
         * single-entity `entity/create` and `entity/update` executors; absent ⇒
         * defaults apply (matched→keep, high-confidence fuzzy→remap onto the def
         * slug, otherwise→keep-as-new and create a def so the field is queryable).
         *   - keep   → take the key as its own field (create a def if genuinely new).
         *   - remap  → store the value under `toSlug` (an existing or novel def slug).
         *   - refuse → drop the key (reject ONE field without rejecting the proposal).
         */
        propertyDecisions: z
          .record(
            z.string(),
            z.discriminatedUnion("action", [
              z.object({ action: z.literal("keep") }),
              z.object({ action: z.literal("remap"), toSlug: z.string() }),
              z.object({ action: z.literal("refuse") }),
            ])
          )
          .optional(),
        /**
         * COMPOSITE per-entity property reconciliation — the nested twin of
         * `propertyDecisions`, keyed by the composite item's entity ref (the SAME
         * `entities[].ref` / `$opN` key `dispositions` uses, so the frontend keys
         * both maps identically). Each inner value is a single-entity decision
         * map. Honored only by the composite branch; an absent ref-slice ⇒
         * defaults apply for that entity, exactly like the single-entity path.
         */
        propertyDecisionsByRef: z
          .record(
            z.string(),
            z.record(
              z.string(),
              z.discriminatedUnion("action", [
                z.object({ action: z.literal("keep") }),
                z.object({ action: z.literal("remap"), toSlug: z.string() }),
                z.object({ action: z.literal("refuse") }),
              ])
            )
          )
          .optional(),
        /**
         * Approve-time FACET channel (domain-agnostic). Caller-NAMED facets to
         * attach, verbatim, to the entities this approval creates — no default
         * or eligibility logic. `facets` is the flat list for a single
         * `entity/create` approval; ignored by the composite branch (use
         * `facetsByRef`).
         */
        facets: z.array(facetSpecInput).optional(),
        /**
         * COMPOSITE per-entity facet list, keyed by the composite item's entity
         * ref (the SAME `entities[].ref` / `$opN` key `dispositions` and
         * `propertyDecisionsByRef` use). Attached to that entity on approval;
         * absent ref ⇒ no facets. Honored only by the composite branch.
         */
        facetsByRef: z.record(z.string(), z.array(facetSpecInput)).optional(),
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

      // Slice 5: approval bound to the reviewed version. If the client passed
      // the revision count it last saw, reject (CONFLICT) when a concurrent
      // revise has since changed the proposal — BEFORE any mutation, so a stale
      // approval never materializes. Omitted ⇒ no-op (backward-compatible).
      assertReviewedRevision(input.expectedRevision, proposal.revisionHistory);

      // Ownership check: who can approve this proposal? (Shared computation;
      // this door's failure behavior — throw FORBIDDEN — is unchanged.)
      const { allowed: canApprove } = await computeCanReviewApproval({
        proposal,
        userId,
      });
      if (!canApprove) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Not authorized to approve this proposal",
        });
      }

      // Composite, document-content and registry dispatch all live in the ONE
      // shared door below — `batchApprove` calls the SAME function, so a batch
      // approve is exactly N single approves and the two can never drift.
      return await applyProposalApproval({ proposal, userId, input, ctx });
    }),

  /**
   * Revise a pending proposal's data before approving — the USER-facing twin of
   * the service-key hub door `hub-protocol/proposals.ts` `updateProposal`. Powers
   * the reviewer's "Save & Approve" (correct the draft, then approve). Same
   * reviewer-authority ladder as `approve` (`computeCanReviewApproval`). Direct DB
   * update — does NOT re-run the event pipeline. Merge mirrors the hub door: the
   * corrected payload overlays the existing envelope, but the identity fields
   * (`targetType`/`changeType`/`requestId`) are pinned from the stored data so a
   * reviewer edit can never clobber what the approve materializer keys on.
   */
  revise: protectedProcedure
    .input(
      z.object({
        proposalId: z.string(),
        /** The corrected proposal payload (the merged draft the reviewer edited). */
        data: z.record(z.string(), z.unknown()),
        /**
         * Re-target this pending proposal's destination workspace/project
         * WITHOUT rejecting it (e.g. the agent proposed to the wrong
         * workspace) — applies to the top-level `proposals.workspaceId`/
         * `projectId` columns (every gate + the materializer key off these,
         * never `data.workspaceId`). Gated by the SAME reviewer-authority
         * ladder as approve, computed against the proposal's CURRENT
         * workspace — this is a re-scoping action, not a widening of who may
         * act. `null` clears to pod-wide/no-project; omit to leave unchanged.
         */
        workspaceId: z.string().nullable().optional(),
        projectId: z.string().nullable().optional(),
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

      // Authority — SAME ladder `approve` enforces (a revise is a pre-approval
      // edit, so it requires review authority). Pod-wide proposals skip the check.
      const { allowed: canReview } = await computeCanReviewApproval({
        proposal,
        userId,
      });
      if (!canReview) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Not authorized to revise this proposal",
        });
      }

      // Destination authority — a re-target (`workspaceId` explicitly present
      // in the input, including `null` to clear it) requires the actor be
      // authorized on the DESTINATION too, not just the source workspace
      // checked above. Without this a source-workspace reviewer could widen a
      // proposal to pod-wide, or inject it into a workspace's review queue
      // they cannot otherwise access. See `assertCanRetargetProposalDestination`.
      if (input.workspaceId !== undefined) {
        await assertCanRetargetProposalDestination({
          proposal: { data: proposal.data, agentUserId: proposal.agentUserId },
          destWorkspaceId: input.workspaceId,
          userId,
        });
      }

      // Route through the ONE shared revise core. The Studio reviewer's
      // "Save & Approve" pre-wraps its edited inner as `{ data: inner }`, so the
      // deployed frontend already speaks envelope-language — pass it through as
      // an ENVELOPE patch (byte-identical to the historic top-level merge). The
      // core row-locks + asserts PENDING (CONFLICT if a concurrent approve/reject
      // flipped it — the reviewer's edits are never silently dropped) and now
      // appends a `revisionHistory` entry so "Save & Approve" is recorded.
      await mergeProposalRevision({
        proposalId: input.proposalId,
        actorId: userId,
        patch: { kind: "envelope", fields: input.data },
        workspaceId: input.workspaceId,
        projectId: input.projectId,
      });

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
        /** Structured rejection taxonomy — Phase 1 reasoned-rejection loop. */
        reasonCode: z.enum(PROPOSAL_REJECTION_REASONS).optional(),
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
          proposalType: true,
          correlationId: true,
          data: true,
        },
      });

      // Authority — SAME ladder `approve`/`revert` enforce. Without this a
      // rejection was gated only by `requireUserId` (any member could reject
      // any proposal by id). Pod-wide (no workspace) proposals skip the check.
      if (proposal) {
        await assertCanReviewProposal({
          proposal: {
            workspaceId: proposal.workspaceId,
            data: proposal.data,
            agentUserId: proposal.agentUserId,
          },
          userId,
          action: "reject",
        });
      }

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
          proposalType: proposal.proposalType,
          source: (proposal.data as Record<string, unknown> | null)?.source as
            string | undefined,
          rejectionReason: input.reason,
        });
        emitProposalReviewed(
          input.proposalId,
          proposal.workspaceId,
          "rejected",
          userId
        );

        // Feedback signal — a human rejected an AI-proposed write WITH a reason,
        // i.e. corrected the AI. Emit whenever a reason/reasonCode is present.
        // DOGFOOD 2026-07-13: the earlier `capture.graph`-only gate (mirrored from
        // `revert`) NEVER fired — capture.graph proposals are auto-approved, so
        // they are never rejected; real rejects are delete/attach/update/graph.
        // correlationId falls back to the proposal id so the correction is always
        // keyed for the `byReasonCode` breakdown; it only joins routing-threshold
        // tuning when it matches a real ROUTE decision (a proposal id never does),
        // so this can never pollute the confidence gate. Best-effort.
        if (input.reason || input.reasonCode) {
          await emitAiCorrection({
            action: "reject",
            userId,
            subjectId: input.proposalId,
            workspaceId: proposal.workspaceId ?? undefined,
            data: {
              kind: AI_KIND.EXTRACT,
              correlationId: proposal.correlationId ?? input.proposalId,
              ...(input.reason ? { reason: input.reason } : {}),
              ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
            },
          });
        }
      }

      return { success: true };
    }),

  /**
   * Per-item deny that COMMITS IMMEDIATELY (not staged until Approve). Persists
   * the disposition into `data.dispositions[itemRef]` AND emits the item-scoped
   * flywheel correction the moment a reviewer denies a single graph item. This
   * makes a deny durable + verifiable even if the reviewer never clicks Approve;
   * `approve` reads this persisted map (merged with any client-sent map) as the
   * source of truth. Same authority ladder as `reject`.
   */
  rejectItem: protectedProcedure
    .input(
      z.object({
        proposalId: z.string(),
        /** The item's ref: `$opN`/op `ref` for an entity, `$relN` for a relation. */
        itemRef: z.string(),
        reason: z.string().optional(),
        reasonCode: z.enum(PROPOSAL_REJECTION_REASONS).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const proposal = await db.query.proposals.findFirst({
        where: eq(proposals.id, input.proposalId),
        columns: {
          workspaceId: true,
          data: true,
          correlationId: true,
          agentUserId: true,
        },
      });
      if (!proposal)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Proposal not found",
        });
      await assertCanReviewProposal({
        proposal: {
          workspaceId: proposal.workspaceId,
          data: proposal.data,
          agentUserId: proposal.agentUserId,
        },
        userId,
        action: "reject",
      });

      const disp = {
        status: "reject" as const,
        ...(input.reason ? { reason: input.reason } : {}),
        ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
      };
      const data = (proposal.data ?? {}) as Record<string, unknown>;
      const dispositions = {
        ...((data.dispositions as Record<string, unknown>) ?? {}),
        [input.itemRef]: disp,
      };
      await db
        .update(proposals)
        .set({
          data: { ...data, dispositions } as never,
          updatedAt: new Date(),
        })
        .where(eq(proposals.id, input.proposalId));

      // Flywheel — the reasoned per-item rejection, emitted immediately (not at
      // Approve). Best-effort: never fail the deny.
      if (input.reason || input.reasonCode) {
        await emitAiCorrection({
          action: "reject_item",
          userId,
          subjectId: input.itemRef,
          workspaceId: proposal.workspaceId ?? undefined,
          data: {
            kind: AI_KIND.EXTRACT,
            correlationId: proposal.correlationId ?? input.proposalId,
            itemRef: input.itemRef,
            ...(input.reason ? { reason: input.reason } : {}),
            ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
          },
        });
      }
      return { success: true };
    }),

  /** Undo a per-item deny — remove the item's disposition (restore to accept). */
  restoreItem: protectedProcedure
    .input(z.object({ proposalId: z.string(), itemRef: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const proposal = await db.query.proposals.findFirst({
        where: eq(proposals.id, input.proposalId),
        columns: { workspaceId: true, data: true, agentUserId: true },
      });
      if (!proposal)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Proposal not found",
        });
      await assertCanReviewProposal({
        proposal: {
          workspaceId: proposal.workspaceId,
          data: proposal.data,
          agentUserId: proposal.agentUserId,
        },
        userId,
        action: "reject",
      });

      const data = (proposal.data ?? {}) as Record<string, unknown>;
      const dispositions = {
        ...((data.dispositions as Record<string, unknown>) ?? {}),
      };
      delete dispositions[input.itemRef];
      await db
        .update(proposals)
        .set({
          data: { ...data, dispositions } as never,
          updatedAt: new Date(),
        })
        .where(eq(proposals.id, input.proposalId));
      return { success: true };
    }),

  /**
   * Reopen a REJECTED proposal — the inverse of `reject`. Rejecting is
   * non-destructive (it only flips status + records the reason; the full change
   * payload is kept), so a denied proposal can be put back into the pending
   * queue and approved normally. Symmetric with `revert` (which undoes an
   * APPROVED one). The one-click "Accept instead" in the UI is `reopen` then
   * `approve`, so approve's full governance still runs on the re-apply.
   */
  reopen: protectedProcedure
    .input(z.object({ proposalId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);

      const proposal = await db.query.proposals.findFirst({
        where: eq(proposals.id, input.proposalId),
        columns: {
          status: true,
          workspaceId: true,
          data: true,
          agentUserId: true,
        },
      });
      if (!proposal) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Proposal not found",
        });
      }
      if (proposal.status !== ProposalStatus.REJECTED) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Only a rejected proposal can be reopened.",
        });
      }

      // Authority — SAME ladder `approve`/`revert` enforce. Reopening puts a
      // rejected proposal back into the pending queue, so it must require the
      // same review authority as approving/rejecting it. Pod-wide (no
      // workspace) proposals skip the check, mirroring approve/revert.
      await assertCanReviewProposal({
        proposal: {
          workspaceId: proposal.workspaceId,
          data: proposal.data,
          agentUserId: proposal.agentUserId,
        },
        userId,
        action: "reopen",
      });

      await db
        .update(proposals)
        .set({
          status: ProposalStatus.PENDING,
          rejectionReason: null,
          reviewedBy: null,
          reviewedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(proposals.id, input.proposalId));

      // Realtime-only refresh (no approve/reject side effects — see helper): moves
      // the proposal from the rejected list back into the pending queue everywhere.
      emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "reopened",
        userId
      );

      return { success: true };
    }),

  /**
   * Withdraw a PENDING proposal — a PROPOSER action (NOT a reviewer action).
   * The person who filed a proposal can retract it before anyone reviews it.
   *
   * Authority is proposer-only, NOT the approval-policy ladder: it's your own
   * proposal, so no reviewer role is required. A caller may withdraw a pending
   * proposal when they are:
   *   - the recorded human proposer (`proposedByUserId === userId`), OR
   *   - the human owner of an agent proposal (`agentUserId` set AND
   *     `createdBy === userId` — createProposal stamps the triggering human as
   *     `createdBy`). This lets the human who dispatched an agent retract the
   *     agent's still-pending request.
   * Anyone else — including a workspace owner/admin who is NOT the proposer —
   * must use `reject`, not `withdraw`. Pending-only: an already
   * approved/rejected/withdrawn proposal cannot be withdrawn.
   */
  withdraw: protectedProcedure
    .input(z.object({ proposalId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);

      const proposal = await db.query.proposals.findFirst({
        where: eq(proposals.id, input.proposalId),
        columns: {
          status: true,
          workspaceId: true,
          proposedByUserId: true,
          agentUserId: true,
          createdBy: true,
        },
      });
      if (!proposal) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Proposal not found",
        });
      }
      if (proposal.status !== ProposalStatus.PENDING) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Only a pending proposal can be withdrawn.",
        });
      }

      const isHumanProposer =
        !!proposal.proposedByUserId && proposal.proposedByUserId === userId;
      const isAgentOwner =
        !!proposal.agentUserId && proposal.createdBy === userId;
      if (!isHumanProposer && !isAgentOwner) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only the proposer can withdraw this proposal.",
        });
      }

      await db
        .update(proposals)
        .set({
          status: ProposalStatus.WITHDRAWN,
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(proposals.id, input.proposalId));

      // Realtime + notification clear only (no approve/reject automation side
      // effects — see emitProposalReviewed): removes it from the pending queue.
      emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "withdrawn",
        userId
      );

      return { success: true };
    }),

  /**
   * Revert an APPROVED / AUTO-APPROVED proposal — the undo half of
   * "reviewable AND reversible". Reads the proposal's own stored data to compute
   * the inverse (no schema change): a create proposal's materialized entity /
   * relation / document ids are deleted; update and delete proposals fail loud
   * (no recoverable before-snapshot). Authority mirrors `approve`.
   */
  revert: protectedProcedure
    .input(
      z.object({
        proposalId: z.string(),
        reason: z.string().optional(),
        /**
         * "Re-propose" — instead of flipping to the TERMINAL `reverted` status,
         * return the proposal to the PENDING queue after the inverse is applied,
         * so it can be re-accepted. `proposal.data` (the original payload) is
         * kept intact, so a re-accept re-materializes everything. The
         * `revertedBy`/`revertedAt` audit stamp is still recorded (it does not
         * block re-acceptance). Default false = the historical terminal revert.
         */
        reopen: z.boolean().optional().default(false),
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

      // Recovery: a proposal already in the TERMINAL `reverted` status can be
      // re-proposed back to PENDING — but ONLY via reopen (a plain `revert({})`
      // on a reverted proposal has nothing left to invert and stays rejected).
      // This rescues proposals that were reverted (un-materialized) under the
      // OLD backend and are now stranded in REVERTED. The inverse is NOT re-run
      // (entities are already un-materialized); we skip straight to PENDING.
      const isRevertedReopen =
        proposal.status === ProposalStatus.REVERTED && input.reopen === true;

      // Only an applied proposal can be reverted (or a reverted one re-proposed).
      if (
        proposal.status !== ProposalStatus.APPROVED &&
        proposal.status !== ProposalStatus.AUTO_APPROVED &&
        !isRevertedReopen
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Only approved or auto-approved proposals can be reverted (status: ${proposal.status}).`,
        });
      }

      // Authority — SAME policy as approve (owner_and_admins | admins_only |
      // any_editor). Pod-wide proposals (no workspace) skip the workspace check,
      // mirroring approve.
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
        const proposalData = proposal.data as Record<string, unknown> | null;

        const canRevert = canReviewProposal({
          policy: policy as ProposalApprovalPolicy,
          memberRole: membership?.role,
          isOwner: proposalData?.sourceId === userId,
        });

        if (!canRevert) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Not authorized to revert this proposal",
          });
        }
      }

      // Reverted → re-propose: the entities are ALREADY un-materialized (this
      // backend's earlier revert, or the OLD backend that stranded the proposal
      // in REVERTED). Do NOT run the inverse again — it would try to re-delete
      // already-deleted rows. Skip straight to returning it to PENDING, keeping
      // `data` (incl. `operations`) intact so a re-accept re-materializes, and
      // clear the review stamp so it re-surfaces as actionable. Re-emit the
      // pending notification exactly as the approved→reopen tail does. The CAS
      // guards the double-reopen race by only matching a still-REVERTED row.
      if (isRevertedReopen) {
        const reopenedAt = new Date();
        const flipped = await db
          .update(proposals)
          .set({
            status: ProposalStatus.PENDING,
            reviewedBy: null,
            reviewedAt: null,
            updatedAt: reopenedAt,
          })
          .where(
            and(
              eq(proposals.id, input.proposalId),
              eq(proposals.status, ProposalStatus.REVERTED)
            )
          )
          .returning({ id: proposals.id });

        if (flipped.length === 0) {
          // A concurrent reopen already moved it back to the queue — idempotent.
          return { success: true, reopened: true, alreadyReopened: true };
        }

        emitProposalReviewed(
          input.proposalId,
          proposal.workspaceId,
          "reopened",
          userId
        );

        return { success: true, reopened: true };
      }

      // Compute the inverse from the proposal's own data. Fail loud on anything
      // we can't safely undo (update/delete, or a create with no recorded ids).
      const plan = planProposalRevert({
        status: proposal.status,
        targetType: proposal.targetType,
        targetId: proposal.targetId,
        proposalType: proposal.proposalType,
        data: proposal.data,
      });

      if (plan.kind === "unsupported") {
        throw new TRPCError({
          code: "NOT_IMPLEMENTED",
          message: plan.reason,
        });
      }

      // Build a caller ctx mirroring approve's composite branch. Pod-wide
      // proposals run as owner with no workspace (entities.delete is a
      // podProcedure that reads ctx.workspaceId).
      let revertCtx: {
        db: typeof db;
        authenticated: true;
        userId: string;
        workspaceId: string | null;
        workspaceRole: string;
      };
      if (proposal.workspaceId) {
        const membership = await getWorkspaceMembership(
          db,
          proposal.workspaceId,
          userId
        );
        if (!membership) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "No workspace access",
          });
        }
        revertCtx = {
          db,
          authenticated: true as const,
          userId,
          workspaceId: proposal.workspaceId,
          workspaceRole: membership.role,
        };
      } else {
        revertCtx = {
          db,
          authenticated: true as const,
          userId,
          workspaceId: null,
          workspaceRole: "owner",
        };
      }

      const entityCaller = regularEntitiesRouter.createCaller(
        revertCtx as unknown as Context
      );
      const relationCaller = relationsRouter.createCaller(
        revertCtx as unknown as Context
      );
      const documentCaller = documentsRouter.createCaller(
        revertCtx as unknown as Context
      );

      // Apply the inverse. Three shapes:
      //   - "delete-creations": the proposal CREATED rows — undo by deleting
      //     them through the SAME canonical routers approve uses, so the undo
      //     is governed and emits its own delete events. Idempotent (entities
      //     delete soft/hard-deletes by id; relations/documents delete by id)
      //     so a partial earlier revert can be retried safely.
      //   - "restore-delete": the proposal DELETED an entity (soft-delete) —
      //     undo by clearing `deletedAt` directly, guarded against the row
      //     having since been hard-purged. Also the legacy fallback for merge
      //     proposals that only stamped loserId (partial unmerge).
      //   - "unmerge": full entity-merge inverse via unmergeEntities.
      const deleted: ProposalMaterializedRecord = {
        entityIds: [],
        relationIds: [],
        documentIds: [],
      };
      const failures: string[] = [];
      let restoredEntityId: string | undefined;
      let unmerged: { winnerId: string; loserId: string } | undefined;

      if (plan.kind === "unmerge") {
        const existingData =
          proposal.data && typeof proposal.data === "object"
            ? (proposal.data as StoredProposalData & {
                previousWinnerSnapshot?: {
                  title?: string | null;
                  preview?: string | null;
                  properties?: Record<string, unknown>;
                  documentId?: string | null;
                  systemData?: Record<string, unknown>;
                };
                previousLoserSnapshot?: {
                  title?: string | null;
                  preview?: string | null;
                  properties?: Record<string, unknown>;
                  documentId?: string | null;
                  systemData?: Record<string, unknown>;
                };
                sourceId?: string;
                materialized?: ProposalMaterializedRecord;
              })
            : undefined;
        const mergeStamp = existingData?.materialized?.merge;
        if (!mergeStamp || !existingData?.previousWinnerSnapshot) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "Cannot unmerge — merge invertibility stamp or previousWinnerSnapshot missing.",
          });
        }

        // Run as the data owner (same as merge approve), not the reverter.
        const ownerUserId =
          (typeof existingData.sourceId === "string" &&
            existingData.sourceId) ||
          userId;

        try {
          unmerged = await unmergeEntities(db, {
            winnerId: plan.winnerId,
            loserId: plan.loserId,
            userId: ownerUserId,
            previousWinnerSnapshot: existingData.previousWinnerSnapshot,
            previousLoserSnapshot: existingData.previousLoserSnapshot,
            materialized: mergeStamp as MergeMaterializedStamp,
          });
        } catch (err) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              err instanceof Error ? err.message : "Entity unmerge failed",
          });
        }

        restoredEntityId = plan.loserId;
        // Winner update side-effect now; loser restore is emitted below via
        // restoredEntityId (shared path with restore-delete).
        emitSideEffects({
          subjectType: "entity",
          action: "update",
          subjectId: plan.winnerId,
          userId: ownerUserId,
          workspaceId: proposal.workspaceId ?? undefined,
          data: { reason: "entity.unmerge", loserId: plan.loserId },
        });
      } else if (plan.kind === "restore-delete") {
        const [entityRow] = await db
          .select({ id: entities.id, deletedAt: entities.deletedAt })
          .from(entities)
          .where(eq(entities.id, plan.entityId))
          .limit(1);

        if (!entityRow) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message:
              "Cannot restore — the entity was permanently purged and no longer exists.",
          });
        }

        if (entityRow.deletedAt !== null) {
          await db
            .update(entities)
            .set({ deletedAt: null, updatedAt: new Date() })
            .where(eq(entities.id, plan.entityId));
        }
        // else: already restored (e.g. a concurrent revert won) — idempotent no-op.

        restoredEntityId = plan.entityId;
      } else {
        for (const relationId of plan.relationIds) {
          try {
            await relationCaller.delete({ id: relationId });
            deleted.relationIds!.push(relationId);
          } catch (err) {
            logger.warn({ err, relationId }, "revert: relation delete failed");
            failures.push(`relation ${relationId}`);
          }
        }
        for (const entityId of plan.entityIds) {
          try {
            await entityCaller.delete({ id: entityId });
            deleted.entityIds!.push(entityId);
          } catch (err) {
            logger.warn({ err, entityId }, "revert: entity delete failed");
            failures.push(`entity ${entityId}`);
          }
        }
        for (const documentId of plan.documentIds) {
          try {
            await documentCaller.delete({ documentId });
            deleted.documentIds!.push(documentId);
          } catch (err) {
            logger.warn({ err, documentId }, "revert: document delete failed");
            failures.push(`document ${documentId}`);
          }
        }

        // If we mapped rows to undo but EVERY delete failed, treat the revert
        // as failed rather than flipping the proposal to reverted with no effect.
        const attempted =
          plan.entityIds.length +
          plan.relationIds.length +
          plan.documentIds.length;
        const succeeded =
          deleted.entityIds!.length +
          deleted.relationIds!.length +
          deleted.documentIds!.length;
        if (attempted > 0 && succeeded === 0) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: `Revert failed — could not undo: ${failures.join(", ")}`,
          });
        }
      }

      const revertedAt = new Date();
      const existingData =
        proposal.data && typeof proposal.data === "object"
          ? (proposal.data as StoredProposalData)
          : ({} as StoredProposalData);
      const revertedPayload: StoredProposalData = {
        ...existingData,
        revertedBy: userId,
        revertedAt: revertedAt.toISOString(),
        revertReason: input.reason,
      };

      // Flip status, but only from an applied state — guards the double-revert
      // race: two concurrent calls both pass the precheck, but the loser's
      // UPDATE matches 0 rows (status already moved off applied) and we treat
      // that as "already reverted" rather than reverting twice.
      //
      // `reopen` (Re-propose): return to PENDING instead of the terminal
      // REVERTED so the proposal can be re-accepted. The inverse was already
      // applied above (created rows soft-deleted); we KEEP the original payload
      // (`revertedPayload` retains `...existingData`, incl. `operations`) so a
      // re-accept re-materializes everything, and clear the review stamp so it
      // re-surfaces as actionable — while still recording revertedBy/revertedAt
      // in `data` for audit (which does NOT block re-acceptance).
      const flipped = await db
        .update(proposals)
        .set({
          status: input.reopen
            ? ProposalStatus.PENDING
            : ProposalStatus.REVERTED,
          data: revertedPayload,
          ...(input.reopen
            ? { reviewedBy: null, reviewedAt: null }
            : { reviewedBy: userId, reviewedAt: revertedAt }),
          updatedAt: revertedAt,
        })
        .where(
          and(
            eq(proposals.id, input.proposalId),
            inArray(proposals.status, [
              ProposalStatus.APPROVED,
              ProposalStatus.AUTO_APPROVED,
            ])
          )
        )
        .returning({ id: proposals.id });

      if (flipped.length === 0) {
        // A concurrent revert won; the rows are already undone. Report success
        // without double-auditing.
        return {
          success: true,
          reverted: deleted,
          alreadyReverted: true,
          ...(restoredEntityId ? { restoredEntityId } : {}),
        };
      }

      // Audit the undo: a record that this proposal was reverted, plus a
      // best-effort delete.completed / restore.completed for the target
      // subject for attribution.
      await auditLog({
        subjectType: "proposal",
        action: restoredEntityId ? "restore" : "delete",
        phase: "completed",
        subjectId: input.proposalId,
        userId,
        workspaceId: proposal.workspaceId ?? undefined,
        data: {
          reverted: true,
          sourceProposalId: input.proposalId,
          revertReason: input.reason,
          deletedEntityIds: deleted.entityIds,
          deletedRelationIds: deleted.relationIds,
          deletedDocumentIds: deleted.documentIds,
          ...(restoredEntityId ? { restoredEntityId } : {}),
          ...(unmerged
            ? {
                unmergeWinnerId: unmerged.winnerId,
                unmergeLoserId: unmerged.loserId,
              }
            : {}),
        },
        source: "api",
      });

      if (restoredEntityId) {
        emitSideEffects({
          subjectType: "entity",
          action: "restore",
          subjectId: restoredEntityId,
          userId,
          workspaceId: proposal.workspaceId ?? undefined,
          ...(unmerged
            ? {
                data: {
                  reason: "entity.unmerge",
                  winnerId: unmerged.winnerId,
                },
              }
            : {}),
        });
      }

      // Feedback signal — a human reverted an auto-approved capture, i.e.
      // rejected the whole AI decision behind it (not just one field). Only
      // capture-originated proposals carry a decision-scoped correlationId
      // worth scoring. Best-effort: never fail the revert over an audit hiccup.
      if (
        proposal.status === ProposalStatus.AUTO_APPROVED &&
        proposal.proposalType === "capture.graph" &&
        proposal.correlationId
      ) {
        await emitAiCorrection({
          action: "revert",
          userId,
          subjectId: input.proposalId,
          workspaceId: proposal.workspaceId ?? undefined,
          data: {
            kind: AI_KIND.CAPTURE,
            correlationId: proposal.correlationId,
          },
        });
      }

      // Re-propose: the proposal is back in the PENDING queue — re-surface it
      // the SAME way `reopen` (rejected → pending) does. `emitProposalReviewed`
      // for "reopened" is a realtime-only refresh (no approve/reject side
      // effects, no notification clear), moving the item back into the pending
      // queue on every client so it is actionable again.
      if (input.reopen) {
        emitProposalReviewed(
          input.proposalId,
          proposal.workspaceId,
          "reopened",
          userId
        );
      }

      return {
        success: true,
        reverted: deleted,
        ...(input.reopen ? { reopened: true } : {}),
        ...(restoredEntityId ? { restoredEntityId } : {}),
        ...(failures.length > 0 ? { partialFailures: failures } : {}),
      };
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

          // PENDING or APPROVAL_FAILED are the retryable states (both surface in
          // the actionable queue). A previously-failed approval can be retried in
          // a batch just like a single Retry; every terminal state is skipped.
          if (
            proposal.status !== ProposalStatus.PENDING &&
            proposal.status !== ProposalStatus.APPROVAL_FAILED
          ) {
            results.push({
              proposalId,
              success: false,
              error: `Already ${proposal.status}`,
            });
            continue;
          }

          // Ownership check — SAME computation as single `approve`; this door's
          // failure behavior (record the item + continue the batch) is unchanged.
          const { allowed: canApprove } = await computeCanReviewApproval({
            proposal,
            userId,
          });
          if (!canApprove) {
            results.push({
              proposalId,
              success: false,
              error: "Not authorized",
            });
            continue;
          }

          // ONE door — the SAME `applyProposalApproval` single approve runs.
          // This block used to inline only the generic `.validated`-emit tail
          // and never resolved an executor, so "Approve all" flipped the row
          // to APPROVED and silently did NOTHING for every proposal type the
          // materializer has no case for, and ran the wrong (generic) path for
          // the ones it does.
          //
          // SEQUENTIAL and per-item best-effort, deliberately: executors do
          // real writes (entity creates that dedup against each other, project
          // membership stamps, workspace provisioning), so items must settle in
          // the order the user selected them — the same order N single approves
          // would produce. Concurrency would buy nothing at max 50 items and
          // would make dedup/ordering races nondeterministic. A throw is caught
          // below: that item is reported failed (and was already flipped to
          // APPROVAL_FAILED + rejectionReason by the shared dispatch, exactly as
          // single approve does) while every remaining item is still attempted.
          // Idempotency is layered: the status guard above skips terminal rows,
          // and each executor keeps its own already-APPROVED short-circuit.
          const result = await applyProposalApproval({
            proposal,
            userId,
            input: {
              proposalId,
              ...(input.comment !== undefined
                ? { comment: input.comment }
                : {}),
            },
            ctx,
          });
          results.push({ proposalId, success: result.success });
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
        /** Structured rejection taxonomy — Phase 1 reasoned-rejection loop. */
        reasonCode: z.enum(PROPOSAL_REJECTION_REASONS).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);

      for (const proposalId of input.proposalIds) {
        // Authority — SAME ladder `approve`/`revert`/`reject` enforce, per
        // proposal. Without this a batch rejection was gated only by
        // `requireUserId` (any member could reject any proposal by id).
        const target = await db.query.proposals.findFirst({
          where: eq(proposals.id, proposalId),
          columns: {
            workspaceId: true,
            data: true,
            proposalType: true,
            correlationId: true,
          },
        });
        if (!target) continue;
        await assertCanReviewProposal({
          proposal: { workspaceId: target.workspaceId, data: target.data },
          userId,
          action: "reject",
        });

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

          // Feedback signal — same shape as `reject` (see the note there). Emit on
          // any reasoned rejection; correlationId falls back to the proposal id.
          if (input.reason || input.reasonCode) {
            await emitAiCorrection({
              action: "reject",
              userId,
              subjectId: proposalId,
              workspaceId: updated.workspaceId ?? undefined,
              data: {
                kind: AI_KIND.EXTRACT,
                correlationId: target.correlationId ?? proposalId,
                ...(input.reason ? { reason: input.reason } : {}),
                ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
              },
            });
          }
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
