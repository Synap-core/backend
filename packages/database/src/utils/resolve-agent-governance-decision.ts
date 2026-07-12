import { eq } from "drizzle-orm";
import { users, type AgentMetadata } from "../schema/users.js";
import { workspaces, type WorkspaceSettings } from "../schema/workspaces.js";
import {
  decideAgentPolicy,
  getWorkspaceGovernanceMode,
  PROPOSE_REASON,
  type ChannelCapabilityGrant,
} from "@synap/governance-policy";

/**
 * Shared agent-governance orchestration — the SINGLE SOURCE OF TRUTH for the
 * `(b) confirm-agent → (c) load-workspace-settings → (d) decideAgentPolicy →
 * (e) verdict` ladder that BOTH governance doors run:
 *   - `checkPermissionOrPropose` (@synap/api — the chat-AI write path)
 *   - `checkAutomationWriteOrPropose` (@synap/jobs — the automation write path)
 *
 * WHY IT LIVES HERE (packages/database/src/utils/, next to
 * `insertPendingProposal` / `openRunSession`):
 *   @synap/api depends on @synap/jobs (api → jobs), so a shared helper in api
 *   would be a circular import for the jobs door. Pushed down to @synap/database
 *   — which both layers already depend on AND which already depends on
 *   @synap/governance-policy — it is importable by both without a cycle. The two
 *   doors used to fork this ladder inline (the automation copy carried a
 *   documented DRIFT RISK); this collapses them.
 *
 * WHAT STAYS WITH EACH CALLER (deliberately NOT here):
 *   - Step (a) the RBAC `verifyPermission` call and its FAILURE handling — the
 *     chat door files workspace-join / role-insufficient proposals on failure,
 *     the automation door simply denies. Those side effects diverge, so RBAC is
 *     each caller's concern; this helper runs AFTER RBAC has passed.
 *   - The `propose`/`execute` SIDE EFFECTS (proposal creation, auto-approve
 *     audit row, broadcasts) — legitimately different between the two doors.
 *
 * This helper is PURE of side effects: it reads two rows and returns a plain
 * verdict. `db` is INJECTED (like `verifyPermission({ db, … })`) so the caller's
 * connection — and the test's mock — flow straight through.
 */

/** The injected Drizzle handle. Type-only reference — never loads the pg client. */
type DbHandle = typeof import("../client-pg.js").db;

export interface ResolveAgentGovernanceInput {
  /** Injected Drizzle handle (the caller's `db`). */
  db: DbHandle;
  /**
   * The acting agent's user id. Chat door: `agentUserId`. Automation door:
   * `ownerId` (the automation's owning principal). The helper confirms it is
   * actually an agent user before applying agent policy.
   */
  agentUserId: string;
  /** Null/undefined for pod-scope (no workspace lens) — settings load is skipped. */
  workspaceId?: string | null;
  subjectType: string;
  action: string;
  /**
   * Per-channel capability grant (chat door, when inside a multiplayer channel).
   * Automation writes are never channel writes → omitted → no per-channel tightening.
   */
  channelCapabilities?: Partial<ChannelCapabilityGrant> | null;
  /** Write subject's profile slug (chat door, governance-by-kind). Automation omits. */
  subjectProfileSlug?: string | null;
  /** `uo_validated` of a user_observation subject (chat door). Automation omits. */
  subjectUoValidated?: boolean | null;
  /** Force a proposal even on an otherwise auto-approved write (chat door). Automation omits. */
  forcePropose?: boolean;
  /**
   * `autoApproveFor` precedence — the ONE decideAgentPolicy input that differs
   * between the doors, preserved EXACTLY:
   *   - chat door (`true`): the agent's own `agentMetadata.autoApproveFor` wins,
   *     falling back to the workspace override.
   *   - automation door (`false`): only the workspace override is consulted.
   */
  preferAgentMetadataAutoApproveFor: boolean;
}

