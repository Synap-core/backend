/**
 * @synap/governance-policy
 *
 * SINGLE SOURCE OF TRUTH for AI governance POLICY — the pure, I/O-free decision
 * core shared by the two governance gates:
 *   - checkPermissionOrPropose()       (packages/api/src/utils/permission-check.ts)
 *   - checkAutomationWriteOrPropose()   (packages/jobs/src/utils/automation-governance.ts)
 *
 * Both previously hand-copied these constants and the agent-policy precedence
 * ladder. Because `@synap/api` depends on `@synap/jobs`, the jobs side could not
 * import the canonical gate without a cycle, so it kept a forked MIRROR with an
 * explicit "DRIFT RISK" TODO. This package is that lower, dependency-free home —
 * it removes the fork.
 *
 * It contains NO database / event / proposal side effects — ONLY the decision.
 * Each caller still: runs RBAC, fetches the agent + workspace rows, then calls
 * `decideAgentPolicy()` and maps the verdict onto its own
 * execute / propose / deny side effects (createProposal, audit insert, etc.).
 *
 * Precedence ladder (applied only after RBAC passes and the actor is confirmed
 * to be an agent user):
 *   1. CBAC capability allowlist  → deny if the agent lacks the capability
 *   2. ADMIN_ACTIONS              → always propose
 *   3. writesRequireProposal      → propose on non-pure-read writes
 *   4. agent-owned + destructive  → propose
 *   5. per-channel capability gate → block / propose / (act → fall through)
 *   6. autoApproveFor whitelist   → execute
 *   7. default                    → propose
 */

// ---------------------------------------------------------------------------
// Constants — the policy values (formerly duplicated in both gates)
// ---------------------------------------------------------------------------

/** Proposals auto-expire after this many days if not reviewed. */
export const PROPOSAL_TTL_DAYS = 30;

/**
 * Default whitelist: agent actions that bypass proposal review.
 * Workspaces override via `settings.aiGovernance.autoApproveFor`.
 * When `governanceMode === "agent-owned"`, destructive actions always propose.
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

/** Actions that always require a proposal in agent-owned workspaces. */
export const DESTRUCTIVE_ACTIONS: readonly string[] = [
  "delete",
  "archive",
  "purge",
];

/**
 * Administrative actions that ALWAYS require a proposal, regardless of
 * auto-approve overrides, the writesRequireProposal flag, or the whitelist.
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
 * Filesystem paths ALWAYS blocked for external agent writes, regardless of user
 * approval or workspace settings. Backend enforcement layer (the synap-os skill
 * also enforces these on the OpenClaw side as the first line of defence).
 */
export const BLOCKED_FILESYSTEM_PATHS: readonly RegExp[] = [
  /synap[-_]backend/i,
  /synap[-_]intelligence/i,
  /synap[-_]realtime/i,
  /docker-compose/i,
  /\.env(?:\.|$)/,
  /\.env\.local/,
  /\.env\.production/,
  /^\/etc\//,
  /^\/usr\//,
  /^\/bin\//,
  /^\/sbin\//,
  /^\/root\//,
  /^\/sys\//,
  /^\/proc\//,
  /^\/dev\//,
  /private\.key/i,
  /\.pem$/i,
  /id_rsa/i,
  /authorized_keys/i,
];

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export type RequiredPermission = "read" | "write" | "delete" | "manage";

/**
 * Map an action verb → the RBAC permission it requires.
 *
 * NOTE: this is the CANONICAL gate's mapping (it includes "place"). The old
 * jobs fork omitted "place" — a silent divergence this consolidation removes by
 * adopting the canonical superset. Automations only emit create/update, so the
 * fork's effective behavior is unchanged.
 */
export function requiredPermissionFor(action: string): RequiredPermission {
  if (action === "delete") return "delete";
  if (
    action === "create" ||
    action === "update" ||
    action === "archive" ||
    action === "restore" ||
    action === "add" ||
    action === "place" ||
    action === "remove" ||
    action === "updateRole"
  ) {
    return "write";
  }
  return "read";
}

