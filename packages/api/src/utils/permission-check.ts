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
  or,
  isNull,
  gt,
  gte,
  desc,
  drizzleSql,
  entities,
  ProfileResolutionService,
  insertPendingProposal,
  ne,
  findExistingPendingDuplicate,
  resolveOrCreateAgentProposalSession,
  deriveAgentProposalSessionGoal,
  resolveAgentProposalSessionOnce,
  deriveProposalProjectId,
  type InsertPendingProposalResult,
} from "@synap/database";
import {
  resolveAgentGovernanceDecision,
  resolveGovernanceRule,
  resolveOriginTrust,
} from "@synap/database/agent-governance";
import {
  users,
  workspaces,
  governanceRules,
  channelMembers,
  messages,
  focusSessions,
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
import { notifyPodWideProposal } from "../notifications/notify-pod-wide-proposal.js";
import {
  listAgentGovernanceOverrides,
  type AgentGovernanceOverride,
} from "./governance-rule-reads.js";
import {
  AccessContext,
  makeRequestProvenance,
  makeWriteEnvelope,
  type WriteEnvelope,
} from "../access/context.js";
import { deriveAuthorshipMode } from "../services/agent-identity-service.js";
import { satisfyExpectedOutputs } from "../services/focus-sessions/satisfy-expected-output.js";
import { logEvent } from "../lib/event-helpers.js";
import { AGENT_WRITE_EVENT_KIND } from "../lib/run-event-kinds.js";
import { openLink, openPath } from "./deep-links.js";
import {
  decideAgentPolicy,
  findMatchingPattern,
  requiredPermissionFor,
  isBlockedFilesystemPath,
  getWorkspaceGovernanceMode,
  DEFAULT_AUTO_APPROVE,
  DESTRUCTIVE_ACTIONS,
  type AgentPolicyInput,
  type ChannelCapabilityGrant,
  type GovernedWritePair,
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
 * Lifecycle close for a focus session: `completeFocusSession` gates with
 * `subjectType: "focus_session"`, `action: "update"`, and
 * `data: { id, status: "closed" }` (optionally other close-only fields).
 * Used by the `ignoreSessionForcePropose` escape so agent all-writes can finish
 * a session without a non-executable proposal.
 */
function isFocusSessionLifecycleClose(
  subjectType: string,
  action: string,
  data: Record<string, unknown> | undefined
): boolean {
  if (subjectType !== "focus_session" || action !== "update") return false;
  return data?.status === "closed";
}

/**
 * Session-scoped force-propose governance. A focus session opened for an
 * unattended, propose-only playbook (e.g. the CRM hygiene maintenance agent) is
 * stamped with `metadata.governance.forceProposeWrites: true` by
 * `executePlaybookRun`. Every Hub write the agent makes during that session
 * carries the session id (X-Session-Id → ctx.sessionId → this gate), so re-read
 * the stamp here and force the write to a PROPOSAL (decideAgentPolicy rung 2.1)
 * even when the action would otherwise auto-approve.
 *
 * Mirrors the F2 depth-floor's `deriveSessionChainContext` (automation-trigger-
 * matcher.ts): a session-keyed governance property the write-side gate re-derives
 * from the session because the agent's Hub call cannot carry it explicitly.
 *
 * Best-effort: a lookup failure degrades to `false` (no forced proposal) rather
 * than blocking the write — the caller's own `forcePropose` and the rest of the
 * ladder are unaffected.
 */
async function deriveSessionForceProposeGovernance(
  sessionId: string
): Promise<boolean> {
  try {
    const session = await db.query.focusSessions.findFirst({
      where: eq(focusSessions.id, sessionId),
      columns: { metadata: true },
    });
    const governance = (
      session?.metadata as Record<string, unknown> | undefined
    )?.governance as { forceProposeWrites?: unknown } | undefined;
    return governance?.forceProposeWrites === true;
  } catch (err) {
    logger.warn(
      { err, sessionId },
      "Failed to derive session force-propose governance — proceeding without it"
    );
    return false;
  }
}

/**
 * Resolve the acting CHANNEL for an agent turn from the triggering message id —
 * the plumbing that ACTIVATES the #4 instruction-provenance origin-trust signal
 * (rung 2.55). An agent's writes DURING a turn carry the inbound
 * `sourceMessageId` that triggered them (the same provenance the proposal row
 * already links); that message lives in the ACTING channel, so
 * `messages.channelId` IS the channel `resolveOriginTrust` classifies (EXTERNAL /
 * bridge / `source` → untrusted → force-propose). Without an acting channel,
 * rung 2.55 no-ops — which is why #4 shipped dormant: no caller passed a channel.
 *
 * SEAM CHOICE: the acting channel is NOT available as a bare local at any gate
 * call site today (the dedicated per-turn routing seam that would carry it — the
 * sibling of `resolveChannelCapabilities` — is documented-but-unbuilt). The ONE
 * channel-derivable signal already threaded to every agent write door is
 * `ctx.sourceMessageId`, so we resolve the channel from it here, in the ONE gate
 * every agent write funnels through — activating all agent-turn writes uniformly
 * rather than threading (and silently missing) N per-door call sites. An explicit
 * `opts.channelId` still WINS, so the future routing seam can pass it directly.
 *
 * SERVER-DERIVED, never request body: `sourceMessageId` is the verified triggering
 * message (auth boundary), mirroring `resolveChannelCapabilities`' server-side
 * contract. Best-effort + tighten-only-safe: a null/absent id, a missing row, or a
 * lookup error all return `null` → rung 2.55 no-ops (a lookup miss must never
 * fabricate a tightening).
 */
export async function resolveActingChannelId(
  sourceMessageId: string | null | undefined
): Promise<string | null> {
  if (!sourceMessageId) return null;
  try {
    const [row] = await db
      .select({ channelId: messages.channelId })
      .from(messages)
      .where(eq(messages.id, sourceMessageId))
      .limit(1);
    return row?.channelId ?? null;
  } catch (err) {
    logger.warn(
      { err, sourceMessageId },
      "Failed to resolve acting channel from source message — origin-trust rung 2.55 no-ops for this write"
    );
    return null;
  }
}

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
  | {
      granted: true;
      /**
       * The AUTO_APPROVED `proposals` row minted for this agent write when the
       * governance ladder auto-approved it (a durable receipt). Present ONLY on
       * the agent auto-approve path; absent for a human/owner write, a legacy
       * AI-source auto-approve, or when the receipt insert failed.
       *
       * DELIBERATELY NOT named `proposalId`: callers discriminate the "proposed"
       * (not-granted) result via `"proposalId" in perm`, so a `proposalId` key on
       * the granted variant would misroute an auto-approved write as proposed.
       * Callers thread THIS into their `.completed` event emit (`proposalId`) so
       * the write is NOT miscounted as an "ungoverned AI write" (0231).
       */
      autoApprovedProposalId?: string;
    }
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
      /**
       * True when this proposal already existed as an identical PENDING
       * agent/automation proposal and was returned instead of creating a
       * duplicate. Surfaces to agents as a "duplicate" outcome so they stop
       * re-proposing. Absent (undefined) on a freshly created proposal.
       */
      deduped?: boolean;
    }
  | { denied: true; reason: string };

/**
 * What `checkPermissionOrPropose` WOULD do, resolved without doing it.
 * See `previewPermissionDecision`.
 */
export type PermissionDecisionPreview =
  | { decision: "deny"; reason: string }
  | { decision: "propose" }
  | { decision: "execute" };

/**
 * Internal sentinel returned by the shared evaluator when it reaches a
 * propose-verdict in dry-run mode — i.e. the exact point at which commit mode
 * would have created a proposal. Never leaves this module.
 */
const DRY_RUN_PROPOSE = { __dryRunPropose: true } as const;
type DryRunPropose = typeof DRY_RUN_PROPOSE;

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
 *
 * HONEST DISPLAY (Governance Rules editor wave): `effective.autoApproveFor` is
 * derived from the `governance_rules` STORE — the SAME store enforcement reads
 * at rung 2.8 — NOT from the raw `settings.aiGovernance.autoApproveFor` JSONB.
 * The JSONB was a stale mirror: per-agent / pod / widen-lane rules never showed
 * up in it, so display could disagree with what actually auto-applies. The
 * enforced set is ADDITIVE: DEFAULT_AUTO_APPROVE (rung 8 code floor) ∪ the
 * workspace-authored `verdict:"auto"` action rules (pod ∪ this workspace,
 * `principal_kind = "any"`), minus any action a `verdict:"propose"` action rule
 * pins back to review. CONTRACT PHASE (Governance Convergence): the raw JSONB
 * sub-key is RETIRED as a write target and no longer read here —
 * `effective.settingsAutoApproveFor` is kept in the response shape for
 * back-compat but is now always null. No write path is touched here — this is a
 * read only.
 *
 * AGENT OVERRIDES (2026-08-15): `autoApproveFor` above is the workspace
 * BASELINE — `principal_kind = "any"` rules only. A `principal_kind = "agent"`
 * rule ALSO resolves at rung 2.8 (above rung 8's DEFAULT_AUTO_APPROVE), so an
 * agent-scoped `verdict:"auto"` grant was ENFORCED while being invisible here —
 * that is exactly how a real drift (`profile.create` auto-approving for one
 * agent) went undetectable from inside the product for days. Those rules are now
 * surfaced as `effective.agentOverrides[]` — a SEPARATE, clearly-labelled field,
 * deliberately NOT merged into `autoApproveFor` (merging would misreport a
 * one-agent grant as a workspace-wide one). Same lens (pod ∪ this workspace),
 * same authz floor, same shared predicate as the Rules editor door.
 */
export async function getEffectiveGovernance(workspaceId: string): Promise<{
  workspaceId: string;
  effective: {
    autoApproveFor: readonly string[];
    /** RETIRED back-compat field — always null (the JSONB sub-key is no longer read or written). */
    settingsAutoApproveFor: readonly string[] | null;
    /** Actions a `verdict:"propose"` rule pins back to review (rules-derived). */
    alwaysProposeFor: readonly string[];
    /** True when the displayed `autoApproveFor` is now derived from the rules store. */
    rulesDerived: boolean;
    /**
     * ACTIVE `principal_kind = "agent"` rules in this lens — per-agent grants
     * that resolve at rung 2.8 and are therefore ENFORCED but are NOT part of
     * the workspace baseline above. Never merge these into `autoApproveFor`:
     * each applies to exactly ONE agent. `provenance` distinguishes an earned
     * widening (`sourceProposalId` lineage) from a machine-minted backfill.
     */
    agentOverrides: readonly AgentGovernanceOverride[];
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
  source: "rules" | "workspace" | "default";
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
  const governanceMode =
    getWorkspaceGovernanceMode(settings) === "agent-owned"
      ? "agent-owned"
      : "default";
  const proposalApprovalPolicy =
    settings?.aiGovernance?.proposalApprovalPolicy ?? "owner_and_admins";

  // Rules-store read (same store enforcement uses at rung 2.8). Workspace
  // BASELINE = principal "any" (agent-scoped rules are per-agent overrides, not
  // part of the workspace's displayed baseline), action-target, pod ∪ this
  // workspace, active only.
  const ruleRows = await db
    .select({
      principalKind: governanceRules.principalKind,
      targetPattern: governanceRules.targetPattern,
      verdict: governanceRules.verdict,
    })
    .from(governanceRules)
    .where(
      and(
        isNull(governanceRules.revokedAt),
        or(
          isNull(governanceRules.expiresAt),
          gt(governanceRules.expiresAt, new Date())
        ),
        eq(governanceRules.principalKind, "any"),
        eq(governanceRules.targetKind, "action"),
        or(
          eq(governanceRules.scopeKind, "pod"),
          and(
            eq(governanceRules.scopeKind, "workspace"),
            eq(governanceRules.workspaceId, workspaceId)
          )
        )
      )
    );

  // Defence-in-depth: the SQL above already floors on `principal_kind = "any"`
  // — this in-memory re-check is a no-op against a correct query, but it means
  // a future query change can never let an AGENT-scoped rule leak into the
  // workspace-wide `autoApproveFor` baseline. An agent grant applies to ONE
  // agent; reporting it as the workspace baseline would be a lie. Agent rules
  // are surfaced separately as `effective.agentOverrides` below.
  const anyPrincipalRows = ruleRows.filter((r) => r.principalKind === "any");

  const autoRulePatterns = anyPrincipalRows
    .filter((r) => r.verdict === "auto")
    .map((r) => r.targetPattern);
  const proposeRulePatterns = new Set(
    anyPrincipalRows
      .filter((r) => r.verdict === "propose")
      .map((r) => r.targetPattern)
  );

  // Additive union (rung 8 default ∪ rung 2.8 auto rules), then subtract any
  // action a propose rule pins back to review (exact-pattern match).
  const effectiveAutoApproveFor = Array.from(
    new Set<string>([...DEFAULT_AUTO_APPROVE, ...autoRulePatterns])
  ).filter((p) => !proposeRulePatterns.has(p));

  // Agent-principal rules — the SEPARATE field. Read through the shared
  // `governance-rule-reads` module (same active predicate + same pod ∪
  // workspace lens the Rules editor uses), so this display can never drift
  // from the store enforcement reads.
  const agentOverrides = await listAgentGovernanceOverrides(workspaceId);

  const hasContributingRules = anyPrincipalRows.length > 0;

  return {
    workspaceId,
    effective: {
      autoApproveFor: effectiveAutoApproveFor,
      // CONTRACT PHASE (Governance Convergence): the raw
      // `settings.aiGovernance.autoApproveFor` JSONB sub-key is RETIRED as a
      // write target and no longer read here — the meaningful, enforced set is
      // `effective.autoApproveFor` above (rules-derived). This back-compat field
      // is kept in the response SHAPE but always null (its only consumer,
      // WorkspaceIntelligenceTabs, is migrated to the rules door).
      settingsAutoApproveFor: null,
      alwaysProposeFor: Array.from(proposeRulePatterns),
      rulesDerived: true,
      agentOverrides,
      governanceMode,
      proposalApprovalPolicy,
      destructiveAlwaysPropose: governanceMode === "agent-owned",
      destructiveActions: DESTRUCTIVE_ACTIONS,
      navigationPermissions: settings?.aiGovernance?.navigationPermissions ?? {
        autoApprove: false,
        allowedResourceTypes: ["entity", "view", "doc", "cell", "channel"],
      },
    },
    source: hasContributingRules ? "rules" : "default",
    defaults: {
      autoApproveFor: DEFAULT_AUTO_APPROVE,
    },
  };
}

/** The kind of authenticated principal that issued a request. */
export type IssuerKind =
  "operator" | "agent" | "connector" | "view" | "unknown";

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

/**
 * Everything the gate needs EXCEPT the governed-write door itself. The door —
 * the `(subjectType, action)` PAIR — is intersected in below as
 * {@link GovernedWritePair}, derived from `GATE_WRITE_DOORS` in
 * `@synap/governance-policy`.
 *
 * WHY A PAIR and not two independent unions: two unions accept their cartesian
 * product, so `subjectType: "channel", action: "merge"` would typecheck even
 * though the only real door is `channel/merge_branch`. That silent miss — a
 * proposal filed under a key no executor claims, which the star-slash-star
 * catch-all then "approves" with no effect — is precisely the defect this
 * codebase has already been bitten by three times.
 */
export interface PermissionCheckBaseOpts {
  userId: string;
  agentUserId?: string;
  /** Pass null for workspace-less (hydration / pod-wide personal) operations. */
  workspaceId?: string | null;
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
   * The acting channel id, when the write is evaluated in a channel context (an
   * agent turn responding to an inbound message). Threaded to the agent
   * governance ladder's rung 2.55 (#4 instruction-provenance origin trust):
   * `resolveOriginTrust` classifies the channel server-side (EXTERNAL / bridge /
   * `source` → untrusted → force-propose). Set it from the routing/turn seam
   * that already knows the channel (the same seam that resolves
   * `channelCapabilities`), NEVER from request-body fields. Absent → no channel
   * context → rung 2.55 no-ops (legacy / non-channel write paths unchanged).
   */
  channelId?: string | null;
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
   * WORKFLOW ATTRIBUTION — the automation step run + flow node that produced
   * this write. Persisted to `proposals.step_run_id` / `proposals.node_id` on
   * BOTH branches (proposal and auto-approve receipt), which is what makes
   * "which automation node did this" answerable for an auto-approved write.
   * Omitted by non-automation callers; the columns stay NULL exactly as before.
   */
  stepRunId?: string | null;
  nodeId?: string | null;
  /**
   * Structured GOVERNANCE reason (a `PROPOSE_REASON` key) supplied by a CALLER
   * that already knows why this write needs review. The propose branch prefers
   * the pure engine's own `gov.reasonCode` — this is the fallback, and it is the
   * ONLY source on the auto-approve receipt branch (where no propose rung fired).
   */
  governanceReason?: string | null;
  /**
   * Force a PROPOSAL even when the action would otherwise auto-approve. Set by
   * callers for scope/identity-bearing writes that must always be reviewed
   * (e.g. promoting an entity workspace→pod-wide, or changing its profile TYPE).
   * Honored only on the AI/agent governance paths — a trusted operator is the
   * authority and is never forced to self-propose. RBAC/CBAC denials still take
   * precedence over the forced proposal.
   */
  forcePropose?: boolean;
  /**
   * Lifecycle complete escape for focus sessions (pack mode).
   *
   * Two effects when true:
   *   1. Skip session-metadata `forceProposeWrites` (deriveSessionForceProposeGovernance).
   *   2. After the agent governance ladder returns `propose`, re-treat a
   *      focus_session update that closes the session (`data.status === "closed"`)
   *      as **execute** (receipt + grant). Without this, agent
   *      `writesRequireProposal: true` proposes at decideAgentPolicy rung 5
   *      *before* DEFAULT_AUTO_APPROVE (`focus_session.update`). Approving a
   *      close proposal does run `focus_session/update` → completeFocusSession,
   *      but the escape still prefers auto-execute so complete is not blocked
   *      under agent all-writes / pack mode.
   *
   * NOT a general bypass: still honors **deny** (RBAC/CBAC), ADMIN_ACTIONS,
   * destructive floors, and explicit `opts.forcePropose`. Only the lifecycle
   * close write for completeFocusSession should set this flag.
   */
  ignoreSessionForcePropose?: boolean;
}

/**
 * The gate's full options: everything in {@link PermissionCheckBaseOpts} PLUS
 * exactly one governed-write door pair from `GATE_WRITE_DOORS`.
 *
 * Adding a call site with a NEW `(subjectType, action)` pair is now a compile
 * error until the pair is declared in `@synap/governance-policy` — which is
 * what makes the tripwire's LEFT side enumerable from the type system instead
 * of from a source regex that rots.
 */
export type PermissionCheckOpts = PermissionCheckBaseOpts & GovernedWritePair;

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
  const result = await evaluatePermission(opts, false);
  if ("__dryRunPropose" in result) {
    // Unreachable: the sentinel is only ever returned in dry-run mode. Treated
    // as an internal error rather than silently granting.
    logger.error(
      { subjectType: opts.subjectType, action: opts.action },
      "Dry-run sentinel escaped commit-mode permission check"
    );
    return { denied: true, reason: "Permission check error" };
  }
  return result;
}

/**
 * DECISION-ONLY (dry-run) mode on the SAME governance door.
 *
 * Resolves the identical verdict through the identical rungs as
 * `checkPermissionOrPropose` — same `resolveAgentGovernanceDecision` engine,
 * same RBAC, same floors, same ordering — but performs **no side effects**:
 *   - no `proposals` row (pending OR auto-approved receipt)
 *   - no `.requested` event append
 *   - no notification / broadcast / side-effect emission
 *   - no `workspace.join` proposal
 *   - no daily agent-proposal-cap consumption (the cap is not even read)
 *
 * Reads (RBAC lookup, profile resolution, governance rules, workspace settings,
 * session metadata, acting-channel resolution) still run — they are what
 * produces the verdict.
 *
 * WHY: create doors need to know "would this be DENIED?" *before* they do an
 * existence lookup (so a forbidden caller never learns whether a row exists),
 * and "would this be PROPOSED?" so an already-existing target can return the
 * idempotent success instead of filing yet another duplicate proposal. It is a
 * PREVIEW, never an authorization: the door still calls
 * `checkPermissionOrPropose` for the write it actually performs.
 */
export async function previewPermissionDecision(
  opts: PermissionCheckOpts
): Promise<PermissionDecisionPreview> {
  const result = await evaluatePermission(opts, true);
  if ("__dryRunPropose" in result) return { decision: "propose" };
  if ("denied" in result) return { decision: "deny", reason: result.reason };
  if (result.granted === true) return { decision: "execute" };
  // Defensive: no propose path reaches createProposal in dry-run mode, so a
  // granted:false result should be impossible here.
  return { decision: "propose" };
}

/**
 * The facts an ANONYMOUS PRINCIPAL write actually carries. Everything the
 * engine can consult that is NOT one of these is agent-only and has no honest
 * value here — see {@link anonymousPolicyInput}.
 */
interface AnonymousPolicyFacts {
  subjectType: string;
  action: string;
  /** rung 2.6 — the write subject's profile slug, when the write targets an entity. */
  subjectProfileSlug: string | undefined;
  /** rung 2.6 — `uo_validated` on a `user_observation` subject. */
  subjectUoValidated: boolean | undefined;
  /** rung 2.1 — the caller's / session's force-propose signal. */
  forcePropose: boolean;
  /** rung 2.8 — the resolved `governance_rules` verdict ("any"-principal rules only). */
  governanceRuleVerdict: "auto" | "propose" | undefined;
  /** rung 2.55 — server-resolved trust of the acting channel's ORIGIN. */
  originTrust: "trusted" | "untrusted" | undefined;
}

/**
 * Every field of {@link AgentPolicyInput}, but REQUIRED — while still permitting
 * an explicit `undefined` value. Adding a new rung input to the engine is
 * therefore a COMPILE ERROR inside {@link anonymousPolicyInput} until someone
 * decides, in writing, what the anonymous principal's value for it is.
 */
type ExhaustiveAgentPolicyInput = AgentPolicyInput &
  Record<keyof AgentPolicyInput, unknown>;

/**
 * THE ONE CONSTRUCTOR for the anonymous principal's `decideAgentPolicy` input.
 *
 * WHY A NAMED HELPER AND NOT AN INLINE OBJECT. The legacy AI-source path has no
 * agent user row, so most of the engine's inputs have no honest value. The
 * named failure mode is a future rung taking an agent-only input and somebody
 * inlining a *plausible* default at the call site — which would silently give an
 * unattributed third-party key an agent semantic. This function is the guard:
 * it is the only place that decides, and `ExhaustiveAgentPolicyInput` makes a
 * new field impossible to forget.
 *
 * PER-RUNG DISPOSITION (verified against @synap/governance-policy's ladder):
 *   1    CBAC              — NO-OP. `agentCapabilities: undefined` → the rung's
 *                            `caps && caps.length > 0` guard is false.
 *   2    ADMIN             — FIRES on the event key. Unreachable in practice
 *                            (no live admin gate door passes a `source`), and
 *                            behaviour-identical anyway: no ADMIN key is in
 *                            DEFAULT_AUTO_APPROVE, so both old and new propose.
 *   2.05 HUMAN GATE        — FIRES (previously hand-mirrored here).
 *   2.06 ARBITRARY EXEC    — FIRES (previously hand-mirrored here).
 *   2.1  forcePropose      — FIRES (previously hand-mirrored here).
 *   2.5  DESTRUCTIVE       — FIRES (previously hand-mirrored here).
 *   2.55 UNTRUSTED ORIGIN  — FIRES. **THIS IS THE FIX.** This path never
 *                            resolved an acting channel at all, so a write from
 *                            an EXTERNAL / bridge channel auto-executed.
 *   2.56 DAILY CEILING     — **DELIBERATELY DEFERRED**: `ceilingVerdict:
 *                            undefined`, which is the rung's own no-op input
 *                            (it only ever receives `"propose"`). TWO reasons,
 *                            both load-bearing. (a) The ceiling is keyed on an
 *                            AGENT ID — `countAgentWritesTodayUtc` /
 *                            `governance_ceilings` resolve per acting agent —
 *                            and there is no agent here, so there is no
 *                            meaningful key to count against; a pod-wide count
 *                            would be a different axis wearing this rung's name.
 *                            (b) `DEFAULT_DAILY_WRITE_CEILING` is 500 and one
 *                            bulk capture auto-approves ~1,600 `entity.create`
 *                            rows, so adopting it would silently start queueing
 *                            proposals mid-capture. Giving the anonymous
 *                            principal its OWN ceiling axis is a follow-up.
 *   2.6  BY-KIND           — FIRES (previously hand-mirrored here).
 *   2.7  PER-CAPABILITY    — NO-OP. `capabilityGovernance: undefined` → the
 *                            rung's `if (input.capabilityGovernance)` is false.
 *   2.8  GOVERNANCE_RULES  — FIRES (previously hand-mirrored here).
 *   3    OWNED WORKSPACE   — NO-OP. Ownership means `workspace.linkedAgentId ===
 *                            agentUserId`; with no agent that can never be true.
 *   4    explicit autoApproveFor — NO-OP by design (`undefined`), so rung 8
 *                            falls back to DEFAULT_AUTO_APPROVE — byte-identical
 *                            to what this path did by hand.
 *   5    writesRequireProposal — NO-OP, **and it has no reachable source**. The
 *                            flag lives ONLY on `users.agentMetadata`
 *                            (schema/users.ts:25); there is no workspace-level
 *                            equivalent (`settings.aiGovernance` has no such
 *                            field). With no agent user row there is no key to
 *                            read it from. The operator-facing way to say "every
 *                            unattributed AI write must be reviewed" is a
 *                            `governance_rules` row with verdict `propose` —
 *                            rung 2.8, which DOES now fire correctly (before
 *                            this change the deprecated `aiAutoApprove` toggle
 *                            could silently override it).
 *   6    agent-owned mode + destructive — NO-OP; destructive already returned at
 *                            2.5, so the rung is unreachable regardless.
 *   7    PER-CHANNEL GRANT — NO-OP. `channelCapabilities: undefined`. A grant is
 *                            a per-teammate row keyed on a channel MEMBER; an
 *                            unattributed key is not a member of anything.
 *   8    DEFAULT_AUTO_APPROVE — FIRES (previously hand-mirrored here).
 *   9    default            — propose.
 */
function anonymousPolicyInput(facts: AnonymousPolicyFacts): AgentPolicyInput {
  const input: ExhaustiveAgentPolicyInput = {
    subjectType: facts.subjectType,
    action: facts.action,
    subjectProfileSlug: facts.subjectProfileSlug,
    subjectUoValidated: facts.subjectUoValidated,
    forcePropose: facts.forcePropose,
    governanceRuleVerdict: facts.governanceRuleVerdict,
    originTrust: facts.originTrust,

    // ── AGENT-ONLY INPUTS — omitted on purpose, never given a plausible
    // default. Each line is a decision, not an oversight; see the per-rung
    // table above for why the corresponding rung no-ops.
    agentCapabilities: undefined, // rung 1
    isAgentOwnedWorkspace: undefined, // rung 3
    autoApproveFor: undefined, // rung 4 → rung 8 uses DEFAULT_AUTO_APPROVE
    writesRequireProposal: undefined, // rung 5 — no reachable source
    governanceMode: undefined, // rung 6
    channelCapabilities: undefined, // rungs 2.7-tighten + 7
    capabilityGovernance: undefined, // rung 2.7
    capabilityExecMode: undefined, // rung 2.7
    ceilingVerdict: undefined, // rung 2.56 — DEFERRED (see table above)
    allowDestructiveAutoApprove: undefined, // never: no "Crazy" mode here
  };
  return input;
}

async function evaluatePermission(
  opts: PermissionCheckOpts,
  dryRun: boolean
): Promise<PermissionResult | DryRunPropose> {
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
    stepRunId,
    nodeId,
    channelCapabilities,
  } = opts;

  // ATTRIBUTION + PROVENANCE stamped ONCE into a frozen, boundary-minted
  // envelope, then threaded read-only into createProposal. This replaces the
  // field-by-field re-threading across the stacked proposal doors that let
  // `agentUserId` (and its provenance siblings) silently drop at a call-site
  // spread. `AccessContext.agent` is chosen iff a confirmed agentUserId is
  // present (matching the AI-governance ladder's own "is this an agent action?"
  // bit); otherwise the write is operator-attributed. Building it here — the ONE
  // door every gate caller funnels through — gives every caller the immutable
  // envelope, not just the MCP path.
  const writeEnvelope: WriteEnvelope = makeWriteEnvelope(
    agentUserId
      ? AccessContext.agent({ userId, agentUserId })
      : AccessContext.operator({ userId }),
    makeRequestProvenance({
      source,
      correlationId,
      requestedEventId,
      threadId,
      commandRunId,
      sourceMessageId,
      sessionId,
      projectId,
    })
  );

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
  // NOTE (door-vocabulary narrowing, 2026-08-19): `subjectType` is now the union
  // derived from GATE_WRITE_DOORS, and "filesystem" is NOT in it. The narrowing
  // PROVED that NO production call site passes `subjectType: "filesystem"` —
  // only `permission-check.test.ts` does. The branch is kept (not deleted)
  // because it is a security floor a future `filesystem/*` door must inherit;
  // the widening cast is what lets the otherwise-dead comparison compile.
  // Declare the door in GATE_WRITE_DOORS when one ships and this cast goes away.
  if ((subjectType as string) === "filesystem" && data?.path) {
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
            dryRun,
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
            if (dryRun) return DRY_RUN_PROPOSE;
            return createProposal({
              envelope: writeEnvelope,
              workspaceId,
              subjectType,
              action,
              data,
              reasoning:
                opts.reasoning ??
                `${action} ${subjectType} exceeds the agent's workspace role (${result.role ?? "member"}) — proposed for your approval`,
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
            if (dryRun) return DRY_RUN_PROPOSE;
            return createProposal({
              envelope: writeEnvelope,
              proposedByUserId: userId,
              workspaceId,
              subjectType,
              action,
              data,
              reasoning:
                opts.reasoning ??
                `${action} ${subjectType} exceeds your workspace role (${result.role}) — proposed for a reviewer's approval`,
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
      if (dryRun) return DRY_RUN_PROPOSE;
      return createProposal({
        envelope: writeEnvelope,
        workspaceId,
        subjectType,
        action,
        data,
        reasoning: opts.reasoning,
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

    // Session-scoped force-propose: an unattended propose-only playbook's session
    // (e.g. CRM hygiene) stamps `metadata.governance.forceProposeWrites` so every
    // AI write it makes surfaces as a reviewable proposal, even when
    // DEFAULT_AUTO_APPROVE would otherwise auto-execute it. Derived ONCE here and
    // honored by BOTH the agent-user path and the legacy AI-source path below (a
    // maintenance write may be attributed via agentUserId OR only source:
    // "intelligence"). Only queried for AI writes with a session that hasn't
    // already forced a proposal (the short-circuit avoids the lookup otherwise).
    const isAiWrite =
      Boolean(agentUserId) || source === "ai" || source === "intelligence";
    const effectiveForcePropose =
      opts.forcePropose === true
        ? true
        : isAiWrite && sessionId && !opts.ignoreSessionForcePropose
          ? await deriveSessionForceProposeGovernance(sessionId)
          : false;

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

      // #4 instruction-provenance ACTIVATION: resolve the acting channel for
      // this agent turn. An explicit `opts.channelId` (a future per-turn routing
      // seam) wins; otherwise derive it from the triggering message
      // (`sourceMessageId` → `messages.channelId`). Passed to the ladder's rung
      // 2.55 below, which classifies an EXTERNAL/bridge/`source` channel as
      // untrusted and force-proposes a would-be-auto write. Tighten-only: a null
      // acting channel (non-turn / owner write) no-ops.
      const actingChannelId =
        opts.channelId ?? (await resolveActingChannelId(sourceMessageId));

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
        forcePropose: effectiveForcePropose,
        // #4 instruction-provenance (rung 2.55): the acting channel + the human
        // owner let the ladder classify origin trust server-side and force-propose
        // a would-be-auto write from an untrusted (external / bridge) channel.
        channelId: actingChannelId,
        userId,
        preferAgentMetadataAutoApproveFor: true,
      });

      if (gov.decision === "deny") {
        return { denied: true, reason: gov.reason };
      }

      // ── PROVENANCE HOIST (P1) ────────────────────────────────────────────
      // The agent-session mint used to live ONLY inside the PENDING path
      // (`createPendingProposalRow`), so an AUTO-APPROVED agent write carried no
      // session at all — measured 2026-09-03 at 2.6% `sessionId` coverage over
      // 2961 proposals. Since auto-approve is the MAJORITY of agent write
      // traffic, packaging only the proposed half meant the session lens saw
      // almost nothing an agent actually did.
      //
      // Resolved HERE: the one point BOTH the propose branch and the execute
      // branch below pass through, so an auto-approved write carries the SAME
      // session a proposed one would. Placed AFTER the `deny` return, so a
      // refused write never mints a session; and skipped in `dryRun`, which by
      // contract performs no side effects.
      //
      // COST: `checkPermissionOrPropose` is called PER ROW, and one capture can
      // auto-approve ~1600 `entity.create` rows. `resolveAgentProposalSessionOnce`
      // memoizes on (operator, agent, workspace, project, goal) — the same tuple
      // the resolver's own reuse ladder keys on — so a burst resolves ONCE and
      // every later row reads the memo instead of re-querying.
      //
      // GUARD on `subjectType`, not `proposalType`: the pre-existing guard in
      // `createPendingProposalRow` reads `input.proposalType.startsWith(
      // "focus_session")`, but that door is passed the bare ACTION ("create" /
      // "update") — the SUBJECT is `targetType`. So the recursion guard it
      // documents has never actually fired on the chat path. Here the subject is
      // in hand and the guard is real.
      const governedSessionId =
        sessionId ??
        (dryRun || subjectType.startsWith("focus_session")
          ? null
          : await resolveAgentProposalSessionOnce({
              userId,
              agentUserId,
              workspaceId,
              projectId,
              goal: deriveAgentProposalSessionGoal({
                data,
                proposalType: action,
                targetType: subjectType,
                notificationDescription: opts.reasoning ?? null,
              }),
              // Per-proposal correlation UUIDs would force one session per row —
              // only reuse by agent+goal (openRunSession mint on miss).
              stableCorrelation: false,
            }));

      // Re-stamp the frozen envelope ONLY when the hoist actually resolved a
      // session the caller did not supply. Same object otherwise, so every
      // caller that already carried a session is byte-identical to before.
      const governedEnvelope =
        governedSessionId === (sessionId ?? null)
          ? writeEnvelope
          : makeWriteEnvelope(
              writeEnvelope.access,
              makeRequestProvenance({
                source,
                correlationId,
                requestedEventId,
                threadId,
                commandRunId,
                sourceMessageId,
                sessionId: governedSessionId ?? undefined,
                projectId,
              })
            );

      // Lifecycle complete escape: `ignoreSessionForcePropose` means "allow the
      // focus_session close write to execute under agent all-writes / pack mode"
      // — NOT a general bypass of deny, destructive, admin, or explicit
      // opts.forcePropose. writesRequireProposal (rung 5) proposes
      // focus_session.update before DEFAULT_AUTO_APPROVE (rung 8). Approve can
      // now run focus_session/update → complete, but the escape still prefers
      // auto-execute so complete is not blocked under agent all-writes.
      const lifecycleCloseEscape =
        opts.ignoreSessionForcePropose === true &&
        opts.forcePropose !== true &&
        isFocusSessionLifecycleClose(subjectType, action, data);

      if (gov.decision === "propose" && !lifecycleCloseEscape) {
        if (dryRun) return DRY_RUN_PROPOSE;
        return createProposal({
          envelope: governedEnvelope,
          workspaceId,
          subjectType,
          action,
          data,
          // gov.reason carries the per-branch default reasoning; it is undefined
          // for the plain default-propose case, preserving the prior behavior of
          // passing the caller's reasoning through unchanged.
          reasoning: opts.reasoning ?? gov.reason,
          // gov.reasonCode is the STRUCTURED companion (the PROPOSE_REASON key,
          // e.g. "UNTRUSTED_ORIGIN") — persisted so the review UI can render a
          // distinct "why this needs you" treatment for a force-propose rung.
          // The caller-supplied `governanceReason` is the fallback: the engine's
          // own verdict always wins when it fired a named rung.
          governanceReason:
            gov.reasonCode ?? opts.governanceReason ?? undefined,
          stepRunId,
          nodeId,
        });
      }

      if (gov.decision === "execute" || lifecycleCloseEscape) {
        // DRY RUN: the verdict is "execute"; skip the AUTO_APPROVED receipt
        // INSERT (the only side effect on this branch) and report it.
        if (dryRun) return { granted: true };
        // Auto-approved (or lifecycle close escape). Record the RECEIPT row, then grant.
        //
        // AWAITED, not fire-and-forget: a receipt that races the response is not
        // a receipt — the caller could observe (and report) a completed write
        // whose audit row does not exist yet. The await costs one INSERT of
        // latency and does NOT change error semantics for the caller: the insert
        // is wrapped so an audit-write failure NEVER fails the user's write. It
        // is logged loudly instead of swallowed (the Wave-B gap) and the write is
        // still granted, because the PRIMARY durable audit of an auto-approved
        // action is the event spine (the caller still emits
        // `{subject}.{action}` .requested/.completed).
        //
        // Provenance is written as COLUMNS (correlationId / sessionId /
        // sourceMessageId / projectId — all present + indexed on `proposals`),
        // not only inside `data`. Buried in JSONB the receipt was unjoinable:
        // "what did this agent do in this session / this correlation chain" had
        // no indexed reader. `data` keeps its copies for backwards compatibility
        // with existing readers of the JSONB.
        const eventKey = `${subjectType}.${action}`;
        const authorshipMode = deriveAuthorshipMode(userId, agentUserId);
        let autoApprovedProposalId: string | undefined;
        // PROJECT LENS parity with the PENDING door: a receipt that belongs to a
        // session belongs to that session's project. Reuses the pending door's
        // own derivation rather than re-implementing it — re-implementation at
        // each door is what produced the measured 0-of-670 `projectId` coverage.
        const receiptProjectId = await deriveProposalProjectId({
          projectId,
          sessionId: governedSessionId,
          threadId,
        });
        try {
          const [receipt] = await db
            .insert(proposals)
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
                // The model sometimes VOLUNTEERS a rationale for a write that
                // auto-approves; this path used to drop it on the floor while the
                // propose path stored it. Threaded through when present — never
                // synthesised, and never required (a deliberate decision).
                ...(opts.reasoning ? { reasoning: opts.reasoning } : {}),
                _autoApprove: {
                  matchedPattern: findMatchingPattern(
                    eventKey,
                    // This block is entered on `execute` OR `lifecycleCloseEscape`,
                    // so `gov` is NOT narrowed to the execute variant — read
                    // `explicitAutoApproveFor` only when it actually is one.
                    (gov.decision === "execute"
                      ? gov.explicitAutoApproveFor
                      : undefined) ?? DEFAULT_AUTO_APPROVE
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
              correlationId: correlationId ?? undefined,
              requestedEventId: requestedEventId ?? undefined,
              // Hoisted above — the SAME session a proposed write would carry.
              sessionId: governedSessionId ?? undefined,
              sourceMessageId: sourceMessageId ?? undefined,
              // Derived through the SHARED `deriveProposalProjectId` the PENDING
              // door uses, so the two doors cannot disagree about which project a
              // session's write belongs to.
              projectId: receiptProjectId ?? undefined,
              stepRunId: stepRunId ?? undefined,
              nodeId: nodeId ?? undefined,
              governanceReason: opts.governanceReason ?? undefined,
            })
            .returning({ id: proposals.id });
          // Thread the receipt id back so the caller can stamp it onto the
          // `.completed` event (events.proposal_id, 0231) — proving this agent
          // write WAS governed (auto-approved), not an ungoverned direct write.
          autoApprovedProposalId = receipt?.id;
        } catch (err) {
          logger.error(
            { err, workspaceId, agentUserId, eventKey },
            "Auto-approve audit-trail row insert failed (write still granted; event spine remains the primary audit)"
          );
        }

        // HONEST DELIVERABLE SIGNAL — the AUTO-APPROVED half.
        //
        // `apply-approval.ts` stamps `expectedOutputs[].status = "done"` when a
        // PENDING session proposal is approved. Auto-approve is the OTHER
        // approval path — an explicit governance rule (or the default lane)
        // standing in for the human's click — and it minted/resolved a session
        // above (the P1 hoist) yet never stamped. So every deliverable produced
        // by an auto-approved agent write stayed `pending` forever, and since
        // auto-approve is the MAJORITY of agent write traffic, a session's
        // expected outputs were effectively never satisfiable.
        //
        // Same guard, same arguments as the pending door: session id present,
        // the proposal's OWN targetType (`subjectType` is the subject here),
        // and the receipt id as lineage — so the stamp names a real, auditable
        // row. No receipt id (the insert above failed) ⇒ no stamp: a `done`
        // whose `satisfiedByProposalId` points at nothing is exactly the
        // unfalsifiable claim this door replaced.
        //
        // Best-effort by the door's contract: a provenance stamp must never
        // fail a write that was already granted.
        if (governedSessionId && autoApprovedProposalId) {
          try {
            await satisfyExpectedOutputs({
              sessionId: governedSessionId,
              targetType: subjectType,
              proposalId: autoApprovedProposalId,
            });
          } catch (err) {
            logger.warn(
              { err, proposalId: autoApprovedProposalId },
              "expected-output stamp failed after an auto-approved write"
            );
          }
        }

        return { granted: true, autoApprovedProposalId };
      }

      // gov.decision === "not-agent": the user row is not an agent (defence-in-
      // depth) — fall through to the legacy AI-source path below, then grant.
    }

    // ─────────────────────────────────────────────────────────────────────
    // LEGACY AI-SOURCE PATH — the ANONYMOUS PRINCIPAL.
    //
    // Reached when the caller signalled an AI-sourced write (`source: "ai" |
    // "intelligence"`) but NO agent user row was resolved — an unattributed
    // `service` / `user_pat` / `hub_inbound` key. `service` keys are
    // DELIBERATELY handed to third parties (`services/external-registration.ts`
    // forces `linkedUserId: null`; see the schema comment on
    // `schema/api-keys.ts`), so this is real traffic, not a vestige. And it is a
    // TIGHTENING, not a weakening: strip `source` and the same caller falls
    // through to step 6's unconditional `{ granted: true }`.
    //
    // It used to hand-mirror PART of the ladder inline (2.05 / 2.06 / 2.1 / 2.5
    // / 2.6 / 2.8 / 8) — a second, partial, hand-maintained copy of a 13-rung
    // engine, which is a fork the moment it exists. It now calls the SAME
    // engine, `decideAgentPolicy`, through `anonymousPolicyInput()` — the ONE
    // constructor, whose docblock carries the per-rung disposition (including
    // why 2.56 is deliberately deferred and why 5 has no reachable source).
    // ─────────────────────────────────────────────────────────────────────
    if (source === "ai" || source === "intelligence") {
      const eventKey = `${subjectType}.${action}`;

      // rung 2.6 inputs — both ride in the gate `data` payload (entity
      // create/update carries `profileSlug` + `properties`). Read defensively:
      // absent → the rung no-ops.
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

      // rung 2.8 — the ONE user-editable governance store.
      // `includeAgentPrincipal: false`: there is no agent user here to attribute
      // an agent-scoped rule to, so only "any"-principal (workspace-authored)
      // rules are eligible.
      const ruleMatch = await resolveGovernanceRule({
        db,
        workspaceId,
        subjectType,
        action,
        includeAgentPrincipal: false,
      });

      // rung 2.55 — THE FIX. This path never resolved an acting channel at all,
      // so a write arriving from an EXTERNAL / bridge channel auto-executed.
      // Resolved server-side from the triggering message (never the request
      // body), exactly as the agent branch above does it.
      const actingChannelId =
        opts.channelId ?? (await resolveActingChannelId(sourceMessageId));
      const originTrust = await resolveOriginTrust({
        db,
        channelId: actingChannelId,
        userId,
        workspaceId,
      });

      const gov = decideAgentPolicy(
        anonymousPolicyInput({
          subjectType,
          action,
          subjectProfileSlug,
          subjectUoValidated,
          forcePropose: effectiveForcePropose,
          governanceRuleVerdict: ruleMatch?.verdict,
          originTrust,
        })
      );

      // `deny` is structurally unreachable for the anonymous principal: all
      // three denying rungs (1 CBAC, 2.7 per-capability, 7 per-channel) require
      // an input `anonymousPolicyInput` pins to `undefined`. Handled rather than
      // cast away, so that if a future rung learns to deny on an input the
      // anonymous principal DOES carry, it denies instead of falling through.
      if (gov.verdict === "deny") {
        return { denied: true, reason: gov.reason };
      }

      // The propose-only fields, read ONCE through the discriminant so the rest
      // of this block can branch on them without re-narrowing. Both are
      // `undefined` for an `execute` verdict AND for the engine's plain
      // default-propose (rung 9) — the latter is exactly what the legacy
      // `aiAutoApprove` toggle below keys on.
      const proposeReason = gov.verdict === "propose" ? gov.reason : undefined;
      const proposeReasonCode =
        gov.verdict === "propose" ? gov.reasonCode : undefined;

      // LEGACY `aiAutoApprove` WORKSPACE TOGGLE — preserved, and now strictly
      // NARROWER. This deprecated boolean used to grant any action the
      // hand-mirrored whitelist did not cover, overriding even a
      // `governance_rules` row that said "propose". It is now honoured ONLY for
      // the engine's PLAIN DEFAULT propose (rung 9 — the one propose verdict
      // that carries no `reasonCode`), so every NAMED rung beats it. Deleting it
      // outright would be a silent tightening on pods that set it; narrowing it
      // is the honest middle.
      let autoExecute = gov.verdict === "execute";
      if (!autoExecute && proposeReasonCode === undefined) {
        const [ws] = workspaceId
          ? await db
              .select({ settings: workspaces.settings })
              .from(workspaces)
              .where(eq(workspaces.id, workspaceId))
              .limit(1)
          : [undefined];
        const settings = ws?.settings as WorkspaceSettings | undefined;
        autoExecute = Boolean(
          settings?.aiGovernance?.autoApprove ??
          (settings as Record<string, unknown> | undefined)?.aiAutoApprove ??
          false
        );
      }

      if (autoExecute) {
        // DRY RUN: the verdict is "execute"; skip the receipt INSERT (the only
        // side effect on this branch) and report it.
        if (dryRun) return { granted: true };

        // COUNTABILITY — the anonymous auto-execute used to be a bare
        // `return { granted: true }`: no proposal row, no session, no
        // attribution of any kind. Across every documented system (GCP Workload
        // Identity, AWS Roles Anywhere, Kubernetes, even Wikipedia's IP edits) a
        // mutation never gets ZERO attribution: it is either refused, or an
        // attribution SUBSTITUTE is mandatorily captured. This receipt is that
        // substitute — the same AUTO_APPROVED row the agent path mints, marked
        // so the two can never be confused.
        //
        // Best-effort by the door's contract, exactly like the agent path's: an
        // audit-write failure NEVER fails a write that was already granted, and
        // is logged loudly rather than swallowed. The PRIMARY durable audit
        // remains the event spine.
        let autoApprovedProposalId: string | undefined;
        const receiptProjectId = await deriveProposalProjectId({
          projectId,
          sessionId: sessionId ?? null,
          threadId,
        });
        try {
          const [receipt] = await db
            .insert(proposals)
            .values({
              workspaceId: workspaceId ?? null,
              targetType: subjectType,
              targetId: String(data?.id ?? randomUUID()),
              proposalType: eventKey,
              data: {
                ...data,
                ...(correlationId ? { correlationId } : {}),
                ...(requestedEventId ? { requestedEventId } : {}),
                ...(opts.reasoning ? { reasoning: opts.reasoning } : {}),
                _autoApprove: {
                  // THE ANONYMOUS MARKER. The agent path never sets
                  // `principal`, so `principal === "anonymous"` is a POSITIVE,
                  // greppable discriminator — stronger than inferring it from a
                  // null `agentUserId`, which is null on plenty of other rows.
                  principal: "anonymous",
                  // Present only when rung 8 matched; absent when the legacy
                  // `aiAutoApprove` toggle is what granted the write.
                  matchedPattern: findMatchingPattern(
                    eventKey,
                    DEFAULT_AUTO_APPROVE
                  ),
                  approvedAt: new Date().toISOString(),
                  approvedBy: "system:auto_approve",
                },
              },
              status: ProposalStatus.AUTO_APPROVED,
              // No agent user row exists; the authenticated bearer is the only
              // principal there is. `agentUserId` stays NULL on purpose — this
              // receipt must never be counted as AGENT conduct by the trust
              // scorecard, which floors on `createdBy`/`agentUserId`.
              createdBy: userId,
              threadId: threadId ?? undefined,
              commandRunId: commandRunId ?? undefined,
              correlationId: correlationId ?? undefined,
              requestedEventId: requestedEventId ?? undefined,
              // The caller's session if it carried one. NOT minted here: the
              // session resolver keys on an agent id, which does not exist.
              sessionId: sessionId ?? undefined,
              sourceMessageId: sourceMessageId ?? undefined,
              projectId: receiptProjectId ?? undefined,
              stepRunId: stepRunId ?? undefined,
              nodeId: nodeId ?? undefined,
              governanceReason: opts.governanceReason ?? undefined,
            })
            .returning({ id: proposals.id });
          autoApprovedProposalId = receipt?.id;
        } catch (err) {
          logger.error(
            { err, workspaceId, userId, eventKey },
            "Anonymous-principal auto-approve audit-trail row insert failed (write still granted; event spine remains the primary audit)"
          );
        }

        return { granted: true, autoApprovedProposalId };
      }

      // Mirror the agent-path lifecycle complete escape for an AI/intelligence
      // source without an agent user row (e.g. session-recap). Same flag + close
      // pattern; still honors deny (already returned) and explicit
      // opts.forcePropose.
      if (
        opts.ignoreSessionForcePropose === true &&
        opts.forcePropose !== true &&
        isFocusSessionLifecycleClose(subjectType, action, data)
      ) {
        return { granted: true };
      }
      if (dryRun) return DRY_RUN_PROPOSE;
      return createProposal({
        envelope: writeEnvelope,
        workspaceId,
        subjectType,
        action,
        data,
        // The engine's per-rung default reasoning + its structured reasonCode —
        // parity with the agent path. Both are undefined for the plain
        // default-propose case, preserving the prior behaviour of passing the
        // caller's reasoning through unchanged.
        reasoning: opts.reasoning ?? proposeReason,
        governanceReason:
          proposeReasonCode ?? opts.governanceReason ?? undefined,
      });
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
  // focus_session lifecycle close — human-readable "Complete session …"
  if (
    subjectType === "focus_session" &&
    action === "update" &&
    data.status === "closed"
  ) {
    const goal =
      (typeof data.goal === "string" && data.goal.trim()
        ? data.goal
        : undefined) ??
      (typeof data.targetName === "string" && data.targetName.trim()
        ? data.targetName
        : undefined);
    return goal ? `Complete session "${goal}"` : "Complete focus session";
  }
  // focus_session create — "Start session …" when a goal is present
  if (subjectType === "focus_session" && action === "create") {
    const goal =
      (typeof data.goal === "string" && data.goal.trim()
        ? data.goal
        : undefined) ??
      (typeof data.targetName === "string" && data.targetName.trim()
        ? data.targetName
        : undefined);
    if (goal) return `Start session "${goal}"`;
  }

  // A RULE is identified by the sentence the user actually said — its `intent`.
  // Without this it falls through to the generic branch, which finds no
  // targetName/title/name/goal/slug on a rule payload and renders a bare
  // "Create rule": a reviewer would see that a rule is proposed but not WHICH
  // rule, which is the review-theatre failure this repo has already logged
  // (approving what you cannot read). Truncated because a rule is prose, not a
  // label, and this string sits in a queue row.
  if (subjectType === "rule" && typeof data.intent === "string") {
    const intent = data.intent.trim();
    if (intent) {
      const shown = intent.length > 80 ? `${intent.slice(0, 79)}…` : intent;
      const verb = action === "create" ? "Add" : "Update";
      return `${verb} rule "${shown}"`;
    }
  }

  const actionVerb = action.charAt(0).toUpperCase() + action.slice(1);
  // goal is a first-class label for focus_session (and harmless elsewhere)
  const label = (data.targetName ||
    data.title ||
    data.name ||
    data.goal ||
    data.slug) as string | undefined;
  if (label) return `${actionVerb} ${subjectType} "${label}"`;
  if (action === "delete" && data.id) return `${actionVerb} ${subjectType}`;
  return `${actionVerb} ${subjectType}`;
}

/**
 * The `proposalType` a WORKSPACE-JOIN gate carries. `maybeCreateWorkspaceJoinProposal`
 * is the only producer; every governed write door can receive it, because the gate
 * fires for ANY agent write into a workspace the agent is not yet a member of.
 */
export const JOIN_GATE_PROPOSAL_TYPE = "join";

/**
 * Summary for a proposed response that turned out to be a JOIN gate. Doors that
 * SYNTHESIZE a summary from (subjectType, action) must use this instead — the
 * synthesized "Update entity …" narrates a write that was never proposed.
 */
export const JOIN_GATE_SUMMARY =
  "Workspace access required — a workspace JOIN request is pending review";

/** True when a proposed-branch result is a workspace-JOIN gate, not the requested write. */
export function isJoinGate(proposalType: string | undefined | null): boolean {
  return proposalType === JOIN_GATE_PROPOSAL_TYPE;
}

/**
 * The `message` a governed door returns on its proposed branch.
 *
 * WHY THIS EXISTS: the join gate DEGRADES the write — it files a
 * `workspace.join` proposal INSTEAD of the content proposal the caller asked
 * for. A door that hardcodes "<X> proposed for review" then narrates a write
 * that was never proposed, and the agent reading it builds a wrong theory of
 * what is pending. `proposalType` is the discriminator that already rides the
 * result; this derives the prose FROM it instead of ignoring it.
 *
 * Same family as the "PHANTOM ENVELOPE ID FIX" in `entities/create.ts`: on a
 * join gate, also OMIT any pre-allocated id (`proposedEntityId` and friends) —
 * an id that can never resolve is worse than an absent field.
 */
export function proposedMessageFor(
  proposalType: string | undefined | null,
  contentMessage: string
): string {
  if (!isJoinGate(proposalType)) return contentMessage;
  return (
    "Workspace access was required, so a workspace JOIN request was filed for " +
    "review INSTEAD of the requested write — nothing about the write itself is " +
    "pending yet, and no id was allocated for it. Approve the join, then retry " +
    "the write. If you cannot wait for approval, ASK THE USER where this should " +
    "go — do not retry into a different workspace hoping it lands."
  );
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
  /** Workflow attribution: the automation step run + flow node that produced
   *  this proposal. Both optional — non-automation proposals omit them. */
  stepRunId?: string | null;
  nodeId?: string | null;
  expiresAt?: Date | null;
  notificationDescription?: string;
  /** Structured governance reason (PROPOSE_REASON key) → `governance_reason`. */
  governanceReason?: string | null;
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
  } else {
    // Pod-wide proposal (workspaceId === null): no workspace membership to
    // notify, so route the "needs you" attention to the pod owner + pod admins.
    // The fan-out itself now lives in ONE place (`notifyPodWideProposal`) shared
    // with the tighten recommender, which files pod-wide proposals through
    // `insertPendingProposal` and so never reaches this function. Fire-and-
    // forget: the helper never throws and logs its own failures non-fatally.
    void notifyPodWideProposal({
      proposalId: proposal.id,
      proposalType: `${input.targetType}.${input.proposalType}`,
      description:
        input.notificationDescription ??
        `${input.proposalType} ${input.targetType}`,
      agentUserId: input.agentUserId ?? undefined,
    });
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
  // Public shape unchanged (returns the row) so the many simple callers stay
  // as-is; they still benefit transparently from the SSOT's dedup guard (they
  // get the existing row back, no duplicate). Only createProposal needs the
  // `deduped` signal — it uses createPendingProposalRow directly.
  const { proposal } = await createPendingProposalRow(input, tx);
  return proposal;
}

/**
 * Same as createPendingProposal but also reports whether the SSOT deduped the
 * write (an identical PENDING agent proposal already existed). Threaded up by
 * createProposal so it can skip the "created" notification for a dedup hit and
 * tell the agent it already proposed this.
 */
async function createPendingProposalRow(
  input: CreatePendingProposalInput,
  tx?: DbTx
): Promise<InsertPendingProposalResult> {
  // Wave 2 — agent writes without a session get packaged into a focus session
  // (teammate metaphor). Humans and already-sessioned callers are untouched.
  // Never mint for focus_session self-writes (recursion). Best-effort.
  let sessionId = input.sessionId ?? null;
  if (
    input.agentUserId &&
    !sessionId &&
    !input.proposalType.startsWith("focus_session")
  ) {
    try {
      sessionId = await resolveOrCreateAgentProposalSession({
        userId: input.userId,
        agentUserId: input.agentUserId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        goal: deriveAgentProposalSessionGoal({
          data: input.data,
          proposalType: input.proposalType,
          targetType: input.targetType,
          notificationDescription: input.notificationDescription,
        }),
        // Per-proposal correlation UUIDs would force one session per row —
        // only reuse by agent+goal (openRunSession mint on miss).
        stableCorrelation: false,
      });
    } catch {
      sessionId = null;
    }
  }

  // Shared PENDING-proposal INSERT (SSOT in @synap/database) — the same row
  // shape the automation write path uses via proposeAutomationWrite. createdBy
  // keeps this path's fallback (explicit → agent → requesting user).
  const result = await insertPendingProposal(
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
      sessionId,
      projectId: input.projectId,
      stepRunId: input.stepRunId,
      nodeId: input.nodeId,
      expiresAt: input.expiresAt,
      governanceReason: input.governanceReason,
    },
    tx
  );

  // Standalone callers get notifications inline; transaction callers run
  // notifyProposalCreated() themselves after commit. A dedup hit skips the
  // notification — the row already notified when it was first created.
  if (!tx && !result.deduped) {
    await notifyProposalCreated(result.proposal, input);
  }

  return result;
}

/**
 * Create a proposal for an AI-sourced action that requires review.
 */
/**
 * Hard per-AGENT daily budget for agent-created proposals (UTC day). A
 * scheduled or chained agent that keeps proposing must not be able to flood a
 * user's review queue: past this count, the agent write is REFUSED (neither
 * executed nor proposed) for the rest of the day. Base cap; a trusted agent's
 * effective ceiling may be scaled up — see `agentDailyProposalCap()`. Mirrors
 * the deterministic hygiene worker's MAX_PROPOSALS_PER_USER_PER_DAY.
 */
export const AGENT_PROPOSALS_PER_USER_PER_DAY = 10;

/** Multiplier applied to the base cap for a proven-trustworthy agent. */
const TRUSTED_AGENT_CAP_MULTIPLIER = 3;
/** Minimum proposal volume (within the trust window) before trust can raise the cap. */
const TRUSTED_AGENT_MIN_TOTAL = 100;
/** Minimum approve rate (within the trust window) before trust can raise the cap. */
const TRUSTED_AGENT_MIN_APPROVE_RATE = 0.95;
/**
 * Recent-proposal window the trust check scores over. MUST match
 * `agent-scorecard.ts`'s `SCORECARD_SCAN_LIMIT` (not imported directly — that
 * would create a module cycle, since agent-scorecard.ts already imports
 * `agentDailyProposalCap` from here) so the cap's trust verdict and the
 * scorecard's DISPLAYED approve rate are computed over the identical set of
 * rows and can never visibly disagree. Trust is earnable back over an agent's
 * RECENT behavior rather than accumulating forever over its lifetime.
 */
const CAP_TRUST_WINDOW = 500;

/** UTC midnight for "today" — the same day boundary the hygiene worker uses. */
export function startOfUtcDay(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
}

/**
 * Count proposals attributed to THIS agent (not its owner's whole roster)
 * created today (UTC). Per-agent — `agentUserId` + the UTC-day bound are the
 * WHOLE predicate, and `agent-scorecard.ts` CALLS this function rather than
 * re-deriving it, so the enforced count and the reported posture are one query.
 *
 * D4b — why `createdBy` is NOT in the predicate.
 *
 * It used to be, ANDed as `createdBy = <the human> AND agentUserId = <the
 * agent>`. Be precise about what that did and did not break, because the first
 * telling of this was WRONG and the wrong version is the more attractive story:
 * it did NOT make the cap inert. `createProposal` — the only function that
 * enforces the cap — builds its insert with `createdBy: userId` EXPLICITLY
 * (see the `pendingInput` in its transaction), and `countTodayAgentProposals`
 * was called with that SAME `userId` binding, never reassigned in between. Count
 * predicate and inserted value were one expression in one scope, so they matched
 * by construction and the cap fired correctly for every row that path created.
 *
 * What the pair actually cost was rows the capped path did NOT create. The
 * `?? input.agentUserId` fallback in `createPendingProposalRow` fires only for
 * doors that call it directly without a `createdBy` — `connectors/external-dispatch.ts`
 * is the live example — so those rows land `createdBy = agentUserId` and the
 * old pair could never see them. The counter under-counted total queue pressure;
 * it never mis-counted its own budget.
 *
 * Dropping the term is still correct, for reasons independent of that history:
 *   1. It counts the bypass doors' rows, which are real queue pressure.
 *   2. It cannot admit another human's rows, because an agent-user belongs to
 *      exactly ONE human: `users.createdByUserId` is a single-valued FK, and
 *      migration 0228 adds a partial UNIQUE (created_by_user_id, agent_type)
 *      making a service agent a singleton per owner x type. `agentUserId`
 *      already implies its owner, so the human term was redundant.
 *   3. It matches `agentDailyProposalCap()` — the ceiling half of the same
 *      decision — which has ALWAYS keyed on `agentUserId` alone. A human floor
 *      here with none there would let an agent earn a 3x ceiling from rows the
 *      counter could not see.
 *
 * This predicate is pinned by `agent-daily-cap-counter.test.ts`. Before that,
 * every cap test MOCKED `todayCount` as an input, so nothing would have caught
 * a wrong predicate here — which is how the incorrect story above survived
 * long enough to be believed.
 */
export async function countTodayAgentProposals(
  agentUserId: string
): Promise<number> {
  const [row] = await db
    .select({ count: drizzleSql<number>`count(*)::int` })
    .from(proposals)
    .where(
      and(
        eq(proposals.agentUserId, agentUserId),
        // COUNT WHAT THE CAP PROTECTS. This budget's own docstring is
        // "must not be able to flood a user's REVIEW QUEUE", and the gate that
        // consumes this count sits on the PROPOSE path only — an auto-approved
        // write returns `{ granted: true, autoApprovedProposalId }` ~768 lines
        // earlier and never reaches it, correctly, because it never enters the
        // queue. Counting its audit RECEIPT here measured a different
        // population than the gate enforces: live, this read 64 against a cap
        // of 30 while the entire pod held 11 pending rows, and the health door
        // announced an agent "hit the daily proposal cap" that was never
        // gated and never blocked.
        //
        // A receipt is an audit row for a write that already executed. It is
        // not queue pressure, and it must not consume a queue-pressure budget.
        ne(proposals.status, ProposalStatus.AUTO_APPROVED),
        gte(proposals.createdAt, startOfUtcDay())
      )
    );
  return row?.count ?? 0;
}

/**
 * Lightweight trust check for the daily cap: scored over the agent's most
 * recent `CAP_TRUST_WINDOW` proposals (NOT its unbounded lifetime), NOT the
 * full `diagnose` scorecard (which also runs fingerprint-clustering for a
 * duplicate rate — too heavy for this hot path). A proven agent
 * (>=100 proposals, >=95% approve rate, both within that recent window) gets
 * a 3x ceiling; everyone else gets the base cap.
 *
 * D4a: previously scored the agent's ENTIRE lifetime, which could silently
 * disagree with the recent-500 approve rate `agent-scorecard.ts` displays —
 * an agent could show a dropping recent rate on its scorecard while still
 * holding the 3x cap earned from old history. Scoring the same window makes
 * the two agree and lets trust be earned back / lost based on recent conduct.
 */
export async function agentDailyProposalCap(
  agentUserId: string
): Promise<number> {
  // `isPartial` is computed IN SQL rather than fetching `data`: this is a hot
  // path (every proposal creation) and `data` is an unbounded JSONB payload we
  // would otherwise pull for up to CAP_TRUST_WINDOW rows just to read one flag.
  // Same predicate as `allAgentsScorecard`'s and as the JS-side
  // `isPartiallyApprovedData` — one question, asked three ways only because the
  // three call sites have different shapes available.
  const recentRows = await db
    .select({
      status: proposals.status,
      isPartial: drizzleSql<boolean>`coalesce(jsonb_path_exists(${proposals.data}, '$.dispositions.*.status ? (@ == "reject")'), false)`,
    })
    .from(proposals)
    .where(eq(proposals.agentUserId, agentUserId))
    .orderBy(desc(proposals.createdAt))
    .limit(CAP_TRUST_WINDOW);

  const total = recentRows.length;
  // A PARTIAL apply is not an approval. Per-item dispositions let a reviewer
  // gut a composite and keep the remainder; the row still stores plain
  // `"approved"`. Counting that here would hand a 3x daily cap to an agent
  // whose packages are routinely thrown away — the same miscount the widening
  // lane scanner had (`computeQualification`), on a second trust gate.
  const approved = recentRows.filter(
    (r) =>
      !r.isPartial &&
      (r.status === ProposalStatus.APPROVED ||
        r.status === ProposalStatus.AUTO_APPROVED)
  ).length;
  const approveRate = total > 0 ? approved / total : 0;

  if (
    total >= TRUSTED_AGENT_MIN_TOTAL &&
    approveRate >= TRUSTED_AGENT_MIN_APPROVE_RATE
  ) {
    return AGENT_PROPOSALS_PER_USER_PER_DAY * TRUSTED_AGENT_CAP_MULTIPLIER;
  }
  return AGENT_PROPOSALS_PER_USER_PER_DAY;
}

async function createProposal(args: {
  /**
   * The immutable attribution+provenance envelope, stamped ONCE at the write-gate
   * boundary. Identity (userId / agentUserId) is READ off `envelope.access`; the
   * per-request provenance (source / correlation / thread / command run / source
   * message / session / project) off `envelope.provenance`. This replaces the
   * field-by-field re-threading that let `agentUserId` silently drop between doors.
   */
  envelope: WriteEnvelope;
  /**
   * The HUMAN userId that filed this proposal. Set ONLY on the human-proposer
   * path (an insufficient-role member proposing) so the row records who
   * proposed it, distinct from `createdBy`. Left undefined for agent proposals
   * (they carry `agentUserId` on the envelope's access instead).
   */
  proposedByUserId?: string;
  workspaceId: string | null | undefined;
  subjectType: string;
  action: string;
  data: Record<string, unknown>;
  reasoning?: string;
  /**
   * Structured governance reason — the PROPOSE_REASON KEY the pure engine
   * stamped (from `gov.reasonCode`). Persisted to `governance_reason` so the
   * review UI can branch on WHY the write needs a human. Omitted for the
   * RBAC-role-exceed propose paths (those carry no governance-engine verdict).
   */
  governanceReason?: string;
  /** Workflow attribution forwarded to the row: automation step run + flow node. */
  stepRunId?: string | null;
  nodeId?: string | null;
  // Returns PermissionResult — the proposed envelope on success, OR a denial
  // when the agent's daily proposal budget is exhausted (the F2 safety floor).
}): Promise<PermissionResult> {
  const {
    envelope,
    proposedByUserId,
    workspaceId,
    subjectType,
    action,
    data,
    reasoning,
    governanceReason,
    stepRunId,
    nodeId,
  } = args;
  // Identity off the boundary-minted AccessContext; provenance off the frozen
  // per-request slice. Same values as the old loose params — now single-sourced.
  const { userId, agentUserId } = envelope.access;
  const {
    source,
    correlationId,
    requestedEventId,
    threadId,
    commandRunId,
    sourceMessageId,
    sessionId,
    projectId,
  } = envelope.provenance;

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

  // Safety floor (F2): a runaway or scheduled agent cannot flood the review
  // queue. Only the AGENT path is budgeted — attributionAgentUserId is set for
  // both an explicit agent write and a legacy AI-source write whose personal
  // agent we just resolved. Human-member proposals (proposedByUserId, no agent
  // attribution) are never capped. The cap is PER AGENT (not shared across an
  // owner's whole roster) and scales with the agent's own trust — see
  // `agentDailyProposalCap()`. `governance.*` proposals (e.g.
  // `governance.widen_lane`) are meta-actions, not a data flood, and are
  // exempt. Past the daily cap the write is REFUSED (neither executed nor
  // proposed) — the agent gets a denial it can surface.
  const isGovernanceMetaProposal = action.startsWith("governance.");
  if (attributionAgentUserId && !isGovernanceMetaProposal) {
    const [alreadyToday, cap] = await Promise.all([
      countTodayAgentProposals(attributionAgentUserId),
      agentDailyProposalCap(attributionAgentUserId),
    ]);
    if (alreadyToday >= cap) {
      logger.warn(
        {
          userId,
          agentUserId: attributionAgentUserId,
          alreadyToday,
          cap,
          subjectType,
          action,
        },
        "Agent daily proposal budget reached — refusing further agent proposals"
      );
      const capReason = `Daily agent proposal limit reached (${cap}/day). Ask the user to review pending proposals, or try again tomorrow.`;
      // HUMAN-facing record of the refusal. A `logger.warn` reaches no user, so
      // a capped agent and a dead agent were byte-identical from the UI: the
      // write neither executed nor proposed, and NOTHING said so. This event is
      // the agent_write ledger's refusal row — `listAgentWriteRuns`
      // (services/runs/index.ts) synthesises a `blocked_by_policy` run from it,
      // exactly as the capability ledger already synthesises a direct run from a
      // `capability_run` event. Best-effort by contract: emitAiDecision swallows
      // + logs and never throws, so telemetry cannot turn a refusal into a 500.
      // DYNAMIC import: `ai-feedback-events` pulls `lib/ai-events` →
      // `@synap/database`, and this module's suites replace that package with a
      // TOTAL `vi.mock`. A static import would kill every test in those files at
      // load time; loading it only on the refusal path keeps the hazard out of
      // the module graph. (Same reason execute-capability defers
      // `capability-registry`.)
      const { emitAiDecision } = await import("./ai-feedback-events.js");
      await emitAiDecision({
        action: AGENT_WRITE_EVENT_KIND,
        userId,
        workspaceId: workspaceId ?? null,
        correlationId: resolvedCorrelationId,
        data: {
          kind: AGENT_WRITE_EVENT_KIND,
          outcome: "refused",
          refusalReason: "capped",
          subjectType,
          writeAction: action,
          agentUserId: attributionAgentUserId,
          alreadyToday,
          cap,
          reason: capReason,
          // Read by getRun's agent_write branch as the activity row's hint.
          fixHint:
            "Review or clear this agent's pending proposals to free budget, or raise its cap by widening its lane.",
        },
      });
      return {
        denied: true,
        reason: capReason,
      };
    }
  }

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

  // Build the stored proposal payload ONCE, up front. `requestedEventId` is the
  // only field that must wait for the TX (it comes from the `.requested` event
  // stamped there) — it is a VOLATILE dedup key (stripped from the hash), so
  // injecting it inside the TX does NOT change the dedup identity computed here.
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
    reasoning: reasoning || `${action} ${singularType} requires your approval`,
    summary,
    correlationId: resolvedCorrelationId,
    ...(previousData ? { previousData } : {}),
  };

  // COMPOSITE PASS-THROUGH: when the gate `data` IS a composite operations graph
  // (N create_entity + M create_relation — what the capture door proposes),
  // hoist `operations` to the TOP LEVEL of the stored payload. The approve flow
  // branches on `isCompositeProposalData(proposal.data)` BEFORE the single-op
  // executors, and that guard reads a top-level `operations` — nested under the
  // request-shaped `data` it is invisible, so the reviewer would get an
  // `entity/create` executor that throws "missing profileSlug" and the proposal
  // could never be approved. The request-shaped envelope is PRESERVED alongside
  // it. INERT for every existing caller — none passes `operations` in gate data.
  const compositeOperations = isCompositeProposalData(
    data as unknown as Parameters<typeof isCompositeProposalData>[0]
  )
    ? (data as unknown as { operations: unknown[] }).operations
    : undefined;

  const storedData: Record<string, unknown> = {
    ...(proposalData as unknown as Record<string, unknown>),
    ...(authorshipMode ? { authorshipMode } : {}),
    ...(compositeOperations ? { operations: compositeOperations } : {}),
  };

  // G1 PEEK-BEFORE-EVENT: for an agent-authored write that exactly matches an
  // existing PENDING proposal, dedup is a NO-OP — return the existing proposal
  // WITHOUT stamping a second `.requested` event or inserting a duplicate row.
  // (Stamping-then-deduping left a spurious `.requested` event dangling on every
  // agent retry.) Uses the SAME hash the SSOT insert stores, so peek and insert
  // agree. Human-authored proposals (no attribution agent) are never deduped.
  if (attributionAgentUserId) {
    const existing = await findExistingPendingDuplicate({
      workspaceId: workspaceId ?? null,
      targetType: singularType,
      targetId,
      proposalType: action,
      data: storedData,
      agentUserId: attributionAgentUserId,
    });
    if (existing) {
      logger.info(
        { proposalId: existing.id, deduped: true },
        "proposal deduped (peek — skipped .requested event + insert)"
      );
      return {
        granted: false,
        proposalId: existing.id,
        proposalType: `${subjectType}.${action}`,
        summary,
        reasoning:
          reasoning || `${action} ${singularType} requires your approval`,
        reviewPath: openPath(existing.id),
        reviewUrl: openLink(existing.id),
        deduped: true,
      };
    }
  }

  // TX-1: append the `.requested` event AND insert the proposal atomically, so a
  // proposal can never exist without its originating spine event (and the
  // correlation linkage is always consistent). BEHAVIOR CHANGE (intentional): a
  // `.requested` append failure now ROLLS BACK the proposal instead of being
  // swallowed — an un-traceable proposal is worse than a surfaced error.
  // Notifications run AFTER commit (never hold the tx across network/queue work).
  const { proposal, pendingInput, deduped } = await db.transaction(
    async (tx) => {
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

      const pendingInput: CreatePendingProposalInput = {
        userId,
        workspaceId: workspaceId ?? null,
        targetType: singularType,
        targetId,
        proposalType: action,
        data: {
          ...storedData,
          ...(reqEventId ? { requestedEventId: reqEventId } : {}),
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
        stepRunId: stepRunId ?? null,
        nodeId: nodeId ?? null,
        notificationDescription: reasoning ?? `${action} ${singularType}`,
        governanceReason: governanceReason ?? null,
      };

      const { proposal: created, deduped } = await createPendingProposalRow(
        pendingInput,
        tx
      );
      return { proposal: created, pendingInput, deduped };
    }
  );

  // Post-commit notifications (broadcast / side-effects / notification center).
  // A dedup hit returned a pre-existing proposal — it already notified when
  // first created, so don't re-notify (avoids a double toast for the reviewer).
  if (deduped) {
    logger.info(
      { proposalId: proposal.id, deduped: true },
      "proposal deduped (returned existing)"
    );
  } else {
    await notifyProposalCreated(proposal, pendingInput);
  }

  return {
    granted: false,
    proposalId: proposal.id,
    proposalType: `${subjectType}.${action}`,
    summary,
    reasoning: reasoning ?? `${action} ${singularType} requires your approval`,
    reviewPath: openPath(proposal.id),
    reviewUrl: openLink(proposal.id),
    ...(deduped ? { deduped: true } : {}),
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
  /**
   * Decision-only mode: resolve the SAME verdict (is this actor an agent that
   * would file a join proposal?) and return the dry-run sentinel instead of
   * creating anything. The agent-user confirmation above the short-circuit is a
   * READ and still runs, so the non-agent → `null` → hard-deny fallthrough is
   * preserved verbatim.
   */
  dryRun?: boolean;
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
}): Promise<PermissionResult | DryRunPropose | null> {
  const {
    dryRun,
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

  // Verdict resolved (agent → join proposal). In dry-run stop here: everything
  // below either reads to build the card or WRITES the proposal.
  if (dryRun) return DRY_RUN_PROPOSE;

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
    stringField(data, "goal") ??
    stringField(data, "title") ??
    stringField(data, "name") ??
    stringField(data, "displayName") ??
    stringField(data, "label");
  if (inline) return inline;

  if (subjectType === "entity" && isLikelyUUID(targetId)) {
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

  // Mirror entity title lookup for focus sessions (goal is the display name).
  if (subjectType === "focus_session" && isLikelyUUID(targetId)) {
    try {
      const [session] = await db
        .select({ goal: focusSessions.goal })
        .from(focusSessions)
        .where(eq(focusSessions.id, targetId))
        .limit(1);
      return session?.goal ?? undefined;
    } catch {
      return undefined;
    }
  }

  return undefined;
}

function stringField(
  record: Record<string, unknown>,
  key: string
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}
