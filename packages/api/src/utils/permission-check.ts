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

import { db, proposals, eq, entities } from "@synap/database";
import { users, workspaces, ProposalStatus } from "@synap/database/schema";
import { randomUUID } from "crypto";
import { createLogger } from "@synap-core/core";
import type { RequestShapedProposalData } from "@synap-core/types";
import { isLikelyUUID } from "@synap-core/types/proposals";
import { broadcastNotification } from "@synap/jobs";
import { emitSideEffects } from "@synap/events";
import type { WorkspaceSettings, AgentMetadata } from "@synap/database/schema";
import { NotificationService } from "../notifications/NotificationService.js";
import { deriveAuthorshipMode } from "../services/agent-identity-service.js";

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
 * Administrative actions that always require a proposal, regardless of
 * workspace auto-approve overrides, writesRequireProposal flag, or whitelist.
 * Even a twin agent (writesRequireProposal=false) must propose these.
 */
export const ADMIN_ACTIONS: readonly string[] = [
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
      navigationPermissions: settings?.aiGovernance?.navigationPermissions ?? {
        autoApprove: false,
        allowedResourceTypes: ["entity", "view", "doc", "cell", "channel"],
      },
    },
    source: override ? "workspace" : "default",
    defaults: {
      autoApproveFor: DEFAULT_AUTO_APPROVE,
    },
  };
}

/** The kind of authenticated principal that issued a request. */
export type IssuerKind =
  | "operator"
  | "agent"
  | "connector"
  | "view"
  | "unknown";

/**
 * The authenticated principal that issued this request, established at the AUTH
 * BOUNDARY (the credential the request arrived with, plus server-side trust
 * records for views/connectors) — NEVER from the request body.
 *
 * Authorization rule: an issuer with `trusted: false` always routes to a
 * proposal (after RBAC), regardless of `source`, even if it rides a permitted
 * user's role. This is how a sandboxed/untrusted view or connector is governed
 * without weakening RBAC. An absent `issuer` preserves legacy behavior, so
 * existing call sites that do not yet declare an issuer are unchanged.
 *
 * `source` stays audit-only provenance and must not gate authorization.
 */
export interface IssuerTrust {
  kind: IssuerKind;
  /**
   * True only when the issuer is provably trusted: a genuine operator session,
   * or a server-verified trusted view/connector. Untrusted → propose.
   */
  trusted: boolean;
}

export interface PermissionCheckOpts {
  userId: string;
  agentUserId?: string;
  /** Pass null for workspace-less (hydration / pod-wide personal) operations. */
  workspaceId?: string | null;
  subjectType: string;
  action: string;
  source?: string;
  /**
   * Authenticated issuer + its server-resolved trust. When `trusted: false`,
   * the action is routed to a proposal after RBAC. Absent → legacy behavior.
   * Set this from the auth boundary, never from request-body fields.
   */
  issuer?: IssuerTrust;
  data: Record<string, unknown>;
  /** Correlation ID linking this check to the .requested event */
  correlationId?: string;
  /** Concrete .requested event ID when the caller already appended one. */
  requestedEventId?: string;
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
 * 5b. Untrusted issuer (issuer.trusted === false) → proposal, after RBAC,
 *     regardless of source. Absent issuer → legacy behavior.
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
    requestedEventId,
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

    // 4b. Untrusted issuer → always propose (after RBAC, before any other policy).
    //
    // Trust is established at the auth boundary (the authenticated principal +
    // server-side records), NOT from the request body. An untrusted issuer —
    // e.g. a sandboxed marketplace or AI-generated view — can never write
    // directly even when it rides a permitted user's RBAC; it routes to a
    // reviewable proposal. Absent `issuer` preserves legacy behavior.
    if (opts.issuer && opts.issuer.trusted === false) {
      return createProposal({
        userId,
        agentUserId,
        workspaceId,
        subjectType,
        action,
        source,
        data,
        correlationId,
        requestedEventId,
        reasoning: opts.reasoning,
        threadId,
        commandRunId,
        sourceMessageId,
      });
    }

