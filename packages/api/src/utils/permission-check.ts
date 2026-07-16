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

import {
  db,
  proposals,
  eq,
  and,
  entities,
  ProfileResolutionService,
  insertPendingProposal,
} from "@synap/database";
import { resolveAgentGovernanceDecision } from "@synap/database/agent-governance";
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
import {
  isLikelyUUID,
  isCompositeProposalData,
} from "@synap-core/types/proposals";
import { broadcastNotification } from "@synap/jobs";
import { emitSideEffects } from "@synap/events";
import type { WorkspaceSettings } from "@synap/database/schema";
import { NotificationService } from "../notifications/NotificationService.js";
import { deriveAuthorshipMode } from "../services/agent-identity-service.js";
import { logEvent } from "../lib/event-helpers.js";
import { openLink, openPath } from "./deep-links.js";
import {
  findMatchingPattern,
  requiredPermissionFor,
  isBlockedFilesystemPath,
  isAutoApproved,
  getWorkspaceGovernanceMode,
  DEFAULT_AUTO_APPROVE,
  DESTRUCTIVE_ACTIONS,
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
      /**
       * The proposal's type: "join" for a workspace-join gate, else
       * "<subject>.<action>" (e.g. "entity.create"). Lets callers distinguish
       * a membership gate from a content proposal.
       */
      proposalType: string;
      /** Short human-readable summary: e.g., `Delete task "Q2 plan review"`. */
      summary: string;
      /** The AI's reasoning, echoed back so callers can surface it to the user. */
      reasoning: string;
      /** Pod-relative path into the app: `/open/{id}`. */
      reviewPath: string;
      /** Absolute clickable link into the app: `${PUBLIC_URL}/open/{id}`. */
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
    getWorkspaceGovernanceMode(settings) === "agent-owned"
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
  /** Active project lens → proposals.project_id → belongs_to_project at materialize */
  projectId?: string | null;
  /**
   * Force a PROPOSAL even when the action would otherwise auto-approve. Set by
   * callers for scope/identity-bearing writes that must always be reviewed
   * (e.g. promoting an entity workspace→pod-wide, or changing its profile TYPE).
   * Honored only on the AI/agent governance paths — a trusted operator is the
   * authority and is never forced to self-propose. RBAC/CBAC denials still take
   * precedence over the forced proposal.
   */
  forcePropose?: boolean;
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
    projectId,
    channelCapabilities,
  } = opts;

  // 1. Pod/owner scope (no workspace lens).
  //
  // A write with NO workspace is pod-scoped: the authenticated bearer owns the
  // pod (matches resolveActingContext role:"owner"). We do NOT auto-grant blindly
  // anymore — the governance ladder below STILL runs so that agent actions are
  // governed pod-wide (DEFAULT_AUTO_APPROVE whitelist + agent-metadata policy),
  // instead of silently bypassing review just because no workspace was supplied.
  // Only the workspace-membership RBAC step is skipped when there is no workspace
  // (there is no membership to verify at pod scope).

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

    // Workspace-membership RBAC — ONLY when a workspace lens is present.
    // At pod scope (no workspace) the authenticated bearer is the owner, so there
    // is no membership to verify; agent governance still runs below.
    if (workspaceId) {
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
            // Thread the original subject + data so the proposal card shows
            // WHAT the agent wanted to do (e.g. create a session with goal X).
            // Without this, every join proposal looks identical — the reviewer
            // can't tell if the agent wants to create a session, write an entity,
            // or execute a capability.
            requestedSubjectType: subjectType,
            requestedAction: action,
            requestedData: data,
          });
          if (join) return join;
          // Not an agent user row (defence-in-depth) → fall through to deny.
        }
        // AGENT + insufficient ROLE (a member, but its role lacks this
        // permission — e.g. an editor agent attempting a destructive `delete`,
        // which needs owner): route to a PROPOSAL rather than hard-denying.
        // Extends the same "agent denial → reviewable proposal" philosophy as
        // the workspace-join branch above — an agent's role gates AUTO
        // execution, not the ability to PROPOSE. The human owner (who DOES hold
        // the permission) authorizes it at approval time. Direct users are NOT
        // affected: a user is the authority, so an under-privileged user is
        // still correctly denied. Guarded to genuine agent user rows.
        if (agentUserId && !isMembershipMiss) {
          const [actorRow] = await db
            .select({ userType: users.userType })
            .from(users)
            .where(eq(users.id, agentUserId))
            .limit(1);
          if (actorRow?.userType === "agent") {
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
                `${action} ${subjectType} exceeds the agent's workspace role (${result.role ?? "member"}) — proposed for your approval`,
              threadId,
              commandRunId,
              sourceMessageId,
              sessionId,
              projectId,
            });
          }
        }

        // HUMAN member with an insufficient ROLE — the "team member proposes →
        // owner approves" loop. A workspace member whose role can't execute this
        // write directly does NOT hard-deny; it files a PROPOSAL a reviewer
        // (owner/admin, or any editor under the `any_editor` policy) can approve.
        // Mirrors the agent branch above, but stamps the human's userId as the
        // proposer (proposedByUserId) instead of an agentUserId.
        //
        // FIREWALLS: (1) genuine human only (no agentUserId — the agent path
        // already returned); (2) confirmed MEMBER only — `result.role` is set
        // only for a member, so a non-member (membership miss → no role) still
        // hard-denies below; (3) never a sandboxed untrusted issuer — those must
        // deny on RBAC failure, not gain propose rights. Reuses the SAME
        // createProposal machinery as every other propose path (NOT the
        // agent-specific governance ladder).
        //
        // POLICY (default, owner-adjustable): propose ONLY when a reviewer OTHER
        // than the proposer exists for this workspace under its approval policy;
        // otherwise nobody could approve it, so hard-deny as before.
        if (
          !agentUserId &&
          result.role &&
          !isMembershipMiss &&
          (!opts.issuer || opts.issuer.trusted !== false)
        ) {
          const { inArray } = await import("@synap/database");
          const { workspaceMembers } = await import("@synap/database/schema");
          const [ws] = await db
            .select({ settings: workspaces.settings })
            .from(workspaces)
            .where(eq(workspaces.id, workspaceId))
            .limit(1);
          const settings = ws?.settings as WorkspaceSettings | undefined;
          const policy =
            settings?.aiGovernance?.proposalApprovalPolicy ??
            "owner_and_admins";
          const reviewerRoles =
            policy === "any_editor"
              ? ["owner", "admin", "editor"]
              : ["owner", "admin"];
          const reviewerRows = await db
            .select({ userId: workspaceMembers.userId })
            .from(workspaceMembers)
            .where(
              and(
                eq(workspaceMembers.workspaceId, workspaceId),
                inArray(workspaceMembers.role, reviewerRoles)
              )
            )
            .limit(5);
          const reviewerExists = reviewerRows.some((r) => r.userId !== userId);

          if (reviewerExists) {
            return createProposal({
              userId,
              proposedByUserId: userId,
              workspaceId,
              subjectType,
              action,
              source,
              data,
              correlationId,
              requestedEventId,
              reasoning:
                opts.reasoning ??
                `${action} ${subjectType} exceeds your workspace role (${result.role}) — proposed for a reviewer's approval`,
              threadId,
              commandRunId,
              sourceMessageId,
              sessionId,
              projectId,
            });
          }
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
        projectId,
      });
    }

    // 4c. GUARDRAIL (fail-fast): an entity CREATE that names a profile which
    // does not exist is rejected HERE — before any proposal is created — so the
    // agent gets immediate, actionable feedback instead of a user accepting a
    // proposal that later throws ProfileNotFoundError at APPLY time (the bug
    // this fixes: an agent proposed profileSlug "partner", which isn't seeded;
    // the accepted apply threw "Profile not found: partner").
    //
    // Scoped precisely: ONLY entity + create + a set profileSlug. It never fires
    // for entity UPDATE (the entity already exists), for other subject types, or
    // when profileSlug is absent (read defensively, mirroring the existing gate).
    //
    // Resolution MIRRORS EntityRepository.create's apply-time
    // `resolveProfile(slug, userId, workspaceId ?? "")` (and the entities router's
    // own direct-create resolution) so the guardrail and the apply agree — a
    // valid pod-global (SYSTEM/SHARED) profile resolves in both paths and is
    // never falsely rejected. Placed BEFORE the agent branch so it also catches a
    // direct owner create with a bad profile, and before both the auto-run
    // (execute) and propose verdicts.
    if (subjectType === "entity" && action === "create") {
      const createProfileSlug =
        typeof data?.profileSlug === "string" ? data.profileSlug : undefined;
      if (createProfileSlug) {
        const profileResolution = new ProfileResolutionService(db);
        const resolvedProfile = await profileResolution.resolveProfile(
          createProfileSlug,
          userId,
          workspaceId ?? ""
        );
        if (!resolvedProfile) {
          return {
            denied: true,
            reason: `Profile '${createProfileSlug}' does not exist in this workspace. Create it first, or use an existing profile (call list_profiles to see available types).`,
          };
        }
      }
    }

    // 5. AI policy check
    //
    // Agent user path: agentUserId is the canonical signal that this is an AI action.
    // Source field is just metadata — not used to gate behaviour here.
    if (agentUserId) {
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

      // Agent governance ladder — steps (b) confirm-agent, (c) load workspace
      // settings, (d) decideAgentPolicy, (e) verdict — are the SHARED SSOT
      // `resolveAgentGovernanceDecision` (@synap/database), the SAME ladder the
      // automation door runs. The chat door prefers the agent's own metadata
      // autoApproveFor list over the workspace override
      // (`preferAgentMetadataAutoApproveFor: true`). The propose/execute SIDE
      // EFFECTS below are this door's own concern and stay here.
      const gov = await resolveAgentGovernanceDecision({
        db,
        agentUserId,
        workspaceId,
        subjectType,
        action,
        channelCapabilities,
        subjectProfileSlug,
        subjectUoValidated,
        forcePropose: opts.forcePropose,
        preferAgentMetadataAutoApproveFor: true,
      });

      if (gov.decision === "deny") {
        return { denied: true, reason: gov.reason };
      }

      if (gov.decision === "propose") {
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
          // gov.reason carries the per-branch default reasoning; it is undefined
          // for the plain default-propose case, preserving the prior behavior of
          // passing the caller's reasoning through unchanged.
          reasoning: opts.reasoning ?? gov.reason,
          threadId,
          commandRunId,
          sourceMessageId,
          sessionId,
          projectId,
        });
      }

      if (gov.decision === "execute") {
        // Auto-approved. Record a secondary audit-trail row, then grant. The
        // PRIMARY durable audit of an auto-approved action is the event spine
        // (the caller still emits `{subject}.{action}` .requested/.completed), so
        // this insert stays NON-BLOCKING — but it must never fail SILENTLY (that
        // was the Wave-B gap), so failures are logged loudly instead of swallowed.
        const eventKey = `${subjectType}.${action}`;
        const authorshipMode = deriveAuthorshipMode(userId, agentUserId);
        db.insert(proposals)
          .values({
            workspaceId: workspaceId ?? null,
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
                  gov.explicitAutoApproveFor ?? DEFAULT_AUTO_APPROVE
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

      // gov.decision === "not-agent": the user row is not an agent (defence-in-
      // depth) — fall through to the legacy AI-source path below, then grant.
    }

    // Legacy AI source path (no agent user row, but caller signals AI-sourced action).
    if (source === "ai" || source === "intelligence") {
      const [ws] = workspaceId
        ? await db
            .select({ settings: workspaces.settings })
            .from(workspaces)
            .where(eq(workspaces.id, workspaceId))
            .limit(1)
        : [undefined];

      const settings = ws?.settings as WorkspaceSettings | undefined;
      const eventKey = `${subjectType}.${action}`;

      // Modern whitelist, honored BEFORE the legacy aiAutoApprove fallback — a
      // no-agentUserId AI call (e.g. the Discord channel-digest's entity.create /
      // context.link, source:"intelligence") is governed by the SAME
      // autoApproveFor SSOT as the agentUserId path, not just the legacy boolean.
      // Destructive actions never auto-approve via this path (mirrors
      // decideAgentPolicy's rung 2.5 hard floor), and forcePropose always wins.
      const effectiveAutoApproveFor =
        settings?.aiGovernance?.autoApproveFor ?? DEFAULT_AUTO_APPROVE;
      const isDestructive = DESTRUCTIVE_ACTIONS.includes(action);
      const whitelisted =
        !isDestructive && isAutoApproved(eventKey, effectiveAutoApproveFor);

      if (whitelisted && !opts.forcePropose) {
        return { granted: true };
      }

      // Legacy aiAutoApprove workspace toggle — fallback when the action isn't
      // covered (or is destructive) by the modern whitelist.
      const aiAutoApprove =
        settings?.aiGovernance?.autoApprove ??
        (settings as Record<string, unknown> | undefined)?.aiAutoApprove ??
        false;

      // Note: reaching here with whitelisted === true means opts.forcePropose is
      // true (the whitelisted-and-not-forced case already returned above), so
      // this unconditionally still proposes for that case.
      if (!aiAutoApprove || opts.forcePropose) {
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
          projectId,
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
  return {
    summary,
    reasoning:
      opts.reasoning ??
      `${opts.action} ${opts.subjectType} requires your approval`,
    reviewPath: openPath(opts.proposalId),
    reviewUrl: openLink(opts.proposalId),
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
  /** The HUMAN userId that filed this proposal (NULL for agent-authored rows). */
  proposedByUserId?: string | null;
  threadId?: string | null;
  commandRunId?: string | null;
  sourceMessageId?: string | null;
  correlationId?: string | null;
  requestedEventId?: string | null;
  sessionId?: string | null;
  projectId?: string | null;
  expiresAt?: Date | null;
  notificationDescription?: string;
}

/**
 * The chat-AI door onto pending-proposal creation: the raw INSERT is the shared
 * SSOT `insertPendingProposal` (@synap/database) — the SAME row shape the
 * automation door (`proposeAutomationWrite`) uses — and this wrapper adds the
 * post-commit notifications / proposal_event hooks on top. (The automation door
 * omits those by design.) Keeps provenance and expiry consistent across doors.
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
  const requestId =
    typeof input.data.requestId === "string"
      ? input.data.requestId
      : proposal.id;
  // Fire-and-forget: the proposal is already durably committed above. The
  // realtime broadcast is a best-effort nudge and must NOT block the response —
  // awaiting it hangs every proposal for the full fetch timeout (~5s) whenever
  // the realtime service is unreachable. Mirrors the fire-and-forget pattern
  // used for NotificationService.fromProposal below.
  void broadcastNotification({
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
  }).catch(() => {
    // Broadcast failure is non-critical.
  });

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
  // Shared PENDING-proposal INSERT (SSOT in @synap/database) — the same row
  // shape the automation write path uses via proposeAutomationWrite. createdBy
  // keeps this path's fallback (explicit → agent → requesting user).
  const proposal = await insertPendingProposal(
    {
      workspaceId: input.workspaceId,
      targetType: input.targetType,
      targetId: input.targetId,
      proposalType: input.proposalType,
      data: input.data,
      createdBy: input.createdBy ?? input.agentUserId ?? input.userId,
      proposedByUserId: input.proposedByUserId,
      agentUserId: input.agentUserId,
      threadId: input.threadId,
      commandRunId: input.commandRunId,
      sourceMessageId: input.sourceMessageId,
      correlationId: input.correlationId,
      requestedEventId: input.requestedEventId,
      sessionId: input.sessionId,
      projectId: input.projectId,
      expiresAt: input.expiresAt,
    },
    tx
  );

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
  /**
   * The HUMAN userId that filed this proposal. Set ONLY on the human-proposer
   * path (an insufficient-role member proposing) so the row records who
   * proposed it, distinct from `createdBy`. Left undefined for agent proposals
   * (they carry `agentUserId` instead).
   */
  proposedByUserId?: string;
  workspaceId: string | null | undefined;
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
  projectId?: string | null;
}): Promise<{
  granted: false;
  proposalId: string;
  proposalType: string;
  summary: string;
  reasoning: string;
  reviewPath: string;
  reviewUrl: string;
}> {
  const {
    userId,
    agentUserId,
    proposedByUserId,
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
    projectId,
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

  // ATTRIBUTION (B1): a self-hosted IS write arrives WITHOUT an explicit
  // agentUserId (its "system"-owned key can't stamp one) but WITH source
  // "ai"/"intelligence" — so it reached this legacy-AI propose path with a null
  // agent, and the review UI would attribute the proposal to the human operator
  // (agentUserId ?? createdBy ?? sourceId → the human). Resolve the operator's
  // own pod-wide personal agent (the self-hosted orchestrator's identity) and
  // stamp it PURELY for attribution. This runs AFTER the governance ladder has
  // already decided (on the operator, via the legacy path) — so the write's
  // auto-approve/propose/deny OUTCOME is unchanged; only the proposal's
  // attributed agentUserId + audit differ. Explicit-agent writes (agentUserId
  // set) and human-member proposals (proposedByUserId set) are untouched; an
  // operator with no personal agent yet → null attribution, exactly as before.
  let attributionAgentUserId = agentUserId;
  if (
    !attributionAgentUserId &&
    !proposedByUserId &&
    (source === "ai" || source === "intelligence")
  ) {
    const [personalAgent] = await db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.userType, "agent"),
          eq(users.createdByUserId, userId),
          eq(users.isPersonalAgent, true)
        )
      )
      .orderBy(users.createdAt)
      .limit(1);
    attributionAgentUserId = personalAgent?.id;
  }
  const authorshipMode = deriveAuthorshipMode(userId, attributionAgentUserId);

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
      workspaceId: workspaceId ?? null,
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

    // COMPOSITE PASS-THROUGH: when the gate `data` IS a composite operations
    // graph (N create_entity + M create_relation — what the capture door
    // proposes), hoist `operations` to the TOP LEVEL of the stored payload.
    // The approve flow branches on `isCompositeProposalData(proposal.data)`
    // BEFORE the single-op executors, and that guard reads a top-level
    // `operations` — nested under the request-shaped `data` it is invisible, so
    // the reviewer would get an `entity/create` executor that throws
    // "missing profileSlug" and the proposal could never be approved.
    // The request-shaped envelope is PRESERVED alongside it (both guards pass;
    // the composite branch wins on approve, and the review UI renders the
    // graph). INERT for every existing caller — none passes `operations` in
    // gate data, so `isCompositeProposalData` is false and the payload is
    // byte-identical to before.
    const compositeOperations = isCompositeProposalData(
      data as unknown as Parameters<typeof isCompositeProposalData>[0]
    )
      ? (data as unknown as { operations: unknown[] }).operations
      : undefined;

    const pendingInput: CreatePendingProposalInput = {
      userId,
      workspaceId: workspaceId ?? null,
      targetType: singularType,
      targetId,
      proposalType: action,
      data: {
        ...(proposalData as unknown as Record<string, unknown>),
        ...(authorshipMode ? { authorshipMode } : {}),
        ...(compositeOperations ? { operations: compositeOperations } : {}),
      },
      agentUserId: attributionAgentUserId ?? undefined,
      createdBy: userId,
      proposedByUserId: proposedByUserId ?? null,
      threadId: threadId ?? null,
      commandRunId: commandRunId ?? null,
      sourceMessageId: sourceMessageId ?? null,
      sessionId: sessionId ?? null,
      projectId: projectId ?? null,
      correlationId: resolvedCorrelationId,
      requestedEventId: reqEventId ?? null,
      notificationDescription: reasoning ?? `${action} ${singularType}`,
    };

    const created = await createPendingProposal(pendingInput, tx);
    return { proposal: created, pendingInput };
  });

  // Post-commit notifications (broadcast / side-effects / notification center).
  await notifyProposalCreated(proposal, pendingInput);

  return {
    granted: false,
    proposalId: proposal.id,
    proposalType: `${subjectType}.${action}`,
    summary,
    reasoning: reasoning ?? `${action} ${singularType} requires your approval`,
    reviewPath: openPath(proposal.id),
    reviewUrl: openLink(proposal.id),
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
  /** The original subjectType the agent wanted to act on (e.g. "focus_session"). */
  requestedSubjectType?: string;
  /** The original action (e.g. "create"). */
  requestedAction?: string;
  /** The original data payload (e.g. { goal, templateId } for sessions). */
  requestedData?: Record<string, unknown>;
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
    requestedSubjectType,
    requestedAction,
    requestedData,
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
  // Enrich the summary when we know WHAT the agent wanted to do — a join
  // proposal for a session carries the goal so the reviewer sees the full
  // picture before approving workspace access.
  const summary =
    requestedSubjectType === "focus_session" && requestedData?.goal
      ? `Agent ${agentName} wants to create a session in ${workspaceName}: "${String(requestedData.goal)}"`
      : `Agent ${agentName} requests to join workspace ${workspaceName} as ${role}`;
  const reasoning =
    requestedSubjectType === "focus_session"
      ? `The agent needs workspace access to create a focus session (${requestedAction}). Once joined, it will start working on: ${String(requestedData?.goal ?? "an unspecified goal")}.`
      : summary;

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
      proposalType: "join",
      summary,
      reasoning,
      reviewPath: openPath(existing.id),
      reviewUrl: openLink(existing.id),
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
      // Surface WHAT the agent wanted to do so the proposal card renders
      // rich context (session goal, expected outputs, etc.) instead of a
      // generic "join workspace" card.
      ...(requestedSubjectType ? { requestedSubjectType } : {}),
      ...(requestedAction ? { requestedAction } : {}),
      ...(requestedData ? { requestedData } : {}),
      source: "agent",
      ...(correlationId ? { correlationId } : {}),
    },
  });

  return {
    granted: false,
    proposalId: row.id,
    proposalType: "join",
    summary,
    reasoning,
    reviewPath: openPath(row.id),
    reviewUrl: openLink(row.id),
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
