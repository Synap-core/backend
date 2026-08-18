/**
 * Universal Proposals Router
 *
 * Handles listing, approving, and rejecting proposals for ALL entity types.
 * Replaces legacy document_proposals logic.
 *
 * Wave 5 router-decomposition (2026-08-12): the review-authority ladder,
 * display enrichment, change-diff builder, revert planner, and the
 * `applyProposalApproval` materialization orchestrator now live in
 * `./proposals/{review-authority,display,changes,revert,apply-approval}.ts`.
 * This file is the thin barrel: the `proposalsRouter` itself (every procedure,
 * verbatim) plus re-exports of everything an external importer needs.
 */

import { z } from "zod";
import { randomUUID } from "crypto";
import { router, protectedProcedure, workspaceProcedure } from "../trpc.js";
import type { Context } from "../context.js";
import { TRPCError } from "@trpc/server";
import {
  db,
  proposals,
  proposalClusterMutes,
  documents,
  eq,
  and,
  desc,
  inArray,
  isNull,
  isNotNull,
  lt,
  entities,
  channels,
  users,
  getWorkspaceMembership,
  unmergeEntities,
  type MergeMaterializedStamp,
} from "@synap/database";
import { ProposalStatus, workspaces } from "@synap/database/schema";
import type { WorkspaceSettings } from "@synap/database/schema";
import type {
  StoredProposalData,
  ProposalMaterializedRecord,
} from "@synap-core/types";
import {
  buildFallbackTitle,
  PROPOSAL_REJECTION_REASONS,
} from "@synap-core/types/proposals";
import { storage } from "@synap/storage";
import { mergeProposalRevision } from "../services/proposals/proposals-service.js";
import { scanApprovalPatterns } from "../services/proposals/approval-patterns.js";
import { assertProposalVisibleTo } from "../utils/proposal-visibility.js";
import { assertReviewedRevision } from "../utils/reviewed-revision.js";
import { requireUserId } from "../utils/user-scoped.js";
import { userVisibleWhere } from "../utils/user-visible-where.js";
import { auditLog } from "../utils/audit-log.js";
import { emitAiCorrection } from "../utils/ai-feedback-events.js";
import { AI_KIND } from "../lib/ai-events.js";
import { createEventBackedProposal } from "../utils/event-backed-proposal.js";
import { createLogger } from "@synap-core/core";
import { entitiesRouter as regularEntitiesRouter } from "./entities.js";
import { relationsRouter } from "./relations.js";
import { documentsRouter } from "./documents.js";
import { emitSideEffects } from "@synap/events";
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
} from "@synap/database";

import {
  canReviewProposal,
  formatReviewAuthorityReason,
  reviewAuthorityRequirement,
  computeCanReviewApproval,
  assertCanRetargetProposalDestination,
  assertCanReviewProposal,
  type ProposalApprovalPolicy,
  type ReviewAuthorityReason,
} from "./proposals/review-authority.js";
export { type ReviewAuthorityReason } from "./proposals/review-authority.js";
import {
  enrichProposalsForDisplay,
  displayNameForUser,
  findFlowNode,
} from "./proposals/display.js";
export { buildProposalChanges } from "./proposals/changes.js";
import { planProposalRevert } from "./proposals/revert.js";
export {
  planProposalRevert,
  type ProposalRevertPlan,
  type RevertPlannerInput,
} from "./proposals/revert.js";
import {
  applyProposalApproval,
  emitProposalReviewed,
  reportProposalOutcome,
} from "./proposals/apply-approval.js";
export {
  type GovernanceWidenLaneProposalData,
  type GovernanceTightenLaneProposalData,
} from "./proposals/apply-approval.js";