/** True if the path matches any always-blocked filesystem pattern. */
export function isBlockedFilesystemPath(path: string): boolean {
  return BLOCKED_FILESYSTEM_PATHS.some((re) => re.test(path));
}

/** Glob match for action patterns: exact, or "<subject>.*" prefix. */
export function matchesActionPattern(
  eventKey: string,
  patterns: readonly string[]
): boolean {
  return patterns.some((pattern) =>
    pattern.endsWith(".*")
      ? eventKey.startsWith(pattern.slice(0, -2))
      : eventKey === pattern
  );
}

/** True if the event key is auto-approved by the (possibly overridden) whitelist. */
export function isAutoApproved(
  eventKey: string,
  autoApproveFor: readonly string[] = DEFAULT_AUTO_APPROVE
): boolean {
  return matchesActionPattern(eventKey, autoApproveFor);
}

/**
 * CBAC: does the agent's capability allowlist permit this event key?
 * Supports exact ("entity.create"), subject wildcard ("entity.*"), and "*.*".
 */
export function agentHasCapability(
  eventKey: string,
  subjectType: string,
  capabilities: readonly string[]
): boolean {
  return (
    capabilities.includes(eventKey) ||
    capabilities.includes(`${subjectType}.*`) ||
    capabilities.includes("*.*")
  );
}

/** Pure-read actions are exempt from write-governance (capabilities/proposal). */
export function isPureReadAction(
  subjectType: string,
  action: string,
  eventKey: string = `${subjectType}.${action}`
): boolean {
  return (
    action.endsWith(".read") ||
    subjectType === "search" ||
    subjectType === "context" ||
    subjectType === "memory" ||
    eventKey.endsWith(".read") ||
    eventKey === "memory.recall" ||
    /^search\./.test(eventKey) ||
    /^context\./.test(eventKey) ||
    /^memory\./.test(eventKey)
  );
}

// ---------------------------------------------------------------------------
// Per-channel capability grant (multiplayer rooms)
// ---------------------------------------------------------------------------

/**
 * Per-channel capability grant for an AI teammate writing in a multiplayer room.
 * These can only TIGHTEN a teammate's effective grant for this channel, never
 * widen its workspace RBAC.
 */
export interface ChannelCapabilityGrant {
  canDraft: boolean;
  canPropose: boolean;
  canAct: boolean;
}

/** The three outcomes a channel capability grant can force for a write. */
export type ChannelCapabilityDecision = "act" | "propose" | "block";

/**
 * Collapse a per-channel capability grant into a single governance decision.
 * CONSERVATIVE BY DESIGN: absent or all-false grant → "propose", never "act".
 * `canAct` is the only path to "act"; draft-only (no propose, no act) → "block".
 */
export function resolveChannelCapabilityDecision(
  grant: Partial<ChannelCapabilityGrant> | null | undefined
): ChannelCapabilityDecision {
  if (!grant) return "propose";
  if (grant.canAct === true) return "act";
  if (grant.canPropose === true) return "propose";
  return "block";
}

// ---------------------------------------------------------------------------
// The decision ladder
// ---------------------------------------------------------------------------

export interface AgentPolicyInput {
  subjectType: string;
  /** The write action verb (create / update / delete / …). */
  action: string;
  /** The agent's explicit capability allowlist. Empty/absent → unrestricted. */
  agentCapabilities?: readonly string[] | null;
  /** From the agent's metadata — assistant-template agents propose on writes. */
  writesRequireProposal?: boolean;
  /** Workspace governanceMode — "agent-owned" forces destructive → propose. */
  governanceMode?: string | null;
  /** Workspace override; defaults to DEFAULT_AUTO_APPROVE when undefined. */
  autoApproveFor?: readonly string[];
  /**
   * Effective per-channel capability grant when the write is evaluated inside a
   * multiplayer channel. Absent/undefined → no per-channel tightening.
   */
  channelCapabilities?: Partial<ChannelCapabilityGrant> | null;
}

