/**
 * Automation Governance Gate
 *
 * Closes the governance gap for the automation write path. Automation output
 * steps (`entity_create` / `entity_update`) must pass through the SAME
 * governance policy as chat-AI writes — keyed off the owning AGENT's user id —
 * so that per the agent's capabilities the write either auto-approves or
 * becomes a PENDING, ATTRIBUTED proposal in the Reactions queue.
 *
 * WHY THIS LIVES IN @synap/jobs (not @synap/api):
 *   The canonical gate is `checkPermissionOrPropose` in
 *   packages/api/src/utils/permission-check.ts. The automation-executor runs
 *   inside @synap/jobs, and @synap/api already depends on @synap/jobs (api →
 *   jobs), so importing the canonical gate here would be circular. This module
 *   is a forked MIRROR of that gate's agent policy — it never relaxes a check.
 *
 *   DRIFT RISK: the policy constants below (ADMIN_ACTIONS, DEFAULT_AUTO_APPROVE)
 *   are copied from permission-check.ts and will silently diverge if one side
 *   changes. TODO: extract the shared policy (constants + precedence) into a
 *   lower package both api and jobs import, and delete this fork.
 *
 * ATTRIBUTION / Reactions queue: the Reactions queue is DB-driven — the
 * proposals router lists rows WHERE status = 'pending' AND agent_user_id IS NOT
 * NULL (see packages/api/src/routers/proposals.ts). We therefore guarantee
 * attribution by writing a PENDING `proposals` row carrying `agentUserId`,
 * exactly like `createPendingProposal` does. The realtime broadcast +
 * emitSideEffects are supplementary nudges, mirrored here for parity.
 *
 * Policy mirrored from checkPermissionOrPropose (in precedence order):
 *   1. RBAC via verifyPermission (effective user = owning agent's user id)
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
  eq,
  users,
  workspaces,
  verifyPermission,
  ProposalStatus,
  insertPendingProposal,
} from "@synap/database";
import type { WorkspaceSettings, AgentMetadata } from "@synap/database/schema";
import { randomUUID } from "crypto";
import { emitSideEffects } from "@synap/events";
import { broadcastNotification } from "./realtime-broadcast.js";
import { createLogger } from "@synap-core/core";
import {
  decideAgentPolicy,
  requiredPermissionFor,
} from "@synap/governance-policy";

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
  /** Provenance: the automation run that triggered this write. */
  automationRunId?: string;
  correlationId?: string;
  /** The focus session this run opened (see openRunSession) — stamped onto
   *  the created proposal so it groups under the session's reviewable card. */
  sessionId?: string;
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
    automationRunId,
    correlationId,
    sessionId,
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

  // 2. Resolve whether the owner is an AGENT user. Only then does the agent
  //    governance policy apply (capabilities / propose-by-default). This is the
  //    same userType === "agent" defence-in-depth check the canonical gate runs.
  const [ownerUser] = await db
    .select({
      userType: users.userType,
      agentMetadata: users.agentMetadata,
    })
    .from(users)
    .where(eq(users.id, ownerId))
    .limit(1);

  const isAgentOwner = ownerUser?.userType === "agent";

  if (!isAgentOwner) {
    // Owner is a human (or an unresolved principal). A human-owned automation
    // write is governed by the human's RBAC only — identical to that human
    // acting directly. This is NOT a relaxation of agent governance: no agent
    // is involved, so there is nothing to attribute to an agent. RBAC above
    // already gated it.
    return { granted: true };
  }

  // From here on the owner IS an agent user → apply agent governance policy.
  const agentUserId = ownerId;

  const [ws] = await db
    .select({
      settings: workspaces.settings,
      workspaceType: workspaces.workspaceType,
    })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  const settings = ws?.settings as WorkspaceSettings | undefined;
  const isAgentOwnedWorkspace =
    ws?.workspaceType === "agent" && settings?.linkedAgentId === agentUserId;

  const agentMeta = ownerUser?.agentMetadata as AgentMetadata | null;

  // Agent governance policy — SINGLE SOURCE OF TRUTH in @synap/governance-policy.
  // Automation writes are never channel writes, so there is no per-channel grant.
  const decision = decideAgentPolicy({
    subjectType,
    action,
    agentCapabilities: agentMeta?.capabilities,
    writesRequireProposal: agentMeta?.writesRequireProposal === true,
    governanceMode: settings?.governanceMode,
    autoApproveFor: settings?.aiGovernance?.autoApproveFor,
    isAgentOwnedWorkspace,
  });

  if (decision.verdict === "deny") {
    logger.warn(
      { ownerId, workspaceId, eventKey: `${subjectType}.${action}` },
      "Automation write denied by agent governance policy"
    );
    return { denied: true, reason: decision.reason };
  }

  if (decision.verdict === "propose") {
    return proposeAutomationWrite({
      agentUserId,
      workspaceId,
      subjectType,
      action,
      data,
      // decision.reason carries the per-branch default; undefined for the plain
      // default-propose case, where proposeAutomationWrite supplies its own.
      reasoning: reasoning ?? decision.reason,
      automationRunId,
      correlationId,
      sessionId,
    });
  }

  // verdict === "execute": auto-approved → the caller may write directly.
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
}): Promise<{ proposed: true; proposalId: string }> {
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
  } = opts;

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
  const proposal = await insertPendingProposal({
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
  });

  // Supplementary realtime nudge — the Reactions queue itself is DB-driven, so
  // a broadcast failure must never block governance.
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

  logger.info(
    {
      proposalId: proposal.id,
      agentUserId,
      workspaceId,
      eventKey: `${subjectType}.${action}`,
    },
    "Automation write routed to attributed proposal"
  );

  return { proposed: true, proposalId: proposal.id };
}
