/**
 * Permission Check + Proposal Helper
 *
 * Synchronous replacement for the old globalValidator Inngest function.
 * Checks permissions and optionally creates proposals for AI-sourced actions.
 *
 * Supports AI agent users: when agentUserId is provided, the agent's own
 * workspace role determines permissions (not the triggering human's role).
 *
 * Returns immediately — no async event pipeline.
 */

import { db, proposals } from "@synap/database";
import { users, workspaces, ProposalStatus } from "@synap/database/schema";
import { randomUUID } from "crypto";
import { createLogger } from "@synap-core/core";
import type { RequestShapedProposalData } from "@synap-core/types";
import { broadcastNotification } from "@synap/jobs";
import type { WorkspaceSettings } from "@synap/database/schema";

const logger = createLogger({ module: "permission-check" });

export type PermissionResult =
  | { granted: true }
  | { granted: false; proposalId: string }
  | { denied: true; reason: string };

export interface PermissionCheckOpts {
  userId: string;
  agentUserId?: string;
  workspaceId?: string;
  subjectType: string;
  action: string;
  source?: string;
  data: Record<string, unknown>;
  /** Correlation ID linking this check to the .requested event */
  correlationId?: string;
  /** AI reasoning for why this action is proposed */
  reasoning?: string;
  /** Provenance: which chat thread triggered this proposal */
  threadId?: string;
  /** Provenance: which command run generated this proposal */
  commandRunId?: string;
  /** Provenance: which specific message triggered this proposal */
  sourceMessageId?: string;
}

/**
 * Check permissions and optionally create a proposal.
 *
 * Logic:
 * 1. No workspaceId → auto-granted (personal resource)
 * 2. Map action → required permission
 * 3. Determine effective user: agentUserId (if provided) or userId
 * 4. Call verifyPermission() with effective user
 * 5. If denied → return { denied: true }
 * 6. AI policy:
 *    a. Agent user → check requireReviewFor list; if event listed, propose; else auto-approve
 *    b. Non-agent AI source → use legacy aiAutoApprove toggle
 * 7. Otherwise → return { granted: true }
 */
export async function checkPermissionOrPropose(
  opts: PermissionCheckOpts
): Promise<PermissionResult> {
  const {
    userId,
    agentUserId,
    workspaceId,
    subjectType,
    action,
    source,
    data,
    correlationId,
    threadId,
    commandRunId,
    sourceMessageId,
  } = opts;

  // 1. Personal resources (no workspace) - implicit ownership
  if (!workspaceId) {
    return { granted: true };
  }

  // 2. Determine required permission
  let requiredPermission: "read" | "write" | "delete" | "manage" = "read";
  if (action === "delete") {
    requiredPermission = "delete";
  } else if (
    action === "create" ||
    action === "update" ||
    action === "archive" ||
    action === "restore" ||
    action === "add" ||
    action === "remove" ||
    action === "updateRole"
  ) {
    requiredPermission = "write";
  }

  // 3. Determine effective user for permission check
  const effectiveUserId = agentUserId || userId;

  // 4. Check workspace permission using the effective user's role
  try {
    const { verifyPermission, eq } = await import("@synap/database");

    const result = await verifyPermission({
      db,
      userId: effectiveUserId,
      workspace: { id: workspaceId },
      requiredPermission,
    });

    if (!result.allowed) {
      logger.warn(
        {
          userId: effectiveUserId,
          workspaceId,
          requiredPermission,
          reason: result.reason,
        },
        "Permission denied"
      );
      return { denied: true, reason: result.reason || "Permission denied" };
    }

    // 5. AI policy check
    if (source === "ai" || source === "intelligence") {
      // Check if the effective user is an AI agent
      if (agentUserId) {
        const [agentUser] = await db
          .select({ userType: users.userType })
          .from(users)
          .where(eq(users.id, agentUserId))
          .limit(1);

        if (agentUser?.userType === "agent") {
          // Agent user: permission already verified via role above.
          // Check workspace requireReviewFor for per-event-type overrides.
          const [ws] = await db
            .select({ settings: workspaces.settings })
            .from(workspaces)
            .where(eq(workspaces.id, workspaceId))
            .limit(1);

          const settings = ws?.settings as WorkspaceSettings | undefined;
          const requireReview = settings?.aiGovernance?.requireReviewFor ?? [];
          const eventKey = `${subjectType}.${action}`;

          if (requireReview.includes(eventKey)) {
            // Workspace explicitly requires review for this event type
            return createProposal({
              userId,
              workspaceId,
              subjectType,
              action,
              source,
              data,
              correlationId,
              reasoning: opts.reasoning,
              threadId,
              commandRunId,
              sourceMessageId,
            });
          }

          // Agent has permission and no review required — auto-approve
          return { granted: true };
        }
      }

      // Non-agent AI source: use legacy aiAutoApprove toggle
      const [ws] = await db
        .select({ settings: workspaces.settings })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1);

      const settings = ws?.settings as WorkspaceSettings | undefined;
      const aiAutoApprove =
        settings?.aiGovernance?.autoApprove ??
        (settings as Record<string, unknown> | undefined)?.aiAutoApprove ??
        false;

      if (!aiAutoApprove) {
        return createProposal({
          userId,
          workspaceId,
          subjectType,
          action,
          source,
          data,
          correlationId,
          reasoning: opts.reasoning,
          threadId,
          commandRunId,
          sourceMessageId,
        });
      }
    }
  } catch (error) {
    logger.error({ err: error }, "Permission check error");
    return { denied: true, reason: "Permission check error" };
  }

  // 6. Permission granted
  return { granted: true };
}

