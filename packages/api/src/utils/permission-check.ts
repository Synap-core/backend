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
import { broadcastNotification, emitSideEffects } from "@synap/jobs";
import type { WorkspaceSettings } from "@synap/database/schema";
import { notifyProposalViaTelegram } from "./telegram-notify.js";
import { NotificationService } from "../notifications/NotificationService.js";

const logger = createLogger({ module: "permission-check" });

/**
 * Filesystem paths that are ALWAYS blocked for external agent writes,
 * regardless of user approval or workspace settings.
 *
 * This is the backend enforcement layer. The synap-os skill also enforces these
 * rules on the OpenClaw side (first line of defence).
 *
 * Pattern semantics:
 *   - /i flag: case-insensitive matching
 *   - Anchored at start where relevant to avoid partial matches
 */
const BLOCKED_FILESYSTEM_PATHS: RegExp[] = [
  // Synap internal directories
  /synap[-_]backend/i,
  /synap[-_]intelligence/i,
  /synap[-_]realtime/i,
  // Container / deployment config
  /docker-compose/i,
  /\.env(?:\.|$)/,
  /\.env\.local/,
  /\.env\.production/,
  // System directories
  /^\/etc\//,
  /^\/usr\//,
  /^\/bin\//,
  /^\/sbin\//,
  /^\/root\//,
  /^\/sys\//,
  /^\/proc\//,
  /^\/dev\//,
  // Key files
  /private\.key/i,
  /\.pem$/i,
  /id_rsa/i,
  /authorized_keys/i,
];

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
 *    a. Agent user → check autoApproveFor whitelist; DEFAULT is proposal unless event matches
 *       Default whitelist (when field absent): search.*, memory.recall, entity.read, document.read
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

  // 1a. Filesystem path blocklist — enforced before any role check.
  // These paths are hard-blocked regardless of user approval or workspace settings.
  // This is a defence-in-depth layer: the synap-os skill also enforces these rules.
  if (subjectType === "filesystem" && data?.path) {
    const path = String(data.path);
    const isBlocked = BLOCKED_FILESYSTEM_PATHS.some((re) => re.test(path));
    if (isBlocked) {
      logger.warn(
        { path, userId, workspaceId },
        "Filesystem path blocked by security policy"
      );
      return {
        denied: true,
        reason: "Path is blocked by Synap security policy.",
      };
    }
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
    //
    // Agent user path: agentUserId is the canonical signal that this is an AI action.
    // Source field is just metadata — not used to gate behaviour here.
    if (agentUserId) {
      // Confirm the user row is actually an agent (defence-in-depth)
      const [agentUser] = await db
        .select({ userType: users.userType })
        .from(users)
        .where(eq(users.id, agentUserId))
        .limit(1);

      if (agentUser?.userType === "agent") {
        // Agent user: permission already verified via role above.
        // DEFAULT: all agent actions require a proposal.
        // EXCEPTION: actions listed in autoApproveFor whitelist bypass proposal.
        const [ws] = await db
          .select({ settings: workspaces.settings })
          .from(workspaces)
          .where(eq(workspaces.id, workspaceId))
          .limit(1);

        const settings = ws?.settings as WorkspaceSettings | undefined;

        // In agent-owned workspaces, destructive actions always go through
        // proposals — even if the agent holds the owner role or the action
        // appears in the auto-approve whitelist. The human admin is the sole
        // authority for irreversible operations.
        if (
          settings?.governanceMode === "agent-owned" &&
          (action === "delete" || action === "archive" || action === "purge")
        ) {
          return createProposal({
            userId,
            agentUserId,
            workspaceId,
            subjectType,
            action,
            source,
            data,
            correlationId,
            reasoning:
              opts.reasoning ??
              "Destructive action in agent-owned workspace requires human approval.",
            threadId,
            commandRunId,
            sourceMessageId,
          });
        }

        // Default whitelist: read-only + safe context-tracking + schema evolution operations.
        // "context.*" covers linkEntity / linkDocument (thread context metadata, not state changes).
        // "filesystem.read" is safe — agents can read files without proposals.
        // "filesystem.write_workspace" is safe — OpenClaw's own ~/openclaw/workspace/ directory.
        // "view.create" — agents create views freely; view.update requires proposal.
        // "profile.create/update" — schema evolution is non-destructive and reversible.
        // "property_def.create/update" — adding/renaming fields is safe; no delete exposed.
        const DEFAULT_AUTO_APPROVE = [
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
          "entity.create", // AI creates entities during workspace setup
          "entity.update", // AI updates entity schemas/properties
          "document.create", // AI creates documents
          "relation.create", // AI creates relations between entities
          "channel.create", // AI creates AI thread channels
          "terminal.read_logs", // AI reads pod service logs (read-only, no side effects)
        ];
        const autoApproveFor =
          settings?.aiGovernance?.autoApproveFor ?? DEFAULT_AUTO_APPROVE;

        const eventKey = `${subjectType}.${action}`;
        const isAutoApproved = autoApproveFor.some((pattern) =>
          pattern.endsWith(".*")
            ? eventKey.startsWith(pattern.slice(0, -2))
            : eventKey === pattern
        );

        if (isAutoApproved) {
          // Audit trail: record auto-approved action (non-blocking, non-critical)
          db.insert(proposals)
            .values({
              workspaceId,
              targetType: subjectType,
              targetId: String(data?.id ?? randomUUID()),
              proposalType: `${subjectType}.${action}`,
              data: {
                ...data,
                agentUserId,
                _autoApprove: {
                  matchedPattern: autoApproveFor.find((p) =>
                    p.endsWith(".*")
                      ? eventKey.startsWith(p.slice(0, -2))
                      : eventKey === p
                  ),
                  approvedAt: new Date().toISOString(),
                  approvedBy: "system:auto_approve",
                },
              },
              status: ProposalStatus.AUTO_APPROVED,
              createdBy: agentUserId,
              threadId: threadId as any,
              commandRunId: commandRunId as any,
            })
            .catch(() => {}); // non-critical — never block the operation

          return { granted: true };
        }

        // Default: agent action requires a proposal
        return createProposal({
          userId,
          agentUserId,
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

    // Legacy AI source path (no agent user row, but caller signals AI-sourced action).
    // Use the legacy aiAutoApprove workspace toggle.
    if (source === "ai" || source === "intelligence") {
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
          agentUserId,
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

/** Proposals auto-expire after this many days if not reviewed. */
const PROPOSAL_TTL_DAYS = 30;

/**
 * Create a proposal for an AI-sourced action that requires review.
 */
async function createProposal(opts: {
  userId: string;
  agentUserId?: string;
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
    agentUserId,
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
      expiresAt: new Date(Date.now() + PROPOSAL_TTL_DAYS * 24 * 60 * 60 * 1000),
      ...(agentUserId ? { agentUserId } : {}),
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

  // Automation side-effects: proposal.created.completed for proposal_event triggers
  emitSideEffects({
    subjectType: "proposal",
    action: "created",
    subjectId: proposal.id,
    userId,
    workspaceId,
    data: { proposalStatus: "created" },
  });

  // Telegram push notification (fire-and-forget, non-critical)
  notifyProposalViaTelegram({
    userId,
    proposalId: proposal.id,
    targetType: singularType,
    action,
    reasoning,
    workspaceId,
  }).catch(() => {});

  // Unified notification system — persist to notifications table + emit notification:new
  NotificationService.fromProposal({
    proposalId: proposal.id,
    workspaceId,
    userId,
    proposalType: `${singularType}.${action}`,
    description: reasoning ?? `${action} ${singularType}`,
    agentUserId: agentUserId ?? undefined,
  }).catch(() => {});

  return { granted: false, proposalId: proposal.id };
}
