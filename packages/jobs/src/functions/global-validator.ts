/**
 * Global Validator Worker
 *
 * The system's "Brain" / "Transformer".
 * Intercepts all `*.requested` events and decides:
 * 1. Auto-Approve -> `*.validated`
 * 2. Require Review -> Insert to `proposals` table
 * 3. Deny -> `*.denied`
 *
 * Replaces: permission-validator.ts
 */

import { inngest } from "../client.js";
import { db, proposals } from "@synap/database";
import { randomUUID } from "crypto";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "global-validator" });

export const globalValidator = inngest.createFunction(
  {
    id: "global-validator",
    name: "Global Validator & Proposal Router",
    retries: 2,
  },
  [
    { event: "entities.create.requested" },
    { event: "*.*.requested" }
  ],
  async ({ event, step }) => {
    const eventName = event.name as string;
    const [targetType, action] = eventName.split("."); // e.g. 'documents', 'create'
    const userId = event.user?.id || event.data.userId;
    const workspaceId = event.data.workspaceId;
    const source =
      event.data.source || (event.data.metadata as any)?.source || "user";
    const data = event.data;

    if (!userId) {
      logger.error({ eventName }, "No userId in event - auto-denying");
      return { status: "denied", reason: "No user context" };
    }

    logger.info(
      { eventName, userId, action, targetType, source },
      "Validating request",
    );


    // 1. Permission Check (Security Layer) - NEW 3-LEVEL SYSTEM
    const permissionResult = await step.run("check-permissions", async () => {
      try {
        const { getDb, verifyPermission } = await import("@synap/database");
        const db = await getDb();

        // Personal resources (no workspace) - implicit ownership for now
        if (!workspaceId) {
          return { granted: true, reason: "personal-resource" };
        }

        // Determine required permission based on action
        let requiredPermission: 'read' | 'write' | 'delete' | 'manage' = 'read';
        
        if (action === "delete") {
          requiredPermission = 'delete'; // Requires owner role
        } else if (action === "create" || action === "update") {
          requiredPermission = 'write'; // Requires editor or owner
        } else if (action === "addMember" || action === "removeMember" || action === "updateMemberRole") {
          requiredPermission = 'manage'; // Workspace/project management
        }

        // Get projectIds from event data if present
        const projectIds = data.projectIds || [];

        // 🔐 NEW: 3-Level Permission Check
        const result = await verifyPermission({
          db,
          userId,
          workspace: { id: workspaceId },
          project: projectIds.length > 0 ? { ids: projectIds } : undefined,
          requiredPermission,
        });

        if (!result.allowed) {
          logger.warn(
            { userId, workspaceId, projectIds, requiredPermission, reason: result.reason },
            "Permission denied"
          );
          return { 
            granted: false, 
            reason: result.reason,
            role: result.role,
            context: result.context,
          };
        }

        logger.info(
          { userId, workspaceId, role: result.role, context: result.context },
          "Permission granted"
        );
        
        return { granted: true, role: result.role, context: result.context };
      } catch (error) {
        return { granted: false, reason: "Permission check error" };
      }
    });

    if (!permissionResult.granted) {
      // Emit Denied
      const denialReason =
        (permissionResult as any).reason || "Permission denied";
      await step.run("emit-denied", async () => {
        await inngest.send({
          name: eventName.replace(".requested", ".denied"),
          data: { ...data, denialReason },
          user: { id: userId },
        });
      });
      return { status: "denied", reason: denialReason };
    }

    // 2. Policy Check (Business Logic / AI)
    const policyResult = await step.run("check-policy", async () => {
      // AI Logic: If source is AI, check workspace settings
      if (source === "ai") {
        const { getDb, workspaces, eq } = await import("@synap/database");
        const db = await getDb();

        const [ws] = workspaceId
          ? await db
              .select()
              .from(workspaces)
              .where(eq(workspaces.id, workspaceId))
              .limit(1)
          : [];
        const aiAutoApprove = (ws?.settings as any)?.aiAutoApprove || false;

        if (!aiAutoApprove) {
          return { approved: false, reason: "AI proposal requires review" };
        }
      }

      // Default: Auto-Approve user actions if they have permission
      return { approved: true, reason: "User authorized" };
    });

    // 3. Path A: Auto-Approve → Emit Validated
    if (policyResult.approved) {
      // Always emit *.validated - executors will handle execution
      const validatedEventName = eventName.replace(".requested", ".validated");

      await step.run("emit-validated", async () => {
        await inngest.send({
          name: validatedEventName,
          data: event.data,
          user: event.user,
        });
      });

      return { status: "validated", event: validatedEventName };
    }

    // 4. Path B: Create Proposal (Pending)
    const proposalResult = await step.run("create-proposal", async () => {
      const targetId = (data.documentId ||
        data.entityId ||
        data.id ||
        randomUUID()) as string;
      const singularType = targetType.endsWith("s")
        ? targetType.slice(0, -1)
        : targetType;

      const [proposal] = await db
        .insert(proposals)
        .values({
          workspaceId: workspaceId || "personal",
          targetType: singularType,
          targetId,
          request: {
            requestId: randomUUID(),
            source: source,
            sourceId: userId,
            targetType: singularType as any,
            targetId,
            changeType: action as any,
            data: data,
            reasoning: policyResult.reason,
            // Pass through AI metadata for frontend display
            aiMetadata: (data as any).aiMetadata,
          },
          status: "pending",
        })
        .returning();

      return { proposalId: proposal.id, singularType };
    });

    // 5. Notify Frontend (Real-time)
    if (proposalResult?.proposalId) {
      await step.run("broadcast-proposal", async () => {
        const { broadcastNotification } =
          await import("../utils/realtime-broadcast.js");
        // Notify the user who requested it (if different?) or just the workspace "inbox"?
        // For now, notify the requester so they know it's pending.
        // Also notify workspace owners? That's complex logic.
        // Let's stick to notifying the user context for now.

        await broadcastNotification({
          userId,
          requestId: data.requestId || event.id,
          message: {
            type: "proposal:created", // Frontend listens to this
            data: {
              proposalId: proposalResult.proposalId,
              targetType: proposalResult.singularType,
              targetId: (data.documentId ||
                data.entityId ||
                data.id ||
                randomUUID()) as string,
              changeType: action,
              status: "pending",
            },
            requestId: data.requestId,
            status: "success", // It was successfully *proposed*
            timestamp: new Date().toISOString(),
          },
        });
      });
    }

    return {
      status: "proposal_created",
      proposalId: proposalResult.proposalId,
    };
  },
);