const logger = createLogger({ module: "proposals" });

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
        /**
         * Filter to proposals belonging to a PROJECT (`proposals.project_id`).
         *
         * A pure filter on an existing, indexed column
         * (`proposals_project_id_idx`) — the same column `activity.summary`
         * already groups by to produce per-project attention counts. It exists
         * so a project surface can show the REAL pending proposals rather than
         * only a number: a count tells you something is waiting, an object lets
         * you go and decide it.
         *
         * Adds no reach — every visibility predicate below still applies.
         */
        projectId: z.string().uuid().optional(),
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

      if (input.projectId) {
        conditions.push(eq(proposals.projectId, input.projectId));
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
   * `list`. Grouping defaults to the PENDING actionable queue (PENDING +
   * APPROVAL_FAILED), the same set `list`'s default `status: "pending"` returns.
   *
   * `status: "rejected"` is the same clustering over REJECTED rows instead —
   * the governance "rejection patterns" panel's read. That lens is always
   * agent-authored (mirrors how `agent-scorecard.ts`'s `allAgentsScorecard`
   * excludes humans via `isNotNull(agentUserId)`): a human's own rejected
   * drafts aren't a "pattern" an agent needs to learn from, so it is forced
   * regardless of the `agentOnly` input.
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
        /** Which queue to cluster: the actionable pending queue (default), or
         *  the terminal rejected queue for the rejection-patterns panel. */
        status: z.enum(["pending", "rejected"]).default("pending"),
        /** Max clusters returned (newest-active first). */
        limit: z.number().min(1).max(100).optional(),
        /** Max proposals scanned before grouping — guards a huge inbox. */
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
      if (input.status === "rejected") {
        conditions.push(eq(proposals.status, ProposalStatus.REJECTED));
        // Forced agent-only for the rejection-patterns lens — see the doc
        // comment above. Redundant (harmless) if `agentOnly` was already set.
        conditions.push(isNotNull(proposals.agentUserId));
      } else {
        // The actionable pending queue — identical membership to `list`'s
        // `status: "pending"` branch (PENDING keeps a user's Approve intent
        // visible even when execution later failed).
        conditions.push(
          inArray(proposals.status, [
            ProposalStatus.PENDING,
            ProposalStatus.APPROVAL_FAILED,
          ])
        );
      }
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
        agentUserId: r.agentUserId ?? null,
        sessionId: r.sessionId ?? null,
        automationId: r.stepRunId
          ? (automationByStepRun.get(r.stepRunId) ?? null)
          : null,
      }));

      let clusters = collapseProposalsToClusters(clusterRows);

      // Rejection-patterns lens only: drop clusters the pod has actively MUTED
      // ("Mark expected"). The mute is keyed on the SAME canonical fingerprint
      // these clusters carry, so a muted shape stops surfacing here. Pod-wide
      // (no workspace) — mirrors the rejected-clusters read's own pod-wide lens.
      if (input.status === "rejected") {
        const activeMutes = await db
          .select({ fingerprint: proposalClusterMutes.fingerprint })
          .from(proposalClusterMutes)
          .where(isNull(proposalClusterMutes.revokedAt));
        if (activeMutes.length > 0) {
          const muted = new Set(activeMutes.map((m) => m.fingerprint));
          clusters = clusters.filter((c) => !muted.has(c.fingerprint));
        }
      }

      const groups = clusters.slice(0, limit);
      return { groups };
    }),

  /**
   * Approval PATTERNS — "which event shape has repeatedly led to a proposal you
   * approved?". The read behind the Activity plane's patterns band, and the same
   * evidence a future promoter would cite before proposing a standing
   * automation.
   *
   * SIBLING OF, NOT A VARIANT OF, `groups`. Both aggregate proposals and both
   * reuse this file's user floor, but they answer different questions on
   * different keys and must not be merged: `groups` collapses the PENDING queue
   * by structural FINGERPRINT (object identity — "these are the same row, review
   * once"), while this keys on the ACTION MOTIF crossed with the triggering
   * EVENT ("this WHEN keeps leading to this WHAT"). `groups` has no event axis at
   * all; folding the two would force the fingerprint's object identity into a
   * question that is explicitly about shapes recurring ACROSS objects.
   *
   * Always returns its `funnel` alongside the patterns. An empty `patterns` list
   * is ambiguous on its own — `decidedTotal` vs `producedByAutomation` is what
   * tells a reader "nothing repeated often enough" from "almost nothing here was
   * produced by an automation at all", and today the honest answer is the second.
   * See the module doc-comment for why each floor is where it is.
   */
  approvalPatterns: protectedProcedure
    .input(
      z
        .object({
          /** Max decided proposals scanned before grouping. */
          scanLimit: z.number().min(1).max(2000).optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      return scanApprovalPatterns({ userId, scanLimit: input?.scanLimit });
    }),

  /**
   * Durably MUTE a rejection SHAPE-cluster ("Mark expected") — the persistent
   * form of the calibration inbox's previously session-only mute. `fingerprint`
   * is the SAME canonical value `groups({ status: 'rejected' })` returns, so a
   * mute matches a cluster exactly and stops it surfacing there.
   *
   * POD-SCOPED (no workspace) — a rejection shape is pod-wide, like the
   * duplicate-cluster recommender. Idempotent: re-muting an already-active
   * fingerprint is a no-op (ON CONFLICT DO NOTHING against the partial unique
   * index). Mirrors the governance-rules door style.
   */
  muteRejectionCluster: protectedProcedure
    .input(z.object({ fingerprint: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      await db
        .insert(proposalClusterMutes)
        .values({ fingerprint: input.fingerprint, createdBy: userId })
        // Already-active mute for this fingerprint → no-op (the partial unique
        // index `WHERE revoked_at IS NULL` is the conflict target).
        .onConflictDoNothing({
          target: proposalClusterMutes.fingerprint,
          where: isNull(proposalClusterMutes.revokedAt),
        });
      return { success: true };
    }),

  /**
   * Soft-UNMUTE a rejection cluster — revoke the active mute so the cluster
   * resurfaces in the rejected-clusters read. Stamps `revoked_at` (never
   * deletes), keeping the audit trail. No-op if nothing is actively muted.
   */
  unmuteRejectionCluster: protectedProcedure
    .input(z.object({ fingerprint: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      requireUserId(ctx.userId);
      await db
        .update(proposalClusterMutes)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(proposalClusterMutes.fingerprint, input.fingerprint),
            isNull(proposalClusterMutes.revokedAt)
          )
        );
      return { success: true };
    }),

  /**
   * List the pod's ACTIVE rejection-cluster mutes (pod-wide). Complements the
   * `groups({ status: 'rejected' })` filter — lets a surface show which shapes
   * are currently muted and offer an unmute.
   */
  listRejectionMutes: protectedProcedure.query(async ({ ctx }) => {
    requireUserId(ctx.userId);
    const rows = await db
      .select({
        fingerprint: proposalClusterMutes.fingerprint,
        createdBy: proposalClusterMutes.createdBy,
        createdAt: proposalClusterMutes.createdAt,
      })
      .from(proposalClusterMutes)
      .where(isNull(proposalClusterMutes.revokedAt))
      .orderBy(desc(proposalClusterMutes.createdAt));
    return { mutes: rows };
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
      // any proposal by id). Pod-wide (no workspace) proposals are gated TOO,
      // by approve's own owner / agent-owner / pod-admin predicate — they used
      // to short-circuit to an unconditional allow.
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
          // Structured cause (0232) persisted ALONGSIDE the free-text reason —
          // null when the caller omits it (back-compat).
          reasonCode: input.reasonCode ?? null,
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
      // workspace) proposals are gated TOO — reopen is the RESURRECTION
      // primitive, and it used to be an unconditional allow there, so any
      // authenticated pod user could resurrect a rejected pod-wide proposal.
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
            // `agentUserId` is a GATE INPUT, not telemetry: an agent-authored
            // proposal carries `data.sourceId` = the AGENT, so the human who
            // owns that agent is admitted only via the agent-owner rung, which
            // resolves `users.createdByUserId` FROM this column. The single
            // `reject`/`reopen` doors already select it; omitting it here made
            // batchReject silently strictly-stricter than reject — and once the
            // pod-wide branch became a real gate (it used to be an
            // unconditional allow), that gap would 403 an owner batch-rejecting
            // their OWN agent's pod-wide proposals.
            agentUserId: true,
            proposalType: true,
            correlationId: true,
          },
        });
        if (!target) continue;
        await assertCanReviewProposal({
          proposal: {
            workspaceId: target.workspaceId,
            data: target.data,
            agentUserId: target.agentUserId,
          },
          userId,
          action: "reject",
        });

        const [updated] = await db
          .update(proposals)
          .set({
            status: ProposalStatus.REJECTED,
            rejectionReason: input.reason,
            // Structured cause (0232) — MUST mirror the single `reject` door.
            // This input already accepted `reasonCode` and already emitted it on
            // the flywheel event, but never wrote the COLUMN: a reviewer who
            // rejects 12 proposals in one batch produced correct telemetry and 12
            // NULL `reason_code` rows, so every reader of the durable column (the
            // scorecard histogram, any reason-keyed tightening) silently
            // under-counted — invisibly, because the event path looked right.
            reasonCode: input.reasonCode ?? null,
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