/**
 * The verdict. For `propose`, `reason` is the DEFAULT reasoning to use when the
 * caller has no explicit reasoning (caller pattern: `opts.reasoning ?? reason`).
 * `reason` is absent for the plain default-propose case, matching the gates'
 * prior behavior of passing through the caller's reasoning unchanged.
 */
export type AgentPolicyVerdict =
  | { verdict: "execute" }
  | { verdict: "propose"; reason?: string }
  | { verdict: "deny"; reason: string };

/** Default reasoning strings (kept identical to the prior inline gate strings). */
export const PROPOSE_REASON = {
  ADMIN: "Administrative action requires human approval.",
  WRITES_REQUIRE_PROPOSAL: "Agent requires proposal for all write operations.",
  AGENT_OWNED_DESTRUCTIVE:
    "Destructive action in agent-owned workspace requires human approval.",
  CHANNEL_PROPOSE:
    "Teammate may propose in this channel; write requires human approval.",
} as const;

const CHANNEL_BLOCK_REASON =
  "Teammate is draft-only in this channel and may not commit writes (can_act and can_propose are both off).";

/**
 * Decide the agent governance verdict. PURE — no I/O. Apply ONLY after RBAC has
 * passed and the actor is confirmed to be an agent user.
 */
export function decideAgentPolicy(input: AgentPolicyInput): AgentPolicyVerdict {
  const { subjectType, action } = input;
  const eventKey = `${subjectType}.${action}`;

  // 1. CBAC capability allowlist (empty/absent = unrestricted).
  const caps = input.agentCapabilities;
  if (
    caps &&
    caps.length > 0 &&
    !agentHasCapability(eventKey, subjectType, caps)
  ) {
    return {
      verdict: "deny",
      reason: `Agent capability check failed for "${eventKey}". Allowed: ${caps.join(", ")}.`,
    };
  }

  // 2. ADMIN_ACTIONS → always propose.
  if (ADMIN_ACTIONS.includes(eventKey)) {
    return { verdict: "propose", reason: PROPOSE_REASON.ADMIN };
  }

  // 3. writesRequireProposal → propose on non-pure-read writes.
  if (
    input.writesRequireProposal === true &&
    !isPureReadAction(subjectType, action, eventKey)
  ) {
    return {
      verdict: "propose",
      reason: PROPOSE_REASON.WRITES_REQUIRE_PROPOSAL,
    };
  }

  // 4. agent-owned workspace + destructive → propose.
  if (
    input.governanceMode === "agent-owned" &&
    DESTRUCTIVE_ACTIONS.includes(action)
  ) {
    return {
      verdict: "propose",
      reason: PROPOSE_REASON.AGENT_OWNED_DESTRUCTIVE,
    };
  }

  // 5. Per-channel capability gate (writes only; reads exempt).
  if (
    input.channelCapabilities !== undefined &&
    input.channelCapabilities !== null &&
    !isPureReadAction(subjectType, action, eventKey)
  ) {
    const decision = resolveChannelCapabilityDecision(
      input.channelCapabilities
    );
    if (decision === "block") {
      return { verdict: "deny", reason: CHANNEL_BLOCK_REASON };
    }
    if (decision === "propose") {
      return { verdict: "propose", reason: PROPOSE_REASON.CHANNEL_PROPOSE };
    }
    // decision === "act" → fall through to the auto-approve whitelist.
  }

  // 6. autoApproveFor whitelist → execute.
  if (isAutoApproved(eventKey, input.autoApproveFor)) {
    return { verdict: "execute" };
  }

  // 7. Default → propose (caller supplies its own reasoning).
  return { verdict: "propose" };
}