    // 5. AI policy check
    //
    // Agent user path: agentUserId is the canonical signal that this is an AI action.
    // Source field is just metadata — not used to gate behaviour here.
    if (agentUserId) {
      // Confirm the user row is actually an agent (defence-in-depth)
      const [agentUser] = await db
        .select({
          userType: users.userType,
          agentMetadata: users.agentMetadata,
        })
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

        const eventKey = `${subjectType}.${action}`;

        // CBAC: if this agent has an explicit capabilities allowlist, enforce it.
        // Empty/absent capabilities = unrestricted (backwards compatibility).
        // Supports exact match ("entity.create") and wildcard ("entity.*", "*.*").
        const agentCapabilities = (
          agentUser.agentMetadata as AgentMetadata | null
        )?.capabilities;
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

        // ADMIN_ACTIONS: always propose, regardless of whitelist, workspace
        // overrides, or writesRequireProposal. Even twin agents must propose.
        if (ADMIN_ACTIONS.includes(eventKey)) {
          return createProposal({
            userId,
            agentUserId,
            workspaceId,
            subjectType,
            action,
            source,
            data,
            correlationId,
            requestedEventId,
            reasoning:
              opts.reasoning ??
              "Administrative action requires human approval.",
            threadId,
            commandRunId,
            sourceMessageId,
          });
        }

        // writesRequireProposal: assistant-template agents always propose on
        // writes. Pure reads (*.read, search.*, context.*, memory.*) are exempt.
        const agentMetadata = agentUser.agentMetadata;
        if (agentMetadata?.writesRequireProposal === true) {
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
            return createProposal({
              userId,
              agentUserId,
              workspaceId,
              subjectType,
              action,
              source,
              data,
              correlationId,
              requestedEventId,
              reasoning:
                opts.reasoning ??
                "Agent requires proposal for all write operations.",
              threadId,
              commandRunId,
              sourceMessageId,
            });
          }
        }

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
            requestedEventId,
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

        const isAutoApproved = autoApproveFor.some((pattern) =>
          pattern.endsWith(".*")
            ? eventKey.startsWith(pattern.slice(0, -2))
            : eventKey === pattern
        );