/**
 * Create a proposal for an AI-sourced action that requires review.
 */
async function createProposal(opts: {
  userId: string;
  workspaceId: string;
  subjectType: string;
  action: string;
  source?: string;
  data: Record<string, unknown>;
  correlationId?: string;
  reasoning?: string;
  threadId?: string;
  commandRunId?: string;
  sourceMessageId?: string;
}): Promise<{ granted: false; proposalId: string }> {
  const {
    userId,
    workspaceId,
    subjectType,
    action,
    source,
    data,
    correlationId,
    reasoning,
    threadId,
    commandRunId,
    sourceMessageId,
  } = opts;

  const targetId = (data.documentId ||
    data.entityId ||
    data.id ||
    randomUUID()) as string;
  const singularType = subjectType.endsWith("s")
    ? subjectType.slice(0, -1)
    : subjectType;

  const proposalData: RequestShapedProposalData & { correlationId?: string } = {
    requestId: randomUUID(),
    source: (source || "intelligence") as RequestShapedProposalData["source"],
    sourceId: userId,
    workspaceId,
    targetType: singularType as RequestShapedProposalData["targetType"],
    targetId,
    changeType: action as RequestShapedProposalData["changeType"],
    data,
    reasoning: reasoning || "AI proposal requires review",
    ...(correlationId ? { correlationId } : {}),
  };

  const [proposal] = await db
    .insert(proposals)
    .values({
      workspaceId,
      targetType: singularType,
      targetId,
      proposalType: action,
      data: proposalData,
      status: ProposalStatus.PENDING,
      createdBy: userId,
      ...(threadId ? { threadId } : {}),
      ...(commandRunId ? { commandRunId } : {}),
      ...(sourceMessageId ? { sourceMessageId } : {}),
    })
    .returning();

  // Broadcast proposal notification (non-critical)
  try {
    const requestId = (data.requestId as string) || randomUUID();
    await broadcastNotification({
      userId,
      requestId,
      message: {
        type: "proposal:created",
        data: {
          proposalId: proposal.id,
          targetType: singularType,
          targetId,
          changeType: action,
          status: ProposalStatus.PENDING,
        },
        requestId,
        status: "success",
        timestamp: new Date().toISOString(),
      },
    });
  } catch {
    // Broadcast failure is non-critical
  }

  return { granted: false, proposalId: proposal.id };
}
