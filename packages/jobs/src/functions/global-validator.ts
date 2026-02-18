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
import { db, proposals, sql } from "@synap/database";
import { EventRepository } from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import { randomUUID } from "crypto";
import { createLogger } from "@synap-core/core";
import type { RequestShapedProposalData } from "@synap-core/types";
import {
  createUnifiedEvent,
  extractEventInfo,
  type UnifiedEventData,
} from "../types/unified-events.js";
import type { EnhancedEventMetadata } from "@synap-core/core";

const logger = createLogger({ module: "global-validator" });

/**
 * Shared handler for both globalValidator instances.
 * Inngest dev (self-hosted) limits functions to 10 triggers — we split into two.
 */
async function globalValidatorHandler({
  event,
  step,
}: {
  event: { name: string; data: any; user?: { id: string } };
  step: any;
}) {
  const eventName = event.name as string;

  // Try to extract event info — skip gracefully if event name is non-standard
  let subjectType: string;
  let action: import("../types/unified-events.js").EventAction;
  let phase: import("../types/unified-events.js").EventPhase;
  try {
    const eventInfo = extractEventInfo(eventName);
    subjectType = eventInfo.subjectType;
    action = eventInfo.action;
    phase = eventInfo.phase;
  } catch {
    return { status: "skipped", reason: "Non-standard event format" };
  }

  // Ensure we're handling a requested event
  if (phase !== "requested") {
    logger.warn(
      { eventName, phase },
      "Global validator received non-requested event"
    );
    return { status: "skipped", reason: "Not a requested event" };
  }

  const userId = event.user?.id || event.data.userId;
  const workspaceId = event.data.workspaceId;
  const source =
    event.data.source || (event.data.metadata as any)?.source || "api";
  const data = event.data as UnifiedEventData;
  const metadata = (event.data.metadata || {}) as
    | EnhancedEventMetadata
    | undefined;

  if (!userId) {
    logger.error({ eventName }, "No userId in event - auto-denying");
    return { status: "denied", reason: "No user context" };
  }

  logger.info(
    { eventName, userId, action, subjectType, source },
    "Validating request"
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
      let requiredPermission: "read" | "write" | "delete" | "manage" = "read";

      if (action === "delete") {
        requiredPermission = "delete"; // Requires owner role
      } else if (
        action === "create" ||
        action === "update" ||
        action === "archive" ||
        action === "restore"
      ) {
        requiredPermission = "write"; // Requires editor or owner
      } else {
        // For any other actions (like addMember, removeMember, updateMemberRole)
        // These would need to be handled separately if they exist
        requiredPermission = "write";
      }

      // Projects: Removed projectIds from event data
      // If project permissions are needed, query relations table (type "belongs_to_project")
      // For now, use workspace-only permissions

      // 🔐 NEW: 3-Level Permission Check (workspace-only for now)
      const result = await verifyPermission({
        db,
        userId,
        workspace: { id: workspaceId },
        // Projects: Removed projectIds (use relations table if project permissions needed)
        requiredPermission,
      });

      if (!result.allowed) {
        logger.warn(
          {
            userId,
            workspaceId,
            requiredPermission,
            reason: result.reason,
          },
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
    // Emit Denied using unified event system
    const denialReason =
      (permissionResult as any).reason || "Permission denied";

    await step.run("emit-denied", async () => {
      const eventRepo = new EventRepository(sql);

      // Create denied event
      const deniedEvent = createUnifiedEvent({
        subjectType,
        action,
        phase: "denied",
        subjectId: data.id || "",
        data: {
          ...data,
          reason: denialReason,
        },
        metadata: {
          ...metadata,
          validation: {
            proposalStatus: "rejected",
            reviewedBy: userId,
            reviewNotes: denialReason,
          },
        },
        userId,
        source: source as any,
      });

      // Log to event repository
      await eventRepo.append({
        id: deniedEvent.id,
        version: deniedEvent.version,
        type: deniedEvent.type,
        subjectId: deniedEvent.subjectId,
        subjectType: deniedEvent.subjectType,
        data: deniedEvent.data as Record<string, unknown>,
        metadata: deniedEvent.metadata as Record<string, unknown>,
        userId: deniedEvent.userId,
        source: deniedEvent.source as any,
        timestamp: deniedEvent.timestamp,
      });

      // Send to Inngest
      await inngest.send({
        name: deniedEvent.type,
        data: deniedEvent.data,
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
    await step.run("emit-validated", async () => {
      const eventRepo = new EventRepository(sql);

      // Create validated event using unified event system
      const validatedEvent = createUnifiedEvent({
        subjectType,
        action,
        phase: "validated",
        subjectId: data.id || "",
        data,
        metadata: {
          ...metadata,
          validation: {
            autoApproved: true,
            autoApproveReason: policyResult.reason,
            validationPolicy: {
              source: "global-default" as any,
              requiresValidation: false,
              reason: policyResult.reason,
            },
          },
          user: {
            action: "direct",
            platform: "web",
          },
        },
        userId,
        source: source as any,
      });

      // Log to event repository
      await eventRepo.append({
        id: validatedEvent.id,
        version: validatedEvent.version,
        type: validatedEvent.type,
        subjectId: validatedEvent.subjectId,
        subjectType: validatedEvent.subjectType,
        data: validatedEvent.data as Record<string, unknown>,
        metadata: validatedEvent.metadata as Record<string, unknown>,
        userId: validatedEvent.userId,
        source: validatedEvent.source as any,
        timestamp: validatedEvent.timestamp,
      });

      // Send to executor
      await inngest.send({
        name: validatedEvent.type,
        data: validatedEvent.data,
        user: { id: userId },
      });
    });

    return {
      status: "validated",
      event: `${subjectType}.${action}.validated`,
    };
  }

  // 4. Path B: Create Proposal (Pending)
  const proposalResult = await step.run("create-proposal", async () => {
    const targetId = (data.documentId ||
      data.entityId ||
      data.id ||
      randomUUID()) as string;
    const singularType = subjectType.endsWith("s")
      ? subjectType.slice(0, -1)
      : subjectType;

    const proposalData: RequestShapedProposalData = {
      requestId: randomUUID(),
      source: source as RequestShapedProposalData["source"],
      sourceId: userId,
      workspaceId: workspaceId || "personal",
      targetType: singularType as RequestShapedProposalData["targetType"],
      targetId,
      changeType: action,
      data: data as Record<string, unknown>,
      reasoning: policyResult.reason,
      aiMetadata: metadata?.ai as Record<string, unknown> | undefined,
    };

    const [proposal] = await db
      .insert(proposals)
      .values({
        workspaceId: workspaceId || "personal",
        targetType: singularType,
        targetId,
        proposalType: action,
        data: proposalData,
        status: ProposalStatus.PENDING,
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

      const requestId = (data.requestId as string | undefined) || randomUUID();

      await broadcastNotification({
        userId,
        requestId,
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
            status: ProposalStatus.PENDING,
          },
          requestId,
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
}

// Inngest dev (self-hosted) hard limit: max 10 triggers per function.
// Split the 19 subject-type triggers across two function registrations.

export const globalValidator = inngest.createFunction(
  {
    id: "global-validator",
    name: "Global Validator & Proposal Router",
    retries: 2,
  },
  [
    { event: "entity.*" },
    { event: "document.*" },
    { event: "view.*" },
    { event: "workspace.*" },
    { event: "relation.*" },
    { event: "message.*" },
    { event: "role.*" },
    { event: "apiKey.*" },
    { event: "skill.*" },
    { event: "template.*" },
  ],
  globalValidatorHandler
);

export const globalValidator2 = inngest.createFunction(
  {
    id: "global-validator-2",
    name: "Global Validator & Proposal Router (2)",
    retries: 2,
  },
  [
    { event: "inboxItem.*" },
    { event: "sharing.*" },
    { event: "backgroundTask.*" },
    { event: "agent.*" },
    { event: "chatThread.*" },
    { event: "proposal.*" },
    { event: "project.*" },
    { event: "workspaceMember.*" },
    { event: "projectMember.*" },
  ],
  globalValidatorHandler
);