/**
 * The resolved verdict. `not-agent` means the actor is not an agent user, so the
 * caller applies its own non-agent handling (chat: fall through to the legacy
 * AI-source path; automation: human-RBAC-only → grant). `execute` carries the
 * resolved workspace `explicitAutoApproveFor` so the chat door can stamp the
 * auto-approve audit row's `matchedPattern` exactly as before.
 */
export type AgentGovernanceResolution =
  | { decision: "not-agent" }
  | { decision: "deny"; reason: string }
  | { decision: "propose"; reason?: string }
  | { decision: "execute"; explicitAutoApproveFor?: readonly string[] };

export async function resolveAgentGovernanceDecision(
  input: ResolveAgentGovernanceInput
): Promise<AgentGovernanceResolution> {
  const { db, agentUserId, workspaceId, subjectType, action } = input;

  // (b) Confirm the actor is an agent user (defence-in-depth) + load metadata.
  const [agentUser] = await db
    .select({
      userType: users.userType,
      agentMetadata: users.agentMetadata,
    })
    .from(users)
    .where(eq(users.id, agentUserId))
    .limit(1);

  if (agentUser?.userType !== "agent") {
    return { decision: "not-agent" };
  }

  // (c) Load workspace settings + compute agent-owned-workspace. At pod scope
  // (no workspace) there is no override source; both fall back to absent.
  const [ws] = workspaceId
    ? await db
        .select({
          settings: workspaces.settings,
          workspaceType: workspaces.workspaceType,
        })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1)
    : [undefined];

  const settings = ws?.settings as WorkspaceSettings | undefined;
  const isAgentOwnedWorkspace =
    ws?.workspaceType === "agent" && settings?.linkedAgentId === agentUserId;

  const explicitAutoApproveFor = settings?.aiGovernance?.autoApproveFor;
  const agentMetadata = agentUser.agentMetadata as AgentMetadata | null;

  // (d) Agent governance policy — SINGLE SOURCE OF TRUTH in
  // @synap/governance-policy. Absent optional inputs (the automation door omits
  // channel/profile/uo/forcePropose) read as `undefined`, identical to not
  // passing them, so each door's verdict is byte-identical to its prior inline call.
  const decision = decideAgentPolicy({
    subjectType,
    action,
    agentCapabilities: agentMetadata?.capabilities,
    writesRequireProposal: agentMetadata?.writesRequireProposal === true,
    governanceMode: getWorkspaceGovernanceMode(settings),
    autoApproveFor: input.preferAgentMetadataAutoApproveFor
      ? (agentMetadata?.autoApproveFor ?? explicitAutoApproveFor)
      : explicitAutoApproveFor,
    isAgentOwnedWorkspace,
    channelCapabilities: input.channelCapabilities,
    subjectProfileSlug: input.subjectProfileSlug,
    subjectUoValidated: input.subjectUoValidated,
    forcePropose: input.forcePropose,
  });

  // (e) Verdict → plain resolution. All side effects stay with the caller.
  if (decision.verdict === "deny") {
    return { decision: "deny", reason: decision.reason };
  }
  if (decision.verdict === "propose") {
    return { decision: "propose", reason: decision.reason };
  }
  return { decision: "execute", explicitAutoApproveFor };
}

// ---------------------------------------------------------------------------
// Dry-run entry point (AI Teaching Substrate — governance dry-run)
// ---------------------------------------------------------------------------

/** Which door is asking — controls the ONE input that differs between them. */
export type GovernanceDoor = "chat" | "automation";

export interface DryRunAgentGovernanceInput {
  db: DbHandle;
  userId?: string | null;
  agentUserId: string;
  workspaceId?: string | null;
  subjectType: string;
  action: string;
  profileSlug?: string | null;
  door: GovernanceDoor;
}

