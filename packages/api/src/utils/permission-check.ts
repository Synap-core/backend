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

import { db, proposals, eq, and, entities } from "@synap/database";
import {
  users,
  workspaces,
  channelMembers,
  ChannelMemberKind,
  ProposalStatus,
} from "@synap/database/schema";
import { randomUUID } from "crypto";
import { createLogger } from "@synap-core/core";
import type { RequestShapedProposalData } from "@synap-core/types";
import { isLikelyUUID } from "@synap-core/types/proposals";
import { broadcastNotification } from "@synap/jobs";
import { emitSideEffects } from "@synap/events";
import type { WorkspaceSettings, AgentMetadata } from "@synap/database/schema";
import { NotificationService } from "../notifications/NotificationService.js";
import { deriveAuthorshipMode } from "../services/agent-identity-service.js";
import { logEvent } from "../lib/event-helpers.js";
import {
  decideAgentPolicy,
  findMatchingPattern,
  requiredPermissionFor,
  isBlockedFilesystemPath,
  DEFAULT_AUTO_APPROVE,
  DESTRUCTIVE_ACTIONS,
  PROPOSAL_TTL_DAYS,
  type ChannelCapabilityGrant,
} from "@synap/governance-policy";

// Back-compat: these governance-policy symbols historically lived in this
// module. Their canonical home is now @synap/governance-policy; re-export so
// existing importers (tests, routers) keep resolving them from here.
export { DEFAULT_AUTO_APPROVE, DESTRUCTIVE_ACTIONS };
export {
  ADMIN_ACTIONS,
  resolveChannelCapabilityDecision,
} from "@synap/governance-policy";
export type { ChannelCapabilityGrant };
export type { ChannelCapabilityDecision } from "@synap/governance-policy";

const logger = createLogger({ module: "permission-check" });

/**
 * Map a proposal's (targetType, proposalType) to the canonical
 * `{subject}.{action}.requested` event type on the spine.
 *
 * This reuses the EXISTING event-sourcing naming — it never invents a new
 * event TYPE. `proposalType` is the action verb the gate received
 * (create / update / delete / archive / …). `edit` is normalized to `update`
 * to stay consistent with the `{subject}.update.requested` spine convention.
 */
export function requestedEventTypeFor(
  targetType: string,
  proposalType: string
): string {
  const subject = targetType.endsWith("s")
    ? targetType.slice(0, -1)
    : targetType;
  const action = proposalType === "edit" ? "update" : proposalType;
  return `${subject}.${action}.requested`;
}

// BLOCKED_FILESYSTEM_PATHS + isBlockedFilesystemPath() moved to
// @synap/governance-policy (single source of truth).

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
 * Before-snapshot of an entity captured at proposal-creation time for UPDATE
 * proposals. Persisted on the proposal's stored `data` as `previousData` so the
 * review layer renders a durable before→after diff. Mirrors the `previousData`
 * field declared on RequestShapedProposalData in @synap-core/types — kept as a
 * local shape so this compiles against the published types dist before it
 * rebuilds with the new field.
 */
type EntityPreviousData = {
  title?: string | null;
  description?: string | null;
  profileSlug?: string | null;
  documentId?: string | null;
  properties?: Record<string, unknown>;
};

/**
 * Base URL of the Synap Studio app where proposals are reviewed.
 * Override via `SYNAP_APP_URL` env var (e.g., self-hosted: `https://app.my-pod.com`).
 * Default: `https://studio.synap.live`.
 */
export const STUDIO_APP_URL =
  process.env.SYNAP_APP_URL?.replace(/\/$/, "") ?? "https://studio.synap.live";

// DEFAULT_AUTO_APPROVE, DESTRUCTIVE_ACTIONS, and ADMIN_ACTIONS moved to
// @synap/governance-policy (imported + re-exported above for back-compat).

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
    navigationPermissions: {
      autoApprove: boolean;
      allowedResourceTypes?: Array<
        "entity" | "view" | "doc" | "cell" | "channel" | "automation"
      >;
    };
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

/**
 * Nominally-typed context carrying a routing-resolved teammate id.
 *
 * The brand (`_routedTeammateCtx`) makes this structurally distinct from a
 * plain `{ teammateId: string }` so callers cannot accidentally pass a
 * request-body field. Instances MUST only be produced by server-side routing
 * logic (mention resolution or IS router response) — never from user input.
 *
 * Analogous to `IssuerTrust`: established at the routing boundary, not from
 * the wire. `resolveChannelCapabilities` / the `channelCapabilities` path
 * consume the teammate id ONLY from here.
 */