        if (isAutoApproved) {
          // Audit trail: record auto-approved action (non-blocking, non-critical)
          const authorshipMode = deriveAuthorshipMode(userId, agentUserId);
          db.insert(proposals)
            .values({
              workspaceId,
              targetType: subjectType,
              targetId: String(data?.id ?? randomUUID()),
              proposalType: `${subjectType}.${action}`,
              data: {
                ...data,
                agentUserId,
                ...(authorshipMode ? { authorshipMode } : {}),
                ...(correlationId ? { correlationId } : {}),
                ...(requestedEventId ? { requestedEventId } : {}),
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
              ...(agentUserId ? { agentUserId } : {}),
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
          requestedEventId,
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
          requestedEventId,
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
  const label = (data.targetName || data.title || data.name || data.slug) as
    | string
    | undefined;
  if (label) return `${actionVerb} ${subjectType} "${label}"`;
  if (action === "delete" && data.id) return `${actionVerb} ${subjectType}`;
  return `${actionVerb} ${subjectType}`;
}

/**
 * Build the envelope of fields returned on any "proposed" response. Used both
 * by `createProposal()` (via the perm helper) and by event-backed proposal
 * callers that need to return the same review URL/summary envelope.
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

export interface CreatePendingProposalInput {
  userId: string;
  workspaceId: string | null;
  targetType: string;
  targetId: string;
  proposalType: string;
  data: Record<string, unknown>;
  agentUserId?: string | null;
  createdBy?: string | null;
  threadId?: string | null;
  commandRunId?: string | null;
  sourceMessageId?: string | null;
  expiresAt?: Date | null;
  notificationDescription?: string;
}

/**
 * Canonical pending proposal insert path.
 *
 * Permission-gated mutations and explicit proposal requests both use this so
 * notifications, proposal_event automation hooks, provenance, and expiry stay
 * consistent.
 */
export async function createPendingProposal(input: CreatePendingProposalInput) {
  const [proposal] = await db
    .insert(proposals)
    .values({
      workspaceId: input.workspaceId,
      targetType: input.targetType,
      targetId: input.targetId,
      proposalType: input.proposalType,
      data: input.data,
      status: ProposalStatus.PENDING,
      createdBy: input.createdBy ?? input.agentUserId ?? input.userId,
      expiresAt:
        input.expiresAt ??
        new Date(Date.now() + PROPOSAL_TTL_DAYS * 24 * 60 * 60 * 1000),
      ...(input.agentUserId ? { agentUserId: input.agentUserId } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.commandRunId ? { commandRunId: input.commandRunId } : {}),
      ...(input.sourceMessageId
        ? { sourceMessageId: input.sourceMessageId }
        : {}),
    })
    .returning();

  try {
    const requestId =
      typeof input.data.requestId === "string"
        ? input.data.requestId
        : proposal.id;
    await broadcastNotification({
      userId: input.userId,
      requestId,
      message: {
        type: "proposal:created",
        data: {
          proposalId: proposal.id,
          targetType: input.targetType,
          targetId: input.targetId,
          changeType: input.proposalType,
          status: ProposalStatus.PENDING,
        },
        requestId,
        status: "success",
        timestamp: new Date().toISOString(),
      },
    });
  } catch {
    // Broadcast failure is non-critical.
  }

  emitSideEffects({
    subjectType: "proposal",
    action: "created",
    subjectId: proposal.id,
    userId: input.userId,
    workspaceId: input.workspaceId ?? undefined,
    data: {
      proposalStatus: "created",
      targetType: input.targetType,
      changeType: input.proposalType,
      correlationId:
        typeof input.data.correlationId === "string"
          ? input.data.correlationId
          : undefined,
      requestedEventId:
        typeof input.data.requestedEventId === "string"
          ? input.data.requestedEventId
          : undefined,
    },
  });

  if (input.workspaceId) {
    NotificationService.fromProposal({
      proposalId: proposal.id,
      workspaceId: input.workspaceId,
      userId: input.userId,
      proposalType: `${input.targetType}.${input.proposalType}`,
      description:
        input.notificationDescription ??
        `${input.proposalType} ${input.targetType}`,
      agentUserId: input.agentUserId ?? undefined,
    }).catch(() => {});
  }

  return proposal;
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
  requestedEventId?: string;
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
    requestedEventId,
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
  const targetName = await resolveProposalTargetName(
    singularType,
    targetId,
    data
  );
  const summary = buildProposalSummary(singularType, action, {
    ...data,
    ...(targetName ? { targetName } : {}),
  });

  const proposalData: RequestShapedProposalData = {
    requestId: randomUUID(),
    source: (source || "intelligence") as RequestShapedProposalData["source"],
    sourceId: userId,
    workspaceId,
    targetType: singularType as RequestShapedProposalData["targetType"],
    targetId,
    ...(targetName ? { targetName } : {}),
    changeType: action as RequestShapedProposalData["changeType"],
    data,
    reasoning: reasoning || "AI proposal requires review",
    summary,
    ...(correlationId ? { correlationId } : {}),
    ...(requestedEventId ? { requestedEventId } : {}),
  };

  const authorshipMode = deriveAuthorshipMode(userId, agentUserId);
  const proposal = await createPendingProposal({
    userId,
    workspaceId,
    targetType: singularType,
    targetId,
    proposalType: action,
    data: {
      ...(proposalData as unknown as Record<string, unknown>),
      ...(authorshipMode ? { authorshipMode } : {}),
    },
    agentUserId: agentUserId ?? undefined,
    createdBy: userId,
    threadId: threadId ?? null,
    commandRunId: commandRunId ?? null,
    sourceMessageId: sourceMessageId ?? null,
    notificationDescription: reasoning ?? `${action} ${singularType}`,
  });

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

async function resolveProposalTargetName(
  subjectType: string,
  targetId: string,
  data: Record<string, unknown>
): Promise<string | undefined> {
  const inline =
    stringField(data, "title") ??
    stringField(data, "name") ??
    stringField(data, "displayName") ??
    stringField(data, "label");
  if (inline) return inline;

  if (subjectType !== "entity" || !isLikelyUUID(targetId)) return undefined;

  try {
    const [entity] = await db
      .select({ title: entities.title, preview: entities.preview })
      .from(entities)
      .where(eq(entities.id, targetId))
      .limit(1);
    return entity?.title ?? entity?.preview ?? undefined;
  } catch {
    return undefined;
  }
}

function stringField(
  record: Record<string, unknown>,
  key: string
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}
