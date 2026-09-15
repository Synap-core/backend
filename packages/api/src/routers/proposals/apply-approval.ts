/**
 * `applyProposalApproval` — the ONE door both `approve` and `batchApprove` go
 * through to MATERIALIZE an approved proposal, plus its fire-and-forget review
 * side-effect helpers (notification-actioned, project-membership stamp,
 * realtime "reviewed" broadcast, IS telemetry). Extracted verbatim from
 * proposals.ts (Wave 5 router-decomposition). Preserves the
 * `assertPodAdmin` governance floor gating every `governance.*` proposal
 * before the privileged `governance_rules` insert (see the comment inline).
 */

import { randomUUID } from "crypto";
import { TRPCError } from "@trpc/server";
import {
  db,
  eq,
  and,
  ne,
  isNull,
  channels,
  getWorkspaceMembership,
  storedVersionValues,
  uploadDocumentVersionSnapshot,
  links,
  type LinkEndpointType,
  type LinkType,
  linkEntityToProject,
  resolveProjectPlacement,
  setChannelBranchPurpose,
  ChannelFirewallImmutableError,
  ProfileResolutionService,
  governanceRules,
  governanceCeilings,
  createGuideline,
  type GovernanceScope,
  type GovernanceTarget,
} from "@synap/database";
import { proposals } from "@synap/database/schema";
import { markProposalNotificationsActioned } from "../../notifications/mark-proposal-notifications-actioned.js";
import type { PropertyDecisionMap } from "@synap/database";
import { isPodWideConnectionSyncApproval } from "@synap/database";
import { storedSessionSource } from "@synap/database";
import type { StoredProposalData } from "@synap-core/types";
import {
  isDocumentContentProposalData,
  isCompositeProposalData,
  isPlanBatch,
  normalizeProposalSource,
  isRequestShapedProposalData,
} from "@synap-core/types/proposals";
import type {
  CompositeProposalOperation,
  CompositeCreateEntityOp,
} from "@synap-core/types/proposals";
import {
  dispatchProposalApproval,
  type ProposalExecutorDeps,
  type ProposalExecutorResult,
} from "./execution-registry.js";
import { registerApproveExecutors } from "./approve-executors.js";
import {
  applyGovConfigChange,
  type SettingsUpdateProposalData,
} from "../../services/proposals/gov-config.js";
import {
  assertDocumentBaseVersion,
  readProposalBaseVersion,
} from "../../utils/document-base-version.js";
import {
  applyGraphDispositions,
  survivingEntityDecisionSlices,
  survivingEntityFacetSlices,
  foldFacetsIntoOps,
  type GraphDispositionMap,
  type FacetSpec,
} from "./graph-dispositions.js";
import { ProposalStatus } from "@synap/database/schema";
import { assertPodAdmin } from "../../trpc.js";
import type { Context } from "../../context.js";
import { emitAiCorrection } from "../../utils/ai-feedback-events.js";
import { AI_KIND } from "../../lib/ai-events.js";
import {
  CompositePlanApplyError,
  materializeCompositeGraph,
} from "../../utils/materialize-composite.js";
import { buildPlanCallers } from "../../utils/plan-callers.js";
import { approvalIdempotency } from "../../services/proposals/approval-idempotency.js";
import {
  buildMaterializedRecord,
  stampMaterialized,
} from "../../services/proposals/stamp-materialized.js";
import {
  attachSourceBlob,
  discardProposalSourceBlob,
  stagedSourceBlobFrom,
} from "../../utils/store-entity-source-blob.js";
import { buildRuleLoopCallers } from "../../utils/rule-loop-callers.js";
import { reconcileApprovedProperties } from "../../services/proposals/reconcile-proposal-properties.js";
import { completeKnowledgeProposalProperties } from "../../services/proposals/complete-knowledge-proposal.js";
import {
  approveStructureGuidelineProposal,
  assertCanApproveStructureGuideline,
  governanceApprovalFloorFor,
} from "../../services/guidelines/guideline-versions.js";
import { createLogger } from "@synap-core/core";
import { nonWidenableFloorFor } from "@synap/governance-policy";
import { entitiesRouter as regularEntitiesRouter } from "../entities.js";
import { relationsRouter } from "../relations.js";
import { emitChatEvent } from "../../utils/chat-realtime-broadcast.js";
import { SERVER_CONVERSATION_EVENTS } from "../../realtime/socket-events.js";
import {
  emitSideEffects,
  enqueueConnectionSyncApproval,
  getBoss,
} from "@synap/events";
import { messages } from "@synap/database/schema";
import { getDefaultActiveService } from "../../utils/intelligence-routing.js";
import {
  satisfyExpectedOutputs,
  readProposalEntityProfileSlug,
  readProposalExpectedLabel,
} from "../../services/focus-sessions/satisfy-expected-output.js";

const logger = createLogger({ module: "proposals" });

