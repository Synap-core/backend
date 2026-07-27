/**
 * Automation Governance Gate
 *
 * Closes the governance gap for the automation write path. Automation output
 * steps (`entity_create` / `entity_update`) must pass through the SAME
 * governance policy as chat-AI writes — keyed off the owning AGENT's user id —
 * so that per the agent's capabilities the write either auto-approves or
 * becomes a PENDING, ATTRIBUTED proposal in the Reactions queue.
 *
 * SHARED LADDER (no longer a fork):
 *   This door runs the SAME agent-governance ladder as the chat door
 *   (`checkPermissionOrPropose`). Steps (b)-(e) — confirm-agent → load workspace
 *   settings → `decideAgentPolicy` → verdict — are the SINGLE SOURCE OF TRUTH
 *   `resolveAgentGovernanceDecision` (@synap/database). The inline copy that
 *   used to live here (with its documented drift risk) is gone. What stays here
 *   is only this door's own concerns: step (a) RBAC + its simple deny, and the
 *   `propose` side effect (`proposeAutomationWrite`). @synap/database is the
 *   home because @synap/api → @synap/jobs (a helper in api would be a circular
 *   import for this jobs-side door), and both layers already depend on it.
 *
 * ATTRIBUTION / Reactions queue: the Reactions queue is DB-driven — the
 * proposals router lists rows WHERE status = 'pending' AND agent_user_id IS NOT
 * NULL (see packages/api/src/routers/proposals.ts). We therefore guarantee
 * attribution by writing a PENDING `proposals` row carrying `agentUserId`,
 * exactly like `createPendingProposal` does. The realtime broadcast +
 * emitSideEffects are supplementary nudges, mirrored here for parity.
 *
 * Ladder (precedence order, all in `resolveAgentGovernanceDecision` except RBAC):
 *   1. RBAC via verifyPermission (effective user = owning agent's user id) — here
 *   2. CBAC capabilities allowlist (deny if the agent lacks the capability)
 *   3. ADMIN_ACTIONS → always propose
 *   4. writesRequireProposal → propose on writes
 *   5. agent-owned workspace + destructive → propose
 *   6. autoApproveFor whitelist → auto-approve (granted)
 *   7. default → propose
 *
 * NEVER loosens an existing check. When the owning agent cannot be resolved as
 * an agent user (e.g. createdBy is a plain human), governance falls back to the
 * SAME human-RBAC path a direct human write would take (verifyPermission only),
 * which is not a relaxation — it is identical to a human acting directly.
 */

import {
  db,
  verifyPermission,
  ProposalStatus,
  insertPendingProposal,
  proposals,
  eq,
  and,
} from "@synap/database";
import { resolveAgentGovernanceDecision } from "@synap/database/agent-governance";
import { randomUUID } from "crypto";
import { emitSideEffects } from "@synap/events";
import { broadcastNotification } from "./realtime-broadcast.js";
import { createLogger } from "@synap-core/core";
import { requiredPermissionFor } from "@synap/governance-policy";

const logger = createLogger({ module: "automation-governance" });

// Governance POLICY (the constants + the agent precedence ladder + PROPOSAL_TTL_DAYS)
// now lives in @synap/governance-policy — the SINGLE SOURCE OF TRUTH shared with
// checkPermissionOrPropose(). The forked mirror that used to live here is gone;
// this module keeps only the jobs-side side effects (proposeAutomationWrite).

export type AutomationGovernanceResult =
  | { granted: true }
  | { proposed: true; proposalId: string }
  | { denied: true; reason: string };

export interface AutomationGovernanceOpts {
  /**
   * The automation's owning principal (automation.createdBy). For AI-created
   * automations this is the agent's user id; for manual automations it is a
   * human user id. The gate resolves which it is and applies the correct policy.
   */
  ownerId: string;
  workspaceId: string;
  subjectType: string;
  /** "create" | "update" — the write action being governed. */
  action: string;
  data: Record<string, unknown>;
  reasoning?: string;
  /**
   * The write SUBJECT's entity profile slug (D3 — automation-door parity with
   * the chat door, which has carried this since `resolveAgentGovernanceDecision`
   * was introduced). Governs by KIND: e.g. lets a "note" write auto-approve
   * while a "lead" write on the same automation still proposes, via a
   * `target_kind: "profile"` governance_rules row. Absent → no profile-kind
   * rule can match (byte-identical to before this field existed).
   */
  subjectProfileSlug?: string | null;
  /** Provenance: the automation run that triggered this write. */
  automationRunId?: string;
  correlationId?: string;
  /** The focus session this run opened (see openRunSession) — stamped onto
   *  the created proposal so it groups under the session's reviewable card. */
  sessionId?: string;
  /** Workflow attribution (D3a): the executing step run + flow node id, stamped
   *  onto the proposal so a rejected proposal traces to the exact step. */
  stepRunId?: string;
  nodeId?: string;
}

