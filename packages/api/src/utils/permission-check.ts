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

import { db, proposals, eq } from "@synap/database";
import { users, workspaces, ProposalStatus } from "@synap/database/schema";
import { randomUUID } from "crypto";
import { createLogger } from "@synap-core/core";
import type { RequestShapedProposalData } from "@synap-core/types";
import { broadcastNotification, emitSideEffects } from "@synap/jobs";
import type { WorkspaceSettings } from "@synap/database/schema";
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
  | {
      granted: false;
      proposalId: string;
      /** Short human-readable summary: e.g., `Delete task "Q2 plan review"`. */
      summary: string;
      /** The AI's reasoning, echoed back so callers can surface it to the user. */
      reasoning: string;
      /** Pod-relative path for the review UI: `/proposals/{id}`. */
      reviewPath: string;
      /** Absolute URL to review the proposal (e.g., studio.synap.live). */
      reviewUrl: string;
    }
  | { denied: true; reason: string };

/**
 * Base URL of the Synap Studio app where proposals are reviewed.
 * Override via `SYNAP_APP_URL` env var (e.g., self-hosted: `https://app.my-pod.com`).
 * Default: `https://studio.synap.live`.
 */
export const STUDIO_APP_URL =
  process.env.SYNAP_APP_URL?.replace(/\/$/, "") ?? "https://studio.synap.live";

/**
 * Default whitelist: agent actions that bypass proposal review.
 *
 * Workspaces can override via `settings.aiGovernance.autoApproveFor`.
 * When `settings.governanceMode === "agent-owned"`, destructive actions
 * (delete/archive/purge) always propose regardless of this list.
 *
 * Format: "<subjectType>.<action>" or "<subjectType>.*" glob.
 */
export const DEFAULT_AUTO_APPROVE: readonly string[] = [
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

/**
 * Actions that always require a proposal in agent-owned workspaces,
 * regardless of whitelist configuration.
 */
export const DESTRUCTIVE_ACTIONS: readonly string[] = [
  "delete",
  "archive",
  "purge",
];

/**
 * Resolve the effective governance policy for a workspace.
 *
 * Returns the actual whitelist that would be used at runtime, plus metadata
 * about whether it's the default or a workspace override. Used by:
 *   - GET /api/hub/workspaces/:id/governance (client-facing introspection)
 *   - skills (to tell the user what will be auto-approved vs proposed)
 */
export async function getEffectiveGovernance(workspaceId: string): Promise<{
  workspaceId: string;
  effective: {
    autoApproveFor: readonly string[];
    governanceMode: "default" | "agent-owned";
    proposalApprovalPolicy: "owner_and_admins" | "any_editor" | "admins_only";
    destructiveAlwaysPropose: boolean;
    destructiveActions: readonly string[];
  };
  source: "workspace" | "default";
  defaults: {
    autoApproveFor: readonly string[];
  };
}> {
  const [ws] = await db
    .select({ settings: workspaces.settings })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);

  const settings = ws?.settings as WorkspaceSettings | undefined;
  const override = settings?.aiGovernance?.autoApproveFor;
  const governanceMode =
    (settings as Record<string, unknown> | undefined)?.governanceMode ===
    "agent-owned"
      ? "agent-owned"
      : "default";
  const proposalApprovalPolicy =
    settings?.aiGovernance?.proposalApprovalPolicy ?? "owner_and_admins";

  return {
    workspaceId,
    effective: {
      autoApproveFor: override ?? DEFAULT_AUTO_APPROVE,
      governanceMode,
      proposalApprovalPolicy,
      destructiveAlwaysPropose: governanceMode === "agent-owned",
      destructiveActions: DESTRUCTIVE_ACTIONS,
    },
    source: override ? "workspace" : "default",
    defaults: {
      autoApproveFor: DEFAULT_AUTO_APPROVE,
    },
  };
}

export interface PermissionCheckOpts {
  userId: string;
  agentUserId?: string;
  /** Pass null for workspace-less (hydration / pod-wide personal) operations. */
  workspaceId?: string | null;
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

        // Default whitelist: see DEFAULT_AUTO_APPROVE at module scope.
        // Workspace override via settings.aiGovernance.autoApproveFor.
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
              threadId: threadId ?? undefined,
              commandRunId: commandRunId ?? undefined,
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
 * Build a short human-readable summary of what's being proposed.
 * Example: `Create task "Design new onboarding flow"`
 *          `Delete entity ent_abc`
 *          `Update view "Active Tasks"`
 */
export function buildProposalSummary(
  subjectType: string,
  action: string,
  data: Record<string, unknown>
): string {
  const actionVerb = action.charAt(0).toUpperCase() + action.slice(1);
  const label = (data.title || data.name || data.slug || data.id) as
    | string
    | undefined;
  if (label) return `${actionVerb} ${subjectType} "${label}"`;
  return `${actionVerb} ${subjectType}`;
}

/**
 * Build the envelope of fields returned on any "proposed" response. Used both
 * by `createProposal()` (via the perm helper) and by any caller that creates
 * a proposal directly via `db.insert(proposals)`.
 */
export function buildProposalResponseFields(opts: {
  proposalId: string;
  subjectType: string;
  action: string;
  data: Record<string, unknown>;
  reasoning?: string;
}): {
  summary: string;
  reasoning: string;
  reviewPath: string;
  reviewUrl: string;
} {
  const summary = buildProposalSummary(
    opts.subjectType,
    opts.action,
    opts.data
  );
  const reviewPath = `/proposals/${opts.proposalId}`;
  return {
    summary,
    reasoning:
      opts.reasoning ??
      `${opts.action} ${opts.subjectType} requires your approval`,
    reviewPath,
    reviewUrl: `${STUDIO_APP_URL}${reviewPath}`,
  };
}

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
}): Promise<{
  granted: false;
  proposalId: string;
  summary: string;
  reasoning: string;
  reviewPath: string;
  reviewUrl: string;
}> {
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

  // Unified notification system — persist to notifications table + emit notification:new
  NotificationService.fromProposal({
    proposalId: proposal.id,
    workspaceId,
    userId,
    proposalType: `${singularType}.${action}`,
    description: reasoning ?? `${action} ${singularType}`,
    agentUserId: agentUserId ?? undefined,
  }).catch(() => {});

  const summary = buildProposalSummary(singularType, action, data);
  const reviewPath = `/proposals/${proposal.id}`;
  return {
    granted: false,
    proposalId: proposal.id,
    summary,
    reasoning: reasoning ?? `${action} ${singularType} requires your approval`,
    reviewPath,
    reviewUrl: `${STUDIO_APP_URL}${reviewPath}`,
  };
}