export interface RoutedTeammateContext {
  readonly teammateId: string;
  /** How this teammate was selected — used for attribution stamping. */
  readonly source: "mention" | "orchestrator" | "direct";
  /** @internal nominal brand — do not read or copy */
  readonly _routedTeammateCtx: true;
}

/**
 * Construct a `RoutedTeammateContext` from server-resolved routing data.
 * The only factory; all call-sites must use this rather than casting.
 */
export function makeRoutedTeammateContext(
  teammateId: string,
  source: "mention" | "orchestrator" | "direct"
): RoutedTeammateContext {
  return {
    teammateId,
    source,
    _routedTeammateCtx: true,
  };
}

// ChannelCapabilityGrant, ChannelCapabilityDecision, and
// resolveChannelCapabilityDecision moved to @synap/governance-policy
// (imported + re-exported above). The DB lookup resolveChannelCapabilities
// (which reads channel_members) stays here — it needs the database.

/**
 * Resolve the effective per-channel capability grant for an AI teammate from
 * its `channel_members` row.
 *
 * SEAM FOR THE ROUTING PASS: the later per-message routing / multi-responder
 * dispatch resolves which teammate is acting via `RoutedTeammateContext`, then
 * calls this with `ctx.teammateId` to obtain the grant it passes as
 * `channelCapabilities` to `checkPermissionOrPropose`. It is deliberately a
 * pure lookup with a CONSERVATIVE default — if the teammate has no membership
 * row in the channel (unknown), it returns `null`, which the gate treats as
 * "propose, never act".
 *
 * Trust note: pass `ctx.teammateId` from a `RoutedTeammateContext` produced by
 * the routing boundary (`makeRoutedTeammateContext`), never from request-body
 * fields. The `memberId` parameter accepts a plain string so internal callers
 * (addTeammate, tests) can still use it directly.
 */