/**
 * Governance gate for automation entity writes.
 *
 * Returns:
 *   - { granted }  → the caller MAY perform the direct write.
 *   - { proposed } → a PENDING attributed proposal was created; the caller must
 *                    NOT write. The change awaits human review in Reactions.
 *   - { denied }   → RBAC / capabilities forbid the action; the caller must NOT
 *                    write and should surface the reason.
 */
export async function checkAutomationWriteOrPropose(
  opts: AutomationGovernanceOpts
): Promise<AutomationGovernanceResult> {
  const {
    ownerId,
    workspaceId,
    subjectType,
    action,
    data,
    reasoning,
    subjectProfileSlug,
    automationRunId,
    correlationId,
    sessionId,
    stepRunId,
    nodeId,
  } = opts;

  // Map action → required RBAC permission (canonical map in @synap/governance-policy).
  const requiredPermission = requiredPermissionFor(action);

  // 1. RBAC: the OWNING principal's workspace role gates the action. If the
  //    owner is an agent user, this is the agent's own role (per the platform
  //    model). If the owner is a human, this is the human's role.
  const rbac = await verifyPermission({
    db,
    userId: ownerId,
    workspace: { id: workspaceId },
    requiredPermission,
  });

  if (!rbac.allowed) {
    logger.warn(
      { ownerId, workspaceId, requiredPermission, reason: rbac.reason },
      "Automation write denied by RBAC"
    );
    return {
      denied: true,
      reason: rbac.reason || "Permission denied",
    };
  }

  // 2. Agent governance ladder — steps (b)-(e) are the SHARED SSOT
  //    `resolveAgentGovernanceDecision` (@synap/database), the SAME ladder the
  //    chat door runs. It confirms the owner is an agent user, loads the
  //    workspace settings, and applies decideAgentPolicy. Automation writes are
  //    never channel writes and never force a proposal, so the per-channel /
  //    subject-kind / forcePropose inputs are omitted; `preferAgentMetadata
  //    AutoApproveFor: false` preserves this door's workspace-only autoApproveFor.
  const gov = await resolveAgentGovernanceDecision({
    db,
    agentUserId: ownerId,
    workspaceId,
    subjectType,
    action,
    // D3: thread the write subject's profile slug so a profile-KIND
    // governance_rules row (e.g. "note" auto vs "lead" propose) applies to
    // automation writes too — full parity with the chat door.
    subjectProfileSlug,
    preferAgentMetadataAutoApproveFor: false,
  });

  if (gov.decision === "not-agent") {
    // Owner is a human (or an unresolved principal). A human-owned automation
    // write is governed by the human's RBAC only — identical to that human
    // acting directly. This is NOT a relaxation of agent governance: no agent
    // is involved, so there is nothing to attribute to an agent. RBAC above
    // already gated it.
    return { granted: true };
  }

  if (gov.decision === "deny") {
    logger.warn(
      { ownerId, workspaceId, eventKey: `${subjectType}.${action}` },
      "Automation write denied by agent governance policy"
    );
    return { denied: true, reason: gov.reason };
  }

  if (gov.decision === "propose") {
    return proposeAutomationWrite({
      agentUserId: ownerId,
      workspaceId,
      subjectType,
      action,
      data,
      // gov.reason carries the per-branch default; undefined for the plain
      // default-propose case, where proposeAutomationWrite supplies its own.
      reasoning: reasoning ?? gov.reason,
      automationRunId,
      correlationId,
      sessionId,
      stepRunId,
      nodeId,
    });
  }

  // gov.decision === "execute": auto-approved → the caller may write directly.
  return { granted: true };
}

/**
 * Create a PENDING proposal attributed to the owning agent and surface it in
 * the Reactions queue. Mirrors createPendingProposal's persisted shape
 * (status=pending, agentUserId, TTL, broadcast, emitSideEffects) so automation
 * proposals are indistinguishable from chat-AI proposals in the queue.
 */
