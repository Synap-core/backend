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
  proposals,
  users,
  workspaces,
  verifyPermission,
  ProposalStatus,
} from "@synap/database";
import type { WorkspaceSettings, AgentMetadata } from "@synap/database/schema";
import { randomUUID } from "crypto";
import { emitSideEffects } from "@synap/events";
import { broadcastNotification } from "./realtime-broadcast.js";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "automation-governance" });

/** Proposals auto-expire after this many days if not reviewed. */
const PROPOSAL_TTL_DAYS = 30;

/** KEEP IN SYNC WITH permission-check.ts ADMIN_ACTIONS — always require a proposal. */
const ADMIN_ACTIONS: readonly string[] = [
  "workspace.update",
  "workspace.delete",
  "member.updateRole",
  "member.remove",
  "member.invite",
  "agent.create",
  "agent.delete",
  "agent.updateRole",
  "agent.updateCapabilities",
  "agent.update",
  "apiKey.create",
  "apiKey.revoke",
  "apiKey.rotate",
  "intelligence.connect",
  "intelligence.disconnect",
  "trustedIssuer.create",
  "trustedIssuer.delete",
  "connector.connect",
  "connector.disconnect",
];

/** KEEP IN SYNC WITH permission-check.ts DEFAULT_AUTO_APPROVE — auto-approved unless a workspace overrides via settings.aiGovernance.autoApproveFor. */
const DEFAULT_AUTO_APPROVE: readonly string[] = [
  "search.*",
  "memory.recall",
  "entity.read",
  "bento.arrange",
  "document.read",
  "context.*",
  "filesystem.read",
  "filesystem.write_workspace",
  "view.create",
  "profile.create",
  "profile.update",
  "property_def.create",
  "property_def.update",
  "entity.create",
  "entity.update",
  "document.create",
  "relation.create",
  "channel.create",
  "terminal.read_logs",
];

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
  } = opts;

  // Map action → required RBAC permission (mirrors permission-check.ts).
  const requiredPermission: "read" | "write" | "delete" | "manage" =
    action === "delete"
      ? "delete"
      : action === "create" ||
          action === "update" ||
          action === "archive" ||
          action === "restore" ||
          action === "add" ||
          action === "remove" ||
          action === "updateRole"
        ? "write"
        : "read";

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
    .select({ settings: workspaces.settings })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  const settings = ws?.settings as WorkspaceSettings | undefined;

  const eventKey = `${subjectType}.${action}`;

  // 2a. CBAC: explicit capabilities allowlist (empty/absent = unrestricted).
  const agentCapabilities = (ownerUser?.agentMetadata as AgentMetadata | null)
    ?.capabilities;
  if (agentCapabilities && agentCapabilities.length > 0) {
    const hasCapability =
      agentCapabilities.includes(eventKey) ||
      agentCapabilities.includes(`${subjectType}.*`) ||
      agentCapabilities.includes("*.*");
    if (!hasCapability) {
      return {
        denied: true,
        reason: `Agent capability check failed for "${eventKey}". Allowed: ${agentCapabilities.join(", ")}.`,
      };
    }
  }

  // 2b. ADMIN_ACTIONS: always propose.
  if (ADMIN_ACTIONS.includes(eventKey)) {
    return proposeAutomationWrite({
      agentUserId,
      workspaceId,
      subjectType,
      action,
      data,
      reasoning: reasoning ?? "Administrative action requires human approval.",
      automationRunId,
      correlationId,
    });
  }

  // 2c. writesRequireProposal: assistant-template agents always propose on
  //     writes. Pure reads are exempt (no read output types here, but kept
  //     faithful to the canonical gate).
  if (
    (ownerUser?.agentMetadata as AgentMetadata | null)
      ?.writesRequireProposal === true
  ) {
    const isPureRead =
      action.endsWith(".read") ||
      subjectType === "search" ||
      subjectType === "context" ||
      subjectType === "memory" ||
      eventKey.endsWith(".read") ||
      eventKey === "memory.recall" ||
      /^search\./.test(eventKey) ||
      /^context\./.test(eventKey) ||
      /^memory\./.test(eventKey);
    if (!isPureRead) {
      return proposeAutomationWrite({
        agentUserId,
        workspaceId,
        subjectType,
        action,
        data,
        reasoning:
          reasoning ?? "Agent requires proposal for all write operations.",
        automationRunId,
        correlationId,
      });
    }
  }

  // 2d. agent-owned workspace + destructive → always propose.
  if (
    settings?.governanceMode === "agent-owned" &&
    (action === "delete" || action === "archive" || action === "purge")
  ) {
    return proposeAutomationWrite({
      agentUserId,
      workspaceId,
      subjectType,
      action,
      data,
      reasoning:
        reasoning ??
        "Destructive action in agent-owned workspace requires human approval.",
      automationRunId,
      correlationId,
    });
  }

  // 2e. autoApproveFor whitelist → auto-approve.
  const autoApproveFor =
    settings?.aiGovernance?.autoApproveFor ?? DEFAULT_AUTO_APPROVE;
  const isAutoApproved = autoApproveFor.some((pattern) =>
    pattern.endsWith(".*")
      ? eventKey.startsWith(pattern.slice(0, -2))
      : eventKey === pattern
  );
  if (isAutoApproved) {
    return { granted: true };
  }

  // 2f. Default: agent write requires a proposal.
  return proposeAutomationWrite({
    agentUserId,
    workspaceId,
    subjectType,
    action,
    data,
    reasoning,
    automationRunId,
    correlationId,
  });
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
  } = opts;

  const singularType = subjectType.endsWith("s")
    ? subjectType.slice(0, -1)
    : subjectType;
  const targetId = String(
    data.entityId ?? data.documentId ?? data.id ?? randomUUID()
  );
  const resolvedCorrelationId = correlationId ?? randomUUID();

  const [proposal] = await db
    .insert(proposals)
    .values({
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
      status: ProposalStatus.PENDING,
      createdBy: agentUserId,
      agentUserId,
      correlationId: resolvedCorrelationId,
      expiresAt: new Date(Date.now() + PROPOSAL_TTL_DAYS * 24 * 60 * 60 * 1000),
    })
    .returning({ id: proposals.id });

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