// Register every approve executor against the proposal-execution registry.
// Idempotent — the dispatch table `dispatchProposalApproval` below resolves
// against. Runs once, from this module (imported unconditionally by every
// path into `applyProposalApproval`).
registerApproveExecutors();

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
    /** Carries the persisted `sessionSource` marker (A1). */
    data?: unknown;
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
    sessionSource: storedSessionSource(proposal.data),
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
export function emitProposalReviewed(
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
    markProposalNotificationsActioned([proposalId]);
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
  markProposalNotificationsActioned([proposalId]);
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
export function reportProposalOutcome(params: {
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

/**
 * `governance.tighten_lane` proposal payload — the TIGHTEN mirror of
 * `GovernanceWidenLaneProposalData`. Emitted ONLY by the tighten recommender
 * (`services/proposals/recommend-tighten.ts`); approval here is the ONE door
 * that turns it into a `governance_rules` row. `verdict` is always "propose": a
 * tighten proposal only ever pins a motif to review, never widens (floor-safe by
 * construction — rung 2.8 sits below every floor). `evidence` differs from widen
 * (per-shape reject signal, not per-agent scorecard) and is not read here.
 */
export interface GovernanceTightenLaneProposalData {
  agentUserId: string;
  targetKind: GovernanceTarget;
  targetPattern: string;
  targetProfile?: string | null;
  scopeKind: GovernanceScope;
  workspaceId?: string | null;
  verdict: "propose";
  evidence: {
    clusterSize: number;
    rejectRate: number;
    totalForShape: number;
    sampleProposalIds: string[];
  };
}

/**
 * `governance.advisory` proposal payload — the MECHANICAL-fault sibling of
 * `GovernanceTightenLaneProposalData`. Emitted ONLY by the tighten recommender
 * (`services/proposals/recommend-tighten.ts`) when a motif's DOMINANT rejection
 * reason says the agent produced a MALFORMED write (duplicate / wrong
 * kind-or-facet / wrong link type) rather than an unwanted one.
 *
 * Approving it writes NOTHING — it is a pure acknowledgement. A `propose` rule
 * cannot deduplicate or repair a malformed payload; the remedy lives in code (an
 * existence check, a tool schema, a description). The proposal exists so a HUMAN
 * SEES the finding on the same review surface as every other governance item —
 * an event nobody reads is not a finding.
 *
 * Note the DELIBERATE absence of a `verdict` field: a distinct type with no
 * verdict can never be misread as rule-writing, whereas a `tighten_lane` payload
 * carrying an `advisory:true` flag would be turned into a `governance_rules` row
 * by the B4b branch above, which keys on `proposalType` alone.
 */
export interface GovernanceAdvisoryProposalData {
  agentUserId: string;
  targetKind: GovernanceTarget;
  targetPattern: string;
  scopeKind: GovernanceScope;
  advisoryKind: "mechanical_fault";
  suggestedRemedy: string;
  evidence: {
    clusterSize: number;
    rejectRate: number;
    totalForShape: number;
    sampleProposalIds: string[];
    dominantReason: string;
    reasonHistogram: Record<string, number>;
    faultClass: "mechanical" | "judgment";
  };
}

/**
 * `governance.raise_ceiling` proposal payload — the numeric-limit twin of
 * `GovernanceTightenLaneProposalData`. Emitted ONLY by the raise-ceiling
 * recommender (`services/proposals/recommend-raise-ceiling.ts`); approval here is
 * the ONE door that turns it into a `governance_ceilings` row. Always pod-scoped
 * (the daily-write ceiling is a per-agent pod-wide budget). Floor-safe: a ceiling
 * can only downgrade execute→propose at rung 2.56, so raising one can never widen
 * a delete/admin/scope-change.
 */
export interface GovernanceRaiseCeilingProposalData {
  agentUserId: string;
  scopeKind: "pod";
  workspaceId?: string | null;
  /**
   * Which ceiling axis this proposal raises. Defaults to `daily_write_count`
   * (the recommender's own axis). `pending_proposal_cap` raises the F2
   * proposal cap instead — the axis `resolvePendingProposalCap` reads.
   */
  axis?: "daily_write_count" | "pending_proposal_cap";
  currentLimit: number;
  proposedLimit: number;
  evidence: {
    daysAtCeiling: number;
    sampleDays: Array<{ day: string; count: number }>;
  };
}

/**
 * `governance.tighten_posture` proposal payload — the channel-scoped twin of
 * `GovernanceTightenLaneProposalData`. Emitted ONLY by the tighten-posture
 * recommender (`services/proposals/recommend-tighten-posture.ts`); approval here
 * is the ONE door that turns it into a `config_settings` guideline
 * (posture:'propose', scopeKind:'channel'). Posture is channel-scoped +
 * agent-independent — the one structural divergence from tighten_lane. Floor-safe
 * by construction: a posture only tightens origin trust at rung 2.55.
 */
export interface GovernanceTightenPostureProposalData {
  channelId: string;
  workspaceId?: string | null;
  rejectRate: number;
  clusterSize: number;
  sampleProposalIds: string[];
}

/**
 * `governance.work_guideline` proposal payload — emitted ONLY by the
 * blocked-slot recurrence scanner
 * (`packages/jobs/src/workers/blocked-slot-recurrence-scanner.ts`, which keeps
 * the authoritative copy of this interface; jobs cannot import api, so the two
 * are hand-mirrored exactly as `GovernanceWidenLaneProposalData` is).
 *
 * Approval here is the ONE door that turns it into a `config_settings`
 * guideline at `scopeKind:'workKind'`.
 *
 * IT CARRIES NO `posture`, AND MUST NOT. `resolveMostSpecificPosture` (rung
 * 2.55) reads only `posture`, so a text-only guideline cannot move an origin
 * between trusted and untrusted. That is what keeps this producer outside the
 * governance trust decision: it writes standing INTENT for the interpret pass,
 * never a trust verdict. Adding a posture here would make an automatically
 * proposed row able to flip trust, which is a different and much larger
 * decision than the one this wave made.
 */
export interface GovernanceWorkGuidelineProposalData {
  userId: string;
  blockedReason: string;
  text: string;
  workspaceId?: string | null;
  evidence?: {
    occurrences: number;
    sessions: number;
    signature: string;
    windowDays: number;
    sampleSessionIds: string[];
  };
}

export async function applyProposalApproval(args: {
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
  const result = await applyProposalApprovalInner(args);

  // HONEST DELIVERABLE SIGNAL. A session-scoped proposal that actually applied
  // is the one thing about a session's expected outputs a human really vouched
  // for — so the stamp hangs off approval, never off the agent's own say-so.
  // Deliberately AFTER the inner call and outside its control flow: the inner
  // door returns from ~20 branches, and a provenance stamp must not be able to
  // fail an approval that already succeeded (hence the swallow + log).
  if (args.proposal.sessionId) {
    try {
      await satisfyExpectedOutputs({
        sessionId: args.proposal.sessionId,
        targetType: args.proposal.targetType,
        proposalId: args.proposal.id,
        // The SLOT CLAIM the proposal carried (`data.expectedLabel`, written by
        // `checkPermissionOrPropose`). Without it a session owing two documents
        // stamps the FIRST one whatever this draft was actually for.
        expectedLabel: readProposalExpectedLabel(args.proposal.data),
        // The PROFILE of the entity this approval produced. `targetType` can
        // only say `entity`, while a slot is declared `knowledge` / `task` —
        // without it a `kind: "knowledge"` slot satisfied by a PROPOSED capture
        // stayed pending forever. Same field the auto-approve half forwards.
        entityProfileSlug: readProposalEntityProfileSlug(args.proposal.data),
      });
    } catch (err) {
      logger.warn(
        { err, proposalId: args.proposal.id },
        "expected-output stamp failed after a successful approval"
      );
    }
  }

  return result;
}

async function applyProposalApprovalInner(
  args: Parameters<typeof applyProposalApproval>[0]
): Promise<ProposalExecutorResult> {
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
      // The proposal being applied. `entities.create` stamps it onto
      // `events.proposal_id` so every entity this approval materializes names
      // its authorizer on the event spine — the same linkage the single-entity
      // door gets from its own auto-approve receipt, and what the object graph's
      // `via: "governed"` fold reads.
      governanceProposalId: string;
      // DELEGATION, not impersonation (RFC 8693): the AGENT that authored this
      // proposal remains the ACTOR of every row the approval materializes; the
      // approving human is the AUTHORIZER, and lands on `createdByUserId` +
      // `proposals.reviewedBy`. Without this the sync approve path stamped
      // `createdByKind: 'human'` / `agent_user_id: NULL` on entities an agent
      // wrote — while the ASYNC materializer path (jobs/workers/materializer.ts
      // :398/:435/:528, same envelope) stamped `ai_agent`. Provenance forked on
      // governance state, which is exactly what a governance system must not do.
      // `Context.agentUserId` already exists (types/context.ts:95) and
      // `entities.create` already reads it — this only stops dropping it.
      agentUserId: string | null;
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
        governanceProposalId: proposal.id,
        agentUserId: proposal.agentUserId ?? null,
      };
    } else {
      compositeCtx = {
        db,
        authenticated: true as const,
        userId,
        workspaceId: null,
        workspaceRole: "owner",
        sessionId: proposal.sessionId ?? null,
        governanceProposalId: proposal.id,
        agentUserId: proposal.agentUserId ?? null,
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
    // A connected PLAN applies whole (founder D3). A per-item reject would
    // leave a session pointing at a dropped project, a blocker at a dropped
    // session — so a plan takes no dispositions: ask for the plan to be
    // REVISED instead (the pending plan is revisable, and every revision is
    // re-validated), then approve the whole.
    const isPlanApproval = isPlanBatch(payload.operations);
    if (
      isPlanApproval &&
      dispositions &&
      Object.values(dispositions).some((d) => d.status !== "accept")
    ) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          "This proposal is a connected plan: it applies as a whole, so individual steps cannot be rejected or edited at approval. Ask for the plan to be revised (it stays pending and is re-validated), then approve it.",
      });
    }
    const operationsToMaterialize =
      !isPlanApproval && dispositions && Object.keys(dispositions).length > 0
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
        const props = completeKnowledgeProposalProperties({
          profileSlug: entityOp.profileSlug,
          properties: entityOp.properties,
          title: entityOp.title,
          description: entityOp.description,
          content: entityOp.content,
        });
        if (!props || Object.keys(props).length === 0) {
          rebuilt.push({ ...entityOp, properties: props });
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
          // A profile that did not resolve is NOT an id: pass null so the reconcile
          // service refuses def creation and stores verbatim (a slug in `profileId`
          // only failed later, by a uuid cast error).
          profileId: profile?.id ?? null,
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
    let materializeResult: Awaited<
      ReturnType<typeof materializeCompositeGraph>
    >;
    try {
      materializeResult = await materializeCompositeGraph(
        reconciledOperations,
        entityCaller,
        relationCaller,
        (err, type) =>
          logger.warn(
            { err, type },
            "composite proposal: relation create failed (entities kept)"
          ),
        // Per-op homes (targetWorkspaceId) pin process kinds only — stamped at
        // import/capture submit via stampScopeAwareHomesOnOps. Do NOT blanket
        // workspaceScoped: that re-pinned pod identity into the proposal home.
        // `entityCaller` doubles as facetCaller for op.facets after materialize.
        {
          facetCaller: entityCaller,
          // ── Connected-plan callers ──────────────────────────────────────
          // Sessions belong to — and every session edge floors on — the
          // principal the proposal was filed FOR (`subjectUserId`), never an
          // approving admin (see utils/plan-callers.ts). Projects and documents
          // are written as the approver, like their single-object executors.
          planCallers: buildPlanCallers({
            database: db,
            userId,
            sessionOwnerUserId: proposal.subjectUserId ?? userId,
            workspaceId: compositeCtx.workspaceId,
            workspaceRole: compositeCtx.workspaceRole,
            entityCaller,
            proposal: {
              id: proposal.id,
              sessionId: proposal.sessionId ?? null,
            },
          }),
          // ── Rule Loop callers (NS1) ─────────────────────────────────────
          // ONE factory (utils/rule-loop-callers.ts) — every materialize call
          // site wires the same three canonical doors, re-run as the APPROVER.
          // Was inline here and NOWHERE else, which is how four other call sites
          // ended up silently dropping config ops.
          ...buildRuleLoopCallers({
            database: db,
            userId,
            workspaceId: compositeCtx.workspaceId,
            auditSource: "rule_loop_approval",
          }),
          // Per-op link idempotency keyed by THIS proposal (client-stable): a
          // retried or double-clicked approval links what the first attempt
          // created instead of duplicating it — and `import.apply`, now routed
          // through this door (intake D7), keeps the retry safety it had.
          idempotency: approvalIdempotency(db, { userId, proposal }),
          // Graph submitters persist their origin in proposal data. Reuse it
          // on approval so source attribution survives the proposal boundary.
          // `data.source` carries TWO vocabularies under one name: a graph
          // submitter's ACTOR provenance (`agent`, `cli`, …) and an import's
          // FORMAT (`markdown`, `connector_sync`). Only a provenance value may
          // reach the entity door — anything else normalizes to `user` (the
          // human who filed / approves it; the agent stays attributed through
          // `compositeCtx.agentUserId`).
          ...(typeof payload.source === "string"
            ? { source: normalizeProposalSource(payload.source) }
            : {}),
        }
      );
    } catch (err) {
      if (!(err instanceof CompositePlanApplyError)) throw err;
      // ALL-OR-NONE failed: every step that had applied was compensated. The
      // proposal is recorded APPROVAL_FAILED (the actionable queue — a retry is
      // allowed) with the per-step reasons and what compensation did, so the
      // reviewer and the agent revising the plan can both see WHY.
      await db
        .update(proposals)
        .set({
          status: ProposalStatus.APPROVAL_FAILED,
          rejectionReason: err.message,
          data: {
            ...((proposal.data as Record<string, unknown> | null) ?? {}),
            planFailure: {
              at: new Date().toISOString(),
              by: userId,
              steps: err.steps,
              compensation: err.compensation,
            },
          } as never,
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(proposals.id, proposal.id),
            ne(proposals.status, ProposalStatus.APPROVED)
          )
        );
      throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
    }
    const {
      created: createdCount,
      linked,
      primaryId,
      entities: createdEntities,
      refToRealId,
      relationsFailed,
    } = materializeResult;

    // A proposed capture that carried a file: the bytes were STAGED at propose
    // time (`stageSourceBlob`), only the reference rode in `data.sourceFile`.
    // Now that the entities exist, bind it to the same entity the direct-write
    // path would have chosen — the first freshly CREATED one (never a
    // pre-existing linked entity, which is someone else's document), falling
    // back to the materializer's `primaryId`. Best-effort: the entities are
    // already committed, and losing the attach must not fail the approval.
    const stagedCaptureFile = stagedSourceBlobFrom(payload);
    if (stagedCaptureFile) {
      const fileTargetId =
        createdEntities.find((e) => !e.linked)?.entityId ??
        primaryId ??
        undefined;
      if (fileTargetId) {
        try {
          await attachSourceBlob({
            database: db,
            userId,
            entityId: fileTargetId,
            staged: stagedCaptureFile,
          });
        } catch (err) {
          logger.warn(
            { err, proposalId: input.proposalId, entityId: fileTargetId },
            "composite proposal: source blob attach failed (entities kept)"
          );
        }
      } else {
        // APPROVED with nothing to attach to — every create op was rejected in
        // a partial approval, so `createdEntities` is empty and `primaryId` is
        // unset. The proposal is now terminal on the APPROVE side: no reject
        // will ever run, so "left for reject/cleanup" was a cleanup that could
        // not happen and the bytes orphaned permanently. Discard here.
        logger.warn(
          { proposalId: input.proposalId },
          "composite proposal: no materialized entity to attach the staged source blob to — discarding it (approved, so no reject will follow)"
        );
        // Same door + same refusal semantics every terminal proposal state
        // uses (it logs an ownership refusal loudly and deletes nothing); the
        // approval itself is already committed, so it must not fail on cleanup.
        await discardProposalSourceBlob({
          database: db,
          userId,
          proposalData: payload,
        });
      }
    }

    // Record what we materialized so `revert` can compute the inverse — the
    // COMPLETE record (created entities, relations, facets, config rows, and
    // what a merge overwrote on a pre-existing entity), from the one builder
    // every materializer uses. Pre-existing linked entities are never ours to
    // delete; only their overwritten properties are recorded.
    //
    // Relations are recorded by id because nothing else removes them: entity
    // delete is a SOFT delete (`deletedAt`), it does not cascade, so reverting
    // the entities alone left every relation touching them in place.
    //
    // `data.materialized` reflects ONLY the applied ops (rejected ops never
    // materialize, so they never appear) — `revert`'s planner reads exactly
    // this. The disposition map is persisted alongside (below) so the
    // partial-apply decision is durable (drives the review UI's post-approve
    // state + the item-scoped flywheel).
    const compositeMaterialized = buildMaterializedRecord(materializeResult);

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
        await import("../../services/connectors/inbound-recorder.js");
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

    // One statement: the status flip and the merged record land together.
    await stampMaterialized({
      proposalId: input.proposalId,
      record: compositeMaterialized,
      baseData: payload as unknown as Record<string, unknown>,
      ...(dispositions && Object.keys(dispositions).length > 0
        ? { dataPatch: { dispositions } }
        : {}),
      set: {
        status: ProposalStatus.APPROVED,
        reviewedBy: userId,
        reviewedAt: new Date(),
        updatedAt: new Date(),
      },
    });

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

    // A POD-WIDE connection-sync import still earns its
    // connection's auto rule. `emitProposalReviewed` fans out side effects only
    // for a workspace-scoped proposal (where the connection-sync-approval reactor
    // enqueues the job), so the workspace-less case enqueues the SAME job here.
    // Narrow on purpose: widening the emit to every pod-wide approval would newly
    // fire webhook delivery and other reactors. Awaited so a queue failure fails
    // loudly; the job retries and the rule mint behind it is idempotent.
    if (isPodWideConnectionSyncApproval(proposal)) {
      await enqueueConnectionSyncApproval({
        proposalId: input.proposalId,
        userId,
      });
    }

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

    return {
      success: true,
      primaryId,
      created: createdCount,
      linked,
      // Edges that did not land. Taken off the materializer's result and handed
      // to the caller — dropping it here is what made an approval whose every
      // edge failed read as a clean success.
      ...(relationsFailed.length > 0 ? { relationsFailed } : {}),
    };
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

    // BASE VERSION: refuse (CONFLICT, nothing written, proposal stays pending)
    // when the document moved past the version this edit was drafted against —
    // otherwise a person's save made after the proposal was filed is silently
    // overwritten. A proposal filed before base versions were recorded carries
    // none and applies as before.
    const baseVersion = readProposalBaseVersion(payload);
    if (baseVersion !== undefined) {
      assertDocumentBaseVersion(baseVersion, document.currentVersion);
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

    // EVIDENCE (storage engine): both statements RETURN their rows. `rows` is
    // what the two write statements themselves reported — not "we reached the
    // end of the branch". If the document row vanished between the read above
    // and this update, `updatedDocs` is empty and the receipt says so.
    const insertedVersions = await db
      .insert(documentVersions)
      .values({
        id: versionId,
        documentId: proposal.targetId,
        version: newVersion,
        ...storedVersionValues(snapshot),
        // PROVENANCE: the agent DRAFTED this text, the human ACCEPTED it. Two
        // different people, and the version row must be able to say so —
        // stamping the accepting human as author erases the agent from the
        // rail and makes the checkpoint a lie about who wrote the words.
        //
        // The row records the AUTHOR only. `document_versions` has no metadata
        // column and no acceptor column, so the accepting human is NOT on this
        // row: the acceptance actor lives on the proposal (`reviewedBy`), which
        // is the row that decision belongs to. A uuid stuffed into `message`
        // would surface verbatim in the version rail.
        ...(proposal.agentUserId
          ? {
              author: "ai" as const,
              authorId: proposal.agentUserId,
              message: "AI edit accepted",
            }
          : {
              author: "user" as const,
              authorId: userId,
              message: "Edit accepted",
            }),
      })
      .returning({ id: documentVersions.id });

    const updatedDocs = await db
      .update(documents)
      .set({
        currentVersion: newVersion,
        lastSavedVersion: newVersion,
        updatedAt: new Date(),
      })
      .where(eq(documents.id, proposal.targetId))
      .returning({ id: documents.id });

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
    return {
      success: true,
      effect: {
        applied: "verified",
        rows: insertedVersions.length + updatedDocs.length,
        ids: insertedVersions.map((r) => r.id),
        subject: "document_versions+documents",
      },
    };
  }

  // POD-ADMIN FLOOR for every `governance.*` meta-proposal.
  //
  // Approving one of these INSERTS A `governance_rules` ROW — the same privileged
  // write that `governanceRules.create` gates behind `assertPodAdmin` for
  // `scopeKind:'pod'`. But governance meta-proposals are ALWAYS pod-wide
  // (`workspaceId: null`), and both review-authority helpers short-circuit
  // `if (!proposal.workspaceId) => allowed` — so without this floor the SAME row
  // is pod-admin-only through one door and open to every authenticated pod user
  // through the other. A workspace editor could approve a pending
  // `governance.widen_lane` and widen an agent they don't own, pod-wide.
  //
  // Gated HERE, at the privileged operation, rather than in the route helpers:
  // one chokepoint that every caller (approve, batchApprove, and any future
  // door) must pass, and it covers governance types added later by prefix.
  //
  // ONE NARROW EXCEPTION — `governance.structure_guideline` (founder D1: whoever
  // the guideline applies to decides). It writes guideline TEXT for one owner's
  // or one workspace's extraction, never a governance rule or a posture, so it
  // is gated by that audience instead: the subject (pod-wide) or a workspace
  // editor/admin (workspace-scoped), pod admins always. Exact type match — no
  // other `governance.*` type is widened.
  const governanceFloor = governanceApprovalFloorFor(proposal.proposalType);
  if (governanceFloor === "guideline-audience") {
    await assertCanApproveStructureGuideline({
      userId,
      subjectUserId: proposal.subjectUserId ?? null,
      workspaceId: proposal.workspaceId ?? null,
    });
  } else if (governanceFloor === "pod-admin") {
    await assertPodAdmin(userId);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // @deprecated — LEGACY `governance.*` executors (B4a–B4g). SUPERSEDED by the
  // unified `settings.update` door (B5 below), which routes through the ONE
  // store-write `applyGovConfigChange` (`services/proposals/gov-config.ts`).
  //
  // Kept ONLY to apply proposals of these types that were already PENDING when
  // the unified door shipped. Their recommenders now file `settings.update`.
  // DELETE these branches (and their `Governance*ProposalData` types above)
  // once no PENDING proposals of these types remain — see the engineering-memory
  // record "gov-config executors B4a–B4g deprecated 2026-09-15".
  // ═══════════════════════════════════════════════════════════════════════

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

    // A rule that can never fire is refused, not stored — the SAME check and
    // message as `governanceRules.create` (B3). An exact action key behind a
    // non-widenable floor resolves above the rule store, so approving would
    // store an "auto" grant that does nothing. Nothing is written; the proposal
    // stays pending for a person to reject.
    if (widenData.targetKind === "action") {
      const floor = nonWidenableFloorFor(widenData.targetPattern);
      if (floor) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `NON_WIDENABLE_FLOOR (${floor}): "${widenData.targetPattern}" always needs review — no governance rule can auto-approve it.`,
        });
      }
    }

    // EVIDENCE (storage engine): the INSERT's own RETURNING row is the receipt
    // that the rule row exists. Nothing here is inferred from reaching this line.
    const insertedWidenRules = await db
      .insert(governanceRules)
      .values({
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
      })
      .returning({ id: governanceRules.id });

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
    return {
      success: true,
      effect: {
        applied: "verified",
        rows: insertedWidenRules.length,
        ids: insertedWidenRules.map((r) => r.id),
        subject: "governance_rules",
      },
    };
  }

  // B4b: governance.tighten_lane — the TIGHTEN mirror of B4. Approving inserts
  // ONE governance_rules row with `verdict:'propose'` (vs widen's 'auto') +
  // source_proposal_id lineage — an EXACT mirror of the widen branch above,
  // differing only in the verdict. Floor-safe by construction: a rule resolves
  // at rung 2.8, BELOW every floor, so a propose rule can only pin-to-review,
  // never widen a delete/admin/scope-change. Keyed off proposalType (not payload
  // shape), inline like widen — the recommender that emits this type never
  // writes governance_rules directly.
  if (proposal.proposalType === "governance.tighten_lane") {
    const tightenData = payload as GovernanceTightenLaneProposalData | null;
    if (
      !tightenData ||
      typeof tightenData !== "object" ||
      !tightenData.agentUserId ||
      !tightenData.targetKind ||
      !tightenData.targetPattern ||
      !tightenData.scopeKind
    ) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Malformed governance.tighten_lane proposal data.",
      });
    }

    // EVIDENCE (storage engine): same as widen — the INSERT's RETURNING row.
    const insertedTightenRules = await db
      .insert(governanceRules)
      .values({
        principalKind: "agent",
        agentUserId: tightenData.agentUserId,
        scopeKind: tightenData.scopeKind,
        workspaceId:
          tightenData.scopeKind === "workspace"
            ? (tightenData.workspaceId ?? null)
            : null,
        targetKind: tightenData.targetKind,
        targetPattern: tightenData.targetPattern,
        targetProfile: tightenData.targetProfile ?? null,
        verdict: "propose",
        sourceProposalId: proposal.id,
        createdBy: userId,
      })
      .returning({ id: governanceRules.id });

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
    return {
      success: true,
      effect: {
        applied: "verified",
        rows: insertedTightenRules.length,
        ids: insertedTightenRules.map((r) => r.id),
        subject: "governance_rules",
      },
    };
  }

  // B4b': governance.advisory — the NO-OP sibling of B4b. Approving an advisory
  // ACKNOWLEDGES a finding and writes NOTHING: no governance_rules row, no
  // ceiling, no config_setting. The finding says "this agent keeps producing a
  // MALFORMED write" (duplicate / wrong kind-or-facet / wrong link type), and a
  // `propose` rule is the wrong remedy for that — those writes are already
  // pending review; the fix is code (existence check / tool schema). Explicit
  // branch, not a fall-through: without it an advisory would drop into the
  // execution registry's catch-all and emit a generic `.validated` for a
  // proposal that has nothing to materialize.
  if (proposal.proposalType === "governance.advisory") {
    const advisoryData = payload as GovernanceAdvisoryProposalData | null;
    if (
      !advisoryData ||
      typeof advisoryData !== "object" ||
      !advisoryData.agentUserId ||
      !advisoryData.targetPattern
    ) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Malformed governance.advisory proposal data.",
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
    // NO STORAGE WRITE EXISTS ON THIS BRANCH — and that is the correct
    // outcome, not a severed door (see the branch comment above: an advisory
    // ACKNOWLEDGES a malformed-write finding; a rule is the wrong remedy). So
    // the receipt is `applied: "none"` WITH the reason, which maps to the
    // transport state `no_effect` via `receiptStateForEffect`. The only rows
    // this branch touches are the proposal's own status/reviewedAt columns,
    // which are bookkeeping about the review, never the reviewed change.
    return {
      success: true,
      effect: {
        applied: "none",
        reason:
          "governance.advisory is acknowledgement-only by design: it writes no " +
          "governance_rules row, no ceiling and no config_setting. The finding " +
          "reports a malformed agent write, whose remedy is code (existence " +
          "check / tool schema), not a policy row.",
      },
    };
  }

  // B4b'': automation.health_advisory — the automation-health WARDEN's finding,
  // and the second acknowledgement-only branch, modelled on B4b' above.
  //
  // Approving it writes NOTHING: no automation row is paused, archived or
  // touched. That is deliberate, not an unfinished door. The finding is "this
  // automation is enabled and has NEVER run", and the overwhelmingly common
  // cause is that NOTHING PRODUCES ITS TRIGGER — a `.requested` rule where only
  // `.completed` is emitted downstream, a cron whose queue was never registered,
  // a webhook nobody wired. Pausing the listener is the wrong remedy for a
  // missing producer, and an approval that silently disabled a user's
  // automations would be a destructive write filed by a scanner. The warden
  // proposes; the human disposes, in the automation itself.
  //
  // Per-item dispositions still work through the generic `proposals.rejectItem`
  // door (items are keyed by `zeroRunItemRef(automationId)`), so a reviewer can
  // dismiss individual findings — and the warden's re-nag guard reads the SAME
  // `data.findings[]` array, so it will not re-file what was decided here for
  // RENAG_COOLDOWN_DAYS.
  //
  // Explicit branch, not a fall-through: without it this would drop into the
  // execution registry's catch-all and emit a generic `.validated` for a
  // proposal that has nothing to materialize.
  if (proposal.proposalType === "automation.health_advisory") {
    const wardenData = payload as {
      ownerUserId?: string;
      findings?: unknown[];
    } | null;
    if (
      !wardenData ||
      typeof wardenData !== "object" ||
      !wardenData.ownerUserId ||
      !Array.isArray(wardenData.findings)
    ) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Malformed automation.health_advisory proposal data.",
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

    return {
      success: true,
      effect: {
        applied: "none",
        reason:
          "automation.health_advisory is acknowledgement-only by design: it " +
          "pauses, archives and edits NOTHING. The finding reports automations " +
          "that are enabled but have never run, whose remedy is wiring the " +
          "missing trigger producer (or retiring the automation), not a write " +
          "made on the reviewer's behalf.",
      },
    };
  }

  // B4d: governance.raise_ceiling — the numeric-limit twin of B4b. Approving
  // INSERTS a `governance_ceilings` row (axis from payload, default
  // daily_write_count) at the proposed higher limit + source_proposal_id
  // lineage, and SUPERSEDES (soft-revokes) the agent's prior active pod-scoped
  // ceiling on that SAME axis so exactly one is effective. Mirrors the ceilings
  // router's `.create` insert shape. Floor-safe: a ceiling can only downgrade
  // execute→propose at rung 2.56 — raising one never widens a floor.
  if (proposal.proposalType === "governance.raise_ceiling") {
    const raiseData = payload as GovernanceRaiseCeilingProposalData | null;
    if (
      !raiseData ||
      typeof raiseData !== "object" ||
      !raiseData.agentUserId ||
      typeof raiseData.proposedLimit !== "number" ||
      (raiseData.axis != null &&
        raiseData.axis !== "daily_write_count" &&
        raiseData.axis !== "pending_proposal_cap")
    ) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Malformed governance.raise_ceiling proposal data.",
      });
    }
    const axis = raiseData.axis ?? "daily_write_count";

    // Supersede the agent's prior active pod-scoped ceiling ON THIS AXIS (if
    // any) so the new one is the single effective row — same soft-revoke the
    // ceilings router uses, scoped to this agent's pod ceilings on this axis.
    // EVIDENCE (storage engine): the supersede UPDATE and the new-ceiling
    // INSERT each RETURN their rows; `rows` is their sum. A supersede that
    // matched nothing (no prior ceiling) is legal and shows as 1, not 2.
    const supersededCeilings = await db
      .update(governanceCeilings)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(governanceCeilings.axis, axis),
          eq(governanceCeilings.principalKind, "agent"),
          eq(governanceCeilings.agentUserId, raiseData.agentUserId),
          eq(governanceCeilings.scopeKind, "pod"),
          isNull(governanceCeilings.revokedAt)
        )
      )
      .returning({ id: governanceCeilings.id });

    const insertedCeilings = await db
      .insert(governanceCeilings)
      .values({
        axis,
        principalKind: "agent",
        agentUserId: raiseData.agentUserId,
        scopeKind: "pod",
        workspaceId: null,
        limitValue: raiseData.proposedLimit,
        sourceProposalId: proposal.id,
        createdBy: userId,
      })
      .returning({ id: governanceCeilings.id });

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
    return {
      success: true,
      effect: {
        applied: "verified",
        rows: supersededCeilings.length + insertedCeilings.length,
        ids: insertedCeilings.map((r) => r.id),
        subject: "governance_ceilings",
      },
    };
  }

  // The unified gov-config settings payload — the ONE door for AI/cron/human to
  // propose a change to `governance_rules` / `governance_ceilings` /
  // `config_settings`. Sensitivity is enforced at the GATE (a loosening change
  // always proposes — see `isLooseningSettingsChange` in permission-check.ts);
  // here, on approval, the change is applied through the same insert/revoke
  // shapes the bespoke B4a–B4d branches use, dispatched on `store` + `op`.
  // B5: settings.update — the unified gov-config settings door. Approving
  // applies a `set` (insert) or `revoke` (soft-delete) to exactly one of the
  // three stores. Floor-safe at apply: a ceiling/rule change never widens a
  // floor beyond what a human-reviewed proposal already implies (the loosening
  // floor at the gate means no loosening change ever auto-applied to get here).
  if (proposal.proposalType === "settings.update") {
    const s = payload as SettingsUpdateProposalData | null;
    if (
      !s ||
      typeof s !== "object" ||
      (s.store !== "governance_rules" &&
        s.store !== "governance_ceilings" &&
        s.store !== "config_settings") ||
      (s.op !== "set" && s.op !== "revoke")
    ) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Malformed settings.update proposal data.",
      });
    }

    const { store, op, ...spec } = s;
    const { rows, ids, subject } = await applyGovConfigChange({
      store,
      op,
      spec,
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
    return {
      success: true,
      effect: { applied: "verified", rows, ids, subject },
    };
  }

  // B4c: governance.tighten_posture — the channel-scoped twin of B4b. Approving
  // creates a `config_settings` guideline (posture:'propose', scopeKind:'channel')
  // via the ONE guideline door `createGuideline` — the read side is
  // `resolveMostSpecificPosture` at rung 2.55. SCOPE RULE: when the channel has a
  // workspaceId, the guideline is WORKSPACE-scoped (a channel property applies to
  // all members, author-independent); a null-workspace channel guideline stays
  // pod-wide and relies on the owner-floor (createGuideline stamps createdBy =
  // this approver, an admin — see the pod-wide floor in config-settings.ts).
  if (proposal.proposalType === "governance.tighten_posture") {
    const postureData = payload as GovernanceTightenPostureProposalData | null;
    if (
      !postureData ||
      typeof postureData !== "object" ||
      !postureData.channelId
    ) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Malformed governance.tighten_posture proposal data.",
      });
    }

    // EVIDENCE (storage engine, one call deep): `createGuideline` is the ONE
    // guideline write door and it returns the row from its own INSERT ...
    // `.returning()` (database/src/utils/config-settings.ts). That row is the
    // engine's, not a service-layer boolean — an insert that produced no row
    // yields `rows: 0` here rather than a green `{success:true}`.
    const guideline = await createGuideline({
      db,
      text: `Auto-tightened: this channel produced ${postureData.clusterSize} rejected agent writes (${Math.round(
        postureData.rejectRate * 100
      )}% reject rate) — new writes here are routed to review.`,
      posture: "propose",
      scopeKind: "channel",
      scopeRef: postureData.channelId,
      workspaceId: postureData.workspaceId ?? null,
      source: "system",
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
    return {
      success: true,
      effect: {
        applied: "verified",
        rows: guideline?.id ? 1 : 0,
        ...(guideline?.id ? { ids: [guideline.id] } : {}),
        subject: "config_settings(guideline)",
      },
    };
  }

  // B4d: governance.work_guideline — the WORK-KIND twin of B4c. Approving
  // creates a `config_settings` guideline at `scopeKind:'workKind'`, whose
  // `scopeRef` is the `blockedReason` the recurrence scanner clustered on.
  //
  // THIS BRANCH IS NOT OPTIONAL PLUMBING. Without it the proposal falls to the
  // execution registry's `*/*` catch-all, which flips the row APPROVED and
  // materializes NOTHING — a green receipt for work that never happened, the
  // most-repeated defect in this codebase. A proposal type is only shippable
  // once something executes it.
  //
  // The text is taken from the payload, which the reviewer may EDIT before
  // approving: a draft a human rewrites is the point, not a draft a human
  // rubber-stamps.
  if (proposal.proposalType === "governance.work_guideline") {
    const workData = payload as GovernanceWorkGuidelineProposalData | null;
    if (
      !workData ||
      typeof workData !== "object" ||
      !workData.blockedReason ||
      typeof workData.text !== "string" ||
      !workData.text.trim()
    ) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Malformed governance.work_guideline proposal data.",
      });
    }

    // EVIDENCE: `createGuideline` returns the row from its own INSERT ...
    // RETURNING, so `rows` below is the storage engine's receipt, not a
    // service-layer boolean.
    const workGuideline = await createGuideline({
      db,
      text: workData.text.trim(),
      // NO posture — see the payload interface. A work guideline informs the
      // interpret pass; it never votes on trust.
      scopeKind: "workKind",
      scopeRef: workData.blockedReason,
      workspaceId: workData.workspaceId ?? null,
      source: "system",
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
    return {
      success: true,
      effect: {
        applied: "verified",
        rows: workGuideline?.id ? 1 : 0,
        ...(workGuideline?.id ? { ids: [workGuideline.id] } : {}),
        subject: "config_settings(guideline)",
      },
    };
  }

  // B4e: governance.structure_guideline — the DATA-TYPE twin of B4d, filed by
  // the structure-guideline scanner from repeated reasoned extraction rejects.
  // Approving writes the reviewed text as the next guideline VERSION at
  // entityKind / sourceKind / default (supersede when one exists, lineage
  // `proposal:<id>`) through `applyStructureGuidelineApproval`. Without this
  // branch the `*/*` catch-all would flip it APPROVED and write nothing.
  if (proposal.proposalType === "governance.structure_guideline") {
    return approveStructureGuidelineProposal({
      proposal: { ...proposal, subjectUserId: proposal.subjectUserId ?? null },
      reviewerId: userId,
      payload,
      reportProposalOutcome,
      emitProposalReviewed,
    });
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