export async function resolveChannelCapabilities(
  channelId: string,
  memberId: string
): Promise<ChannelCapabilityGrant | null> {
  const [row] = await db
    .select({
      canDraft: channelMembers.canDraft,
      canPropose: channelMembers.canPropose,
      canAct: channelMembers.canAct,
    })
    .from(channelMembers)
    .where(
      and(
        eq(channelMembers.channelId, channelId),
        eq(channelMembers.memberId, memberId),
        eq(channelMembers.memberKind, ChannelMemberKind.AI_AGENT)
      )
    )
    .limit(1);

  // Unknown teammate (no membership) → null → gate resolves to "propose".
  if (!row) return null;

  return {
    canDraft: row.canDraft,
    canPropose: row.canPropose,
    canAct: row.canAct,
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
  /**
   * Effective per-channel capability grant for the acting AI teammate, when the
   * write is evaluated in the context of a multiplayer channel. This is the
   * per-channel layer of governance — it can only TIGHTEN the workspace policy
   * (force a proposal, or block a commit), never bypass it. Absent → no
   * per-channel tightening (legacy / non-room write paths unchanged).
   *
   * Resolve it from `channel_members` via `resolveChannelCapabilities` at the
   * routing seam, never from request-body fields.
   */
  channelCapabilities?: ChannelCapabilityGrant | null;
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
  /** Session ID to link proposals to the active focus session */
  sessionId?: string;
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
    sessionId,
    channelCapabilities,
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
    const isBlocked = isBlockedFilesystemPath(path);
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

  // 2. Determine required permission (canonical map in @synap/governance-policy)
  const requiredPermission = requiredPermissionFor(action);

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
      // PRODUCT DECISION ("agent asks to join"): an agent actor that is not yet
      // a member of the workspace does not hard-deny — instead it files a
      // `workspace.join` proposal the human can approve. Approval materializes a
      // workspace_members row (see materializer `workspace` case) and the agent
      // retries the original write. Any OTHER denial (insufficient role for a
      // member, etc.) still hard-denies. Gated on the membership-miss reason so a
      // member-but-under-privileged agent is NOT silently escalated to a join.
      const isMembershipMiss =
        result.reason === "User is not a member of this workspace";
      if (isMembershipMiss && agentUserId) {
        const join = await maybeCreateWorkspaceJoinProposal({
          agentUserId,
          requesterUserId: userId,
          workspaceId,
          correlationId,
          threadId,
          commandRunId,
          sourceMessageId,
          sessionId,
        });
        if (join) return join;
        // Not an agent user row (defence-in-depth) → fall through to deny.
      }
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
        sessionId,
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
          .select({
            settings: workspaces.settings,
            workspaceType: workspaces.workspaceType,
          })
          .from(workspaces)
          .where(eq(workspaces.id, workspaceId))
          .limit(1);

        const settings = ws?.settings as WorkspaceSettings | undefined;
        const isAgentOwnedWorkspace =
          ws?.workspaceType === "agent" &&
          settings?.linkedAgentId === agentUserId;

        const eventKey = `${subjectType}.${action}`;
        // Pass the raw workspace value (may be undefined) so decideAgentPolicy
        // can distinguish "workspace explicitly set a list" from "no override".
        // Explicit list is checked before writesRequireProposal (overrides it);
        // DEFAULT_AUTO_APPROVE is checked after as the last resort.
        const explicitAutoApproveFor = settings?.aiGovernance?.autoApproveFor;

        // Agent governance policy — SINGLE SOURCE OF TRUTH in
        // @synap/governance-policy. decideAgentPolicy applies the full ladder
        // (CBAC → ADMIN_ACTIONS → isAgentOwnedWorkspace → explicit autoApproveFor
        // → writesRequireProposal → agent-owned mode destructive → per-channel
        // grant → default autoApproveFor → default) and returns the verdict.
        // Side effects stay here.
        // GOVERNANCE BY KIND (user_observation): surface the write subject's
        // profile slug + its `uo_validated` flag to the policy so a user_observation
        // is governed by the nature of the observation (inference vs explicit),
        // not the routing workspace. Both signals ride in the gate `data` payload
        // (entity create/update carries `profileSlug` + `properties`); we read
        // them defensively (absent → rule no-ops in the policy).
        const subjectProfileSlug =
          typeof data?.profileSlug === "string" ? data.profileSlug : undefined;
        const dataProperties = (data?.properties ?? null) as Record<
          string,
          unknown
        > | null;
        const subjectUoValidated =
          typeof dataProperties?.uo_validated === "boolean"
            ? dataProperties.uo_validated
            : undefined;

        const agentMetadata = agentUser.agentMetadata as AgentMetadata | null;
        const decision = decideAgentPolicy({
          subjectType,
          action,
          agentCapabilities: agentMetadata?.capabilities,
          writesRequireProposal: agentMetadata?.writesRequireProposal === true,
          governanceMode: settings?.governanceMode,
          autoApproveFor: explicitAutoApproveFor,
          isAgentOwnedWorkspace,
          channelCapabilities,
          subjectProfileSlug,
          subjectUoValidated,
        });

        if (decision.verdict === "deny") {
          return { denied: true, reason: decision.reason };
        }

        if (decision.verdict === "propose") {
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
            // decision.reason carries the per-branch default reasoning; it is
            // undefined for the plain default-propose case, preserving the prior
            // behavior of passing the caller's reasoning through unchanged.
            reasoning: opts.reasoning ?? decision.reason,
            threadId,
            commandRunId,
            sourceMessageId,
            sessionId,
          });
        }

        // verdict === "execute": auto-approved. Record a secondary audit-trail
        // row, then grant. The PRIMARY durable audit of an auto-approved action
        // is the event spine (the caller still emits `{subject}.{action}`
        // .requested/.completed), so this insert stays NON-BLOCKING — but it
        // must never fail SILENTLY (that was the Wave-B gap), so failures are
        // logged loudly instead of swallowed.
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
                matchedPattern: findMatchingPattern(
                  eventKey,
                  explicitAutoApproveFor ?? DEFAULT_AUTO_APPROVE
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
          .catch((err) =>
            logger.error(
              { err, workspaceId, agentUserId, eventKey },
              "Auto-approve audit-trail row insert failed (write still granted; event spine remains the primary audit)"
            )
          );

        return { granted: true };
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
          sessionId,
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

// PROPOSAL_TTL_DAYS imported from @synap/governance-policy.

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
  correlationId?: string | null;
  requestedEventId?: string | null;
  sessionId?: string | null;
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
/** Drizzle transaction handle — same surface as `db` for our inserts. */
type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Post-commit notifications for a freshly-created pending proposal. Kept SEPARATE
 * from the INSERT so it can run AFTER the transaction commits — we never hold a
 * tx open across this notification network/queue work (would pin a pool conn).
 */
async function notifyProposalCreated(
  proposal: typeof proposals.$inferSelect,
  input: CreatePendingProposalInput
): Promise<void> {
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
}

export async function createPendingProposal(
  input: CreatePendingProposalInput,
  /**
   * Optional transaction handle. When provided, the proposal INSERT runs inside
   * the caller's transaction and notifications are SKIPPED here — the caller must
   * invoke notifyProposalCreated() AFTER the tx commits (see createProposal).
   */
  tx?: DbTx
) {
  const executor = tx ?? db;
  const [proposal] = await executor
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
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      ...(input.requestedEventId
        ? { requestedEventId: input.requestedEventId }
        : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    })
    .returning();

  // Standalone callers get notifications inline; transaction callers run
  // notifyProposalCreated() themselves after commit.
  if (!tx) {
    await notifyProposalCreated(proposal, input);
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
  sessionId?: string;
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
    sessionId,
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

  // Event-spine linkage. The proposal must always be traceable to a
  // `{subject}.{action}.requested` event:
  //   - If the caller already appended one (e.g. the user path), reuse its id
  //     and correlationId — DO NOT emit a second event (dedupe).
  //   - Otherwise (agent / Feature-C / View-SDK paths), emit one here.
  const resolvedCorrelationId = correlationId ?? randomUUID();
  const authorshipMode = deriveAuthorshipMode(userId, agentUserId);

  // Capture a BEFORE-snapshot for entity UPDATE proposals so the review layer can
  // render a durable before→after field diff. Without this the diff relies on the
  // live entity still holding its pre-update state at read time, which breaks once
  // the proposal is approved (entity now mutated) or the entity is edited
  // concurrently. We snapshot ONLY the fields the proposed `data` touches.
  const previousData = await captureEntityPreviousData(
    singularType,
    action,
    targetId,
    data
  );

  // TX-1: append the `.requested` event AND insert the proposal atomically, so a
  // proposal can never exist without its originating spine event (and the
  // correlation linkage is always consistent). BEHAVIOR CHANGE (intentional): a
  // `.requested` append failure now ROLLS BACK the proposal instead of being
  // swallowed — an un-traceable proposal is worse than a surfaced error.
  // Notifications run AFTER commit (never hold the tx across network/queue work).
  const { proposal, pendingInput } = await db.transaction(async (tx) => {
    let reqEventId = requestedEventId;
    if (!reqEventId) {
      reqEventId = await logEvent(
        userId,
        requestedEventTypeFor(singularType, action),
        { targetId, ...(targetName ? { targetName } : {}), summary },
        {
          subjectId: targetId,
          subjectType: singularType,
          source: source ?? "api",
          metadata: { correlationId: resolvedCorrelationId },
        },
        tx
      );
    }

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
      reasoning:
        reasoning || `${action} ${singularType} requires your approval`,
      summary,
      correlationId: resolvedCorrelationId,
      ...(reqEventId ? { requestedEventId: reqEventId } : {}),
      ...(previousData ? { previousData } : {}),
    };

    const pendingInput: CreatePendingProposalInput = {
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
      sessionId: sessionId ?? null,
      correlationId: resolvedCorrelationId,
      requestedEventId: reqEventId ?? null,
      notificationDescription: reasoning ?? `${action} ${singularType}`,
    };

    const created = await createPendingProposal(pendingInput, tx);
    return { proposal: created, pendingInput };
  });

  // Post-commit notifications (broadcast / side-effects / notification center).
  await notifyProposalCreated(proposal, pendingInput);

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

/**
 * Workspace-join proposal: an agent actor that is not yet a member of the
 * workspace files this instead of being hard-denied. On approval the
 * materializer (`workspace` case) inserts the workspace_members row.
 *
 * Returns the standard proposed envelope, or `null` when the actor is NOT an
 * agent user row (so the caller falls through to a hard deny). DEDUPE: if a
 * pending `workspace.join` proposal already exists for (agentUserId,
 * workspaceId), its id is returned rather than creating a second one.
 */
async function maybeCreateWorkspaceJoinProposal(opts: {
  agentUserId: string;
  requesterUserId: string;
  workspaceId: string;
  correlationId?: string;
  threadId?: string;
  commandRunId?: string;
  sourceMessageId?: string;
  sessionId?: string;
}): Promise<PermissionResult | null> {
  const {
    agentUserId,
    requesterUserId,
    workspaceId,
    correlationId,
    threadId,
    commandRunId,
    sourceMessageId,
    sessionId,
  } = opts;

  // Defence-in-depth: confirm the actor really is an agent user row before
  // minting a join proposal on its behalf.
  const [agentUser] = await db
    .select({ userType: users.userType, name: users.name })
    .from(users)
    .where(eq(users.id, agentUserId))
    .limit(1);
  if (agentUser?.userType !== "agent") return null;

  const role = "editor";
  const [ws] = await db
    .select({ name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  const agentName = agentUser.name ?? "Agent";
  const workspaceName = ws?.name ?? workspaceId;
  const summary = `Agent ${agentName} requests to join workspace ${workspaceName} as ${role}`;

  // DEDUPE: return an existing pending join proposal for this (agent, workspace)
  // rather than stacking duplicates each time the agent retries the write.
  const [existing] = await db
    .select({ id: proposals.id })
    .from(proposals)
    .where(
      and(
        eq(proposals.workspaceId, workspaceId),
        eq(proposals.targetType, "workspace"),
        eq(proposals.proposalType, "join"),
        eq(proposals.agentUserId, agentUserId),
        eq(proposals.status, ProposalStatus.PENDING)
      )
    )
    .limit(1);

  if (existing) {
    return {
      granted: false,
      proposalId: existing.id,
      summary,
      reasoning: summary,
      reviewPath: `/proposals/${existing.id}`,
      reviewUrl: `${STUDIO_APP_URL}/proposals/${existing.id}`,
    };
  }

  const { createEventBackedProposal } =
    await import("./event-backed-proposal.js");
  const { proposal: row } = await createEventBackedProposal({
    userId: requesterUserId,
    workspaceId,
    targetType: "workspace",
    targetId: workspaceId,
    proposalType: "join",
    action: "join",
    source: "intelligence",
    summary,
    agentUserId,
    createdBy: agentUserId,
    threadId: threadId ?? null,
    commandRunId: commandRunId ?? null,
    sourceMessageId: sourceMessageId ?? null,
    sessionId: sessionId ?? null,
    data: {
      role,
      agentUserId,
      requestedBy: "ai",
      source: "agent",
      ...(correlationId ? { correlationId } : {}),
    },
  });

  return {
    granted: false,
    proposalId: row.id,
    summary,
    reasoning: summary,
    reviewPath: `/proposals/${row.id}`,
    reviewUrl: `${STUDIO_APP_URL}/proposals/${row.id}`,
  };
}

/**
 * Snapshot the BEFORE state of an entity for an UPDATE proposal, scoped to the
 * fields the proposed `data` actually touches. Returns `undefined` for any
 * non-entity / non-update target, when the targetId is not a real entity UUID,
 * or when the entity can't be loaded (best-effort — never blocks proposal
 * creation). The shape mirrors `RequestShapedProposalData["previousData"]`.
 */
async function captureEntityPreviousData(
  subjectType: string,
  action: string,
  targetId: string,
  data: Record<string, unknown>
): Promise<EntityPreviousData | undefined> {
  const normalizedAction = action === "edit" ? "update" : action;
  if (subjectType !== "entity" || normalizedAction !== "update")
    return undefined;
  if (!isLikelyUUID(targetId)) return undefined;

  try {
    const [entity] = await db
      .select({
        title: entities.title,
        preview: entities.preview,
        type: entities.type,
        documentId: entities.documentId,
        properties: entities.properties,
      })
      .from(entities)
      .where(eq(entities.id, targetId))
      .limit(1);
    if (!entity) return undefined;

    const snapshot: EntityPreviousData = {};
    if (data.title !== undefined) snapshot.title = entity.title ?? null;
    if (data.description !== undefined)
      snapshot.description = entity.preview ?? null;
    if (data.profileSlug !== undefined)
      snapshot.profileSlug = entity.type ?? null;
    if (data.documentId !== undefined)
      snapshot.documentId = entity.documentId ?? null;

    // Snapshot only the property keys the proposal sets or deletes, so the
    // before-map stays scoped to what actually changes.
    const proposedProps =
      data.properties && typeof data.properties === "object"
        ? (data.properties as Record<string, unknown>)
        : {};
    const deleteKeys = Array.isArray(data.deleteProperties)
      ? (data.deleteProperties as unknown[]).filter(
          (k): k is string => typeof k === "string"
        )
      : [];
    const touchedKeys = new Set<string>([
      ...Object.keys(proposedProps),
      ...deleteKeys,
    ]);
    if (touchedKeys.size > 0) {
      const currentProps =
        entity.properties && typeof entity.properties === "object"
          ? (entity.properties as Record<string, unknown>)
          : {};
      const beforeProps: Record<string, unknown> = {};
      for (const key of touchedKeys) {
        beforeProps[key] = currentProps[key];
      }
      snapshot.properties = beforeProps;
    }

    return Object.keys(snapshot).length > 0 ? snapshot : undefined;
  } catch (err) {
    logger.warn(
      { err, targetId },
      "captureEntityPreviousData failed (proposal created without before-snapshot)"
    );
    return undefined;
  }
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