async function proposeAutomationWrite(opts: {
  agentUserId: string;
  workspaceId: string;
  subjectType: string;
  action: string;
  data: Record<string, unknown>;
  reasoning?: string;
  automationRunId?: string;
  correlationId?: string;
  /** The focus session this run opened — stamped onto the proposal row so it
   *  groups under the session's reviewable card. */
  sessionId?: string;
  /** Workflow attribution (D3a): the executing step run + flow node id. */
  stepRunId?: string;
  nodeId?: string;
}): Promise<{ proposed: true; proposalId: string; deduped?: boolean }> {
  const {
    agentUserId,
    workspaceId,
    subjectType,
    action,
    data,
    reasoning,
    automationRunId,
    correlationId,
    sessionId,
    stepRunId,
    nodeId,
  } = opts;

  // STEP-RUN IDEMPOTENCY (the pg-boss hole): the automation queue retries steps
  // (retryLimit:3) with NO idempotency, so a redelivered step would re-propose.
  // A (stepRunId, nodeId) pair identifies exactly one flow-node execution, so if
  // a proposal already exists for it — in ANY status (a redelivery must not
  // re-propose even when the first attempt was already approved/rejected) —
  // return it instead of creating a second. Runs BEFORE the governance write.
  if (stepRunId && nodeId) {
    const [existing] = await db
      .select({ id: proposals.id })
      .from(proposals)
      .where(
        and(eq(proposals.stepRunId, stepRunId), eq(proposals.nodeId, nodeId))
      )
      .limit(1);
    if (existing) {
      return { proposed: true, proposalId: existing.id, deduped: true };
    }
  }

  const singularType = subjectType.endsWith("s")
    ? subjectType.slice(0, -1)
    : subjectType;
  const targetId = String(
    data.entityId ?? data.documentId ?? data.id ?? randomUUID()
  );
  const resolvedCorrelationId = correlationId ?? randomUUID();

  // Shared PENDING-proposal INSERT (SSOT in @synap/database) — the same row
  // shape the chat-AI path uses via createPendingProposal. The hand-mirrored
  // insert that used to live here (with its documented drift risk) is gone; the
  // automation-specific `data` payload + side effects below stay here.
  const { proposal, deduped } = await insertPendingProposal({
    workspaceId,
    targetType: singularType,
    targetId,
    proposalType: action,
    data: {
      ...data,
      source: "automation",
      agentUserId,
      // autonomous: an agent acted on its own (no human in the loop for
      // automation runs). Mirrors deriveAuthorshipMode(undefined, agentUserId).
      authorshipMode: "autonomous",
      reasoning: reasoning ?? "Automation write requires review",
      correlationId: resolvedCorrelationId,
      ...(automationRunId ? { automationRunId } : {}),
    },
    createdBy: agentUserId,
    agentUserId,
    correlationId: resolvedCorrelationId,
    sessionId: sessionId ?? null,
    stepRunId: stepRunId ?? null,
    nodeId: nodeId ?? null,
  });

  // Supplementary realtime nudge — the Reactions queue itself is DB-driven, so
  // a broadcast failure must never block governance. Skipped on a dedup hit: the
  // pre-existing row already broadcast + emitted these when it was first created.
  if (!deduped) {
    try {
      await broadcastNotification({
        userId: agentUserId,
        requestId: proposal.id,
        message: {
          type: "proposal:created",
          data: {
            proposalId: proposal.id,
            targetType: singularType,
            targetId,
            changeType: action,
            status: ProposalStatus.PENDING,
          },
          requestId: proposal.id,
          status: "success",
          timestamp: new Date().toISOString(),
        },
      });
    } catch {
      // non-critical
    }

    emitSideEffects({
      subjectType: "proposal",
      action: "created",
      subjectId: proposal.id,
      userId: agentUserId,
      workspaceId,
      data: {
        proposalStatus: "created",
        targetType: singularType,
        changeType: action,
        correlationId: resolvedCorrelationId,
      },
    });
  }

  logger.info(
    {
      proposalId: proposal.id,
      agentUserId,
      workspaceId,
      eventKey: `${subjectType}.${action}`,
      deduped,
    },
    deduped
      ? "Automation write matched an existing pending proposal (deduped)"
      : "Automation write routed to attributed proposal"
  );

  return {
    proposed: true,
    proposalId: proposal.id,
    ...(deduped ? { deduped: true } : {}),
  };
}