/**
 * A `(subjectType, action, profileSlug?)` write "would this auto-apply or
 * propose?" preview — the pure query behind the brief composer's governance
 * verdict and the `GET /workspaces/:id/governance` dry-run query params.
 *
 * SIDE-EFFECT FREE: reuses `resolveAgentGovernanceDecision`/`decideAgentPolicy`
 * (both pure) and MUST NEVER reach `createProposal` or insert anything — it
 * only reads the agent + workspace rows and returns a verdict. Never call
 * this from a real write path; it exists purely for teaching/preview UIs.
 *
 * `door` maps 1:1 to `preferAgentMetadataAutoApproveFor` — the ONE
 * `decideAgentPolicy` input that differs between the two real gates:
 *   - "chat"       → true  (permission-check.ts:708, the chat-AI write path —
 *                    the agent's own `agentMetadata.autoApproveFor` wins,
 *                    falling back to the workspace override)
 *   - "automation" → false (packages/jobs/src/utils/automation-governance.ts:151,
 *                    the automation write path — only the workspace override
 *                    is consulted)
 * `subjectUoValidated` / `channelCapabilities` / `forcePropose` are
 * deliberately omitted here: the dry-run previews the BASE verdict for a
 * subject kind, not a specific in-flight write's per-instance signals (a real
 * `user_observation` write, a channel-scoped write, or a forced proposal
 * still resolve through the real gates at execution time).
 */
export async function dryRunAgentGovernanceDecision(
  input: DryRunAgentGovernanceInput
): Promise<{
  outcome: "auto" | "propose" | "deny";
  rung: string;
  reason: string;
}> {
  const resolution = await resolveAgentGovernanceDecision({
    db: input.db,
    agentUserId: input.agentUserId,
    workspaceId: input.workspaceId,
    subjectType: input.subjectType,
    action: input.action,
    subjectProfileSlug: input.profileSlug,
    preferAgentMetadataAutoApproveFor: input.door === "chat",
  });

  switch (resolution.decision) {
    case "not-agent":
      // Not an agent user — the real gates fall through to the legacy
      // AI-source / direct-user path, which always executes/grants. The
      // dry-run has no agent policy to preview here, so it reports "auto"
      // with that reasoning rather than fabricating a ladder rung.
      return {
        outcome: "auto",
        rung: "not-agent",
        reason:
          "The acting user is not an agent — the agent governance ladder does not apply.",
      };
    case "deny":
      return {
        outcome: "deny",
        rung: "cbac-capability-allowlist",
        reason: resolution.reason,
      };
    case "propose":
      return {
        outcome: "propose",
        rung: resolution.reason ? reasonToRung(resolution.reason) : "default",
        reason: resolution.reason ?? "No auto-approve rule matched.",
      };
    case "execute":
      return {
        outcome: "auto",
        rung: resolution.explicitAutoApproveFor
          ? "workspace-auto-approve-for"
          : "default-auto-approve",
        reason: resolution.explicitAutoApproveFor
          ? `Matched the workspace's explicit autoApproveFor list.`
          : "Matched the default auto-approve whitelist (or agent/workspace ownership).",
      };
  }
}

/**
 * Map a `decideAgentPolicy` propose-reason string back to the ladder rung
 * name that produced it — for the dry-run verdict's `rung` field only (a
 * human-readable "which one" companion; never consulted by real gates).
 */
function reasonToRung(reason: string): string {
  switch (reason) {
    case PROPOSE_REASON.ADMIN:
      return "admin-actions";
    case PROPOSE_REASON.SCOPE_IDENTITY_CHANGE:
      return "force-propose";
    case PROPOSE_REASON.DESTRUCTIVE_HARD_FLOOR:
      return "destructive-actions-hard-floor";
    case PROPOSE_REASON.USER_OBSERVATION_INFERENCE:
      return "user-observation-inference";
    case PROPOSE_REASON.CAPABILITY_PROPOSE:
      return "per-capability-governance";
    case PROPOSE_REASON.AGENT_OWNED_DESTRUCTIVE:
      return "agent-owned-workspace-destructive";
    case PROPOSE_REASON.WRITES_REQUIRE_PROPOSAL:
      return "writes-require-proposal";
    case PROPOSE_REASON.CHANNEL_PROPOSE:
      return "per-channel-capability-gate";
    default:
      return "default";
  }
}
