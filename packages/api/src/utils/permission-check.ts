/**
 * Permission Check + Proposal Helper
 *
 * Synchronous replacement for the old globalValidator Inngest function.
 * Checks permissions and optionally creates proposals for AI-sourced actions.
 *
 * Returns immediately — no async event pipeline.
 */

import { db, proposals } from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import { randomUUID } from "crypto";
import { createLogger } from "@synap-core/core";
import type { RequestShapedProposalData } from "@synap-core/types";
import { broadcastNotification } from "@synap/jobs";

const logger = createLogger({ module: "permission-check" });

export type PermissionResult =
  | { granted: true }
  | { granted: false; proposalId: string }
  | { denied: true; reason: string };

export interface PermissionCheckOpts {
  userId: string;
  workspaceId?: string;
  subjectType: string;
  action: string;
  source?: string;
  data: Record<string, unknown>;
}

/**
 * Check permissions and optionally create a proposal.
 *
 * Logic (extracted from globalValidatorHandler):
 * 1. No workspaceId → auto-granted (personal resource)
 * 2. Map action → required permission
 * 3. Call verifyPermission()
 * 4. If denied → return { denied: true }
 * 5. If AI source + !aiAutoApprove → create proposal, return { granted: false, proposalId }
 * 6. Otherwise → return { granted: true }
 */
export async function checkPermissionOrPropose(
  opts: PermissionCheckOpts
): Promise<PermissionResult> {
  const { userId, workspaceId, subjectType, action, source, data } = opts;

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

  // 3. Check workspace permission
  try {
    const { verifyPermission } = await import("@synap/database");

    const result = await verifyPermission({
      db,
      userId,
      workspace: { id: workspaceId },
      requiredPermission,
    });

    if (!result.allowed) {
      logger.warn(
        { userId, workspaceId, requiredPermission, reason: result.reason },
        "Permission denied"
      );
      return { denied: true, reason: result.reason || "Permission denied" };
    }
  } catch (error) {
    logger.error({ err: error }, "Permission check error");
    return { denied: true, reason: "Permission check error" };
  }

  // 4. AI source policy check
  if (source === "ai" || source === "intelligence") {
    try {
      const { workspaces, eq } = await import("@synap/database");

      const [ws] = await db
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1);

      const aiAutoApprove = (ws?.settings as any)?.aiAutoApprove || false;

      if (!aiAutoApprove) {
        // Create proposal
        const targetId = (data.documentId || data.entityId || data.id || randomUUID()) as string;
        const singularType = subjectType.endsWith("s")
          ? subjectType.slice(0, -1)
          : subjectType;

        const proposalData: RequestShapedProposalData = {
          requestId: randomUUID(),
          source: source as RequestShapedProposalData["source"],
          sourceId: userId,
          workspaceId,
          targetType: singularType as RequestShapedProposalData["targetType"],
          targetId,
          changeType: action as RequestShapedProposalData["changeType"],
          data,
          reasoning: "AI proposal requires review",
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
          })
          .returning();

        // Broadcast proposal notification
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
    } catch (error) {
      logger.error({ err: error }, "AI policy check error — defaulting to grant");
    }
  }

  // 5. Permission granted
  return { granted: true };
}
