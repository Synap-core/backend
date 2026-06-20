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
 *   2. ADMIN_ACTIONS              → always propose (even for owned workspace)
 *   2.5 user_observation by KIND  → INFERENCE propose / EXPLICIT execute
 *                                    (governs by the observation's nature, NOT
 *                                     the routing workspace — see below)
 *   2.6 per-capability governance → auto execute / propose / block deny
 *                                    (capability RUNS only; no-ops for data
 *                                     writes; a channel grant may still tighten
 *                                     an "auto" capability — see below)
 *   3. isAgentOwnedWorkspace      → execute (non-destructive) / propose (destructive)
 *   4. explicit autoApproveFor    → execute (overrides writesRequireProposal)
 *   5. writesRequireProposal      → propose on non-pure-read writes
 *   6. agent-owned mode + destructive → propose
 *   7. per-channel capability gate → block / propose / (act → fall through)
 *   8. DEFAULT_AUTO_APPROVE       → execute
 *   9. default                    → propose
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
  // Playbooks & Capability Substrate — reads auto-approve; create/update/archive
  // intentionally omitted so they route to a proposal in agent workspaces.
  "playbook.read",
  "tool.read",
  "link.read",
  "capability.read",
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

/**
 * Which whitelist pattern matched this event key (for audit attribution), or
 * undefined if none. Same glob rule as {@link matchesActionPattern} — this is
 * the "which one" companion to that function's "any". Use it instead of
 * re-deriving the glob inline so the matcher lives in exactly one place.
 */
export function findMatchingPattern(
  eventKey: string,
  patterns: readonly string[]
): string | undefined {
  return patterns.find((pattern) =>
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
   * True when the acting agent is the owner of the target workspace
   * (workspace.linkedAgentId === agentUserId && workspaceType === "agent").
   * Ownership bypasses writesRequireProposal for non-destructive writes.
   * Destructive actions (delete/archive/purge) still propose even for the owner.
   * ADMIN_ACTIONS always propose regardless of ownership.
   */
  isAgentOwnedWorkspace?: boolean;
  /**
   * Effective per-channel capability grant when the write is evaluated inside a
   * multiplayer channel. Absent/undefined → no per-channel tightening.
   */
  channelCapabilities?: Partial<ChannelCapabilityGrant> | null;
  /**
   * The entity profile slug of the write SUBJECT (e.g. "user_observation"),
   * when the write targets an entity. Used by the governance-by-KIND rule:
   * a `user_observation` is governed by the nature of the observation, not by
   * the routing workspace. Absent/undefined → rule does not fire.
   */
  subjectProfileSlug?: string | null;
  /**
   * The `uo_validated` property of a `user_observation` subject. Distinguishes
   * an EXPLICIT observation (user-stated, validated === true → auto-approve)
   * from an INFERENCE (AI-inferred, anything else → propose). Only consulted
   * when `subjectProfileSlug === "user_observation"`.
   */
  subjectUoValidated?: boolean | null;
  /**
   * The capability's resolved approval-state, when this gate call governs a
   * CAPABILITY EXECUTION (tool/skill/command run) rather than a data write.
   * Sourced from the capability read-model's `governance` field (today derived
   * from the tool/skill `approved` column) once it is backed by persisted state.
   * Absent → not a capability run → rung 2.6 no-ops (data-write paths unchanged).
   */
  capabilityGovernance?: "auto" | "propose" | "block" | null;
  /**
   * The GRANT's exec-mode (the `grant_exec_mode` enum / `@synap/playbooks
   * ExecMode` — the PERSISTABLE truth: `auto | propose`). Narrows the
   * capability's own approval-state for THIS grant: "propose" forces a reviewable
   * per-run proposal even if the capability is "auto". When present it takes
   * precedence over capabilityGovernance in rung 2.6.
   *
   * NOTE: exec-mode lives in TWO layers. `dry-run` is the third persistable
   * grant_exec_mode value but is a GATE-level concern — `gateCapabilityExecution`
   * short-circuits it to a preview BEFORE calling `decideAgentPolicy`, so it never
   * reaches this policy union. The retired `propose-each`/`block` values were
   * orphaned (never persistable in the grant column); `propose` already covers
   * what `propose-each` meant, and deny comes from no-grant / not-approved, not a
   * `block` mode.
   */
  capabilityExecMode?: "auto" | "propose" | null;
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
  USER_OBSERVATION_INFERENCE:
    "AI-inferred observation about the user requires human validation before it is stored.",
  CAPABILITY_PROPOSE: "Capability execution requires human approval.",
} as const;

const CHANNEL_BLOCK_REASON =
  "Teammate is draft-only in this channel and may not commit writes (can_act and can_propose are both off).";

const CAPABILITY_BLOCKED_REASON =
  "Capability is present but disabled (governance/exec-mode resolved to block).";

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

  // 2. ADMIN_ACTIONS → always propose (even for owned workspace).
  if (ADMIN_ACTIONS.includes(eventKey)) {
    return { verdict: "propose", reason: PROPOSE_REASON.ADMIN };
  }

  // 2.5 GOVERNANCE BY KIND — user_observation.
  // A `user_observation` entity is governed by the NATURE of the observation,
  // not by the routing workspace: an INFERENCE (AI-inferred about the user) is
  // always proposed for human validation; an EXPLICIT observation (user-stated,
  // uo_validated === true) auto-approves. This precedes ownership / autoApprove /
  // writesRequireProposal precisely BECAUSE the routing workspace must not change
  // the verdict — an inference must never silently land just because it routed
  // through an agent-owned workspace, and an explicit one must not be forced into
  // a proposal there either. Pure-read actions on the profile are exempt (a
  // `user_observation.read` is just a read). Only fires for write actions.
  if (
    input.subjectProfileSlug === "user_observation" &&
    !isPureReadAction(subjectType, action, eventKey)
  ) {
    return input.subjectUoValidated === true
      ? { verdict: "execute" }
      : {
          verdict: "propose",
          reason: PROPOSE_REASON.USER_OBSERVATION_INFERENCE,
        };
  }

  // 2.6 PER-CAPABILITY GOVERNANCE (capability runs only).
  // Fires ONLY when `capabilityGovernance` is present — i.e. the gate resolved a
  // tool/skill/command RUN. Orthogonal to DATA writes: a plain entity.create
  // carries no `capabilityGovernance`, so this rung no-ops for every data write
  // (the two new fields absent → byte-identical to the prior verdict). Sits after
  // CBAC (rung 1) and ADMIN_ACTIONS (rung 2) — a capability the agent isn't
  // allowed must still deny first, and admin actions are non-negotiable — but
  // BEFORE ownership/autoApprove/writesRequireProposal, because the per-grant
  // exec-mode is the most specific, operator-authored signal about THIS run and
  // must not be silently overridden by the routing workspace.
  if (input.capabilityGovernance) {
    const mode = input.capabilityExecMode ?? input.capabilityGovernance;
    //   "auto"    → execute (operator pre-approved this capability)
    //   "propose" → propose  (reviewable capability.run proposal)
    //   "block"   → deny     (capability present but disabled — reachable only via
    //                         capabilityGovernance; the grant exec-mode is just
    //                         auto|propose, dry-run handled at the gate)
    if (mode === "block") {
      return { verdict: "deny", reason: CAPABILITY_BLOCKED_REASON };
    }
    if (mode !== "auto") {
      return { verdict: "propose", reason: PROPOSE_REASON.CAPABILITY_PROPOSE };
    }
    // mode === "auto": a per-channel grant (rung 7) can only TIGHTEN, never
    // widen. If this run is inside a channel and the channel resolves stricter
    // (propose/block), the stricter wins — so we do NOT short-circuit to execute
    // here; we fall through to let the channel layer (rung 7) tighten. Only when
    // there is no channel context does an "auto" capability execute outright.
    if (
      input.channelCapabilities === undefined ||
      input.channelCapabilities === null
    ) {
      return { verdict: "execute" };
    }
    const channelDecision = resolveChannelCapabilityDecision(
      input.channelCapabilities
    );
    if (channelDecision === "act") {
      // Channel also permits acting → the capability's "auto" stands.
      return { verdict: "execute" };
    }
    if (channelDecision === "block") {
      return { verdict: "deny", reason: CHANNEL_BLOCK_REASON };
    }
    return { verdict: "propose", reason: PROPOSE_REASON.CHANNEL_PROPOSE };
  }

  // 3. Agent owns this workspace (linkedAgentId === agentUserId, workspaceType="agent").
  // Ownership is the cleanest trust signal: the agent's memory workspace is its domain.
  // Non-destructive writes execute directly; destructive still propose.
  if (input.isAgentOwnedWorkspace === true) {
    if (DESTRUCTIVE_ACTIONS.includes(action)) {
      return {
        verdict: "propose",
        reason: PROPOSE_REASON.AGENT_OWNED_DESTRUCTIVE,
      };
    }
    return { verdict: "execute" };
  }

  // 4. Explicit workspace autoApproveFor → execute (overrides writesRequireProposal).
  // Only fires when the workspace has an explicit list (not undefined).
  // DEFAULT_AUTO_APPROVE fallback is checked after writesRequireProposal (step 8).
  if (
    input.autoApproveFor !== undefined &&
    isAutoApproved(eventKey, input.autoApproveFor)
  ) {
    return { verdict: "execute" };
  }

  // 5. writesRequireProposal → propose on non-pure-read writes.
  if (
    input.writesRequireProposal === true &&
    !isPureReadAction(subjectType, action, eventKey)
  ) {
    return {
      verdict: "propose",
      reason: PROPOSE_REASON.WRITES_REQUIRE_PROPOSAL,
    };
  }

  // 6. agent-owned workspace mode + destructive → propose.
  // (Distinct from step 3: covers workspaces with governanceMode="agent-owned"
  // where the acting agent is NOT necessarily the owner.)
  if (
    input.governanceMode === "agent-owned" &&
    DESTRUCTIVE_ACTIONS.includes(action)
  ) {
    return {
      verdict: "propose",
      reason: PROPOSE_REASON.AGENT_OWNED_DESTRUCTIVE,
    };
  }

  // 7. Per-channel capability gate (writes only; reads exempt).
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
    // decision === "act" → fall through to default autoApproveFor.
  }

  // 8. DEFAULT_AUTO_APPROVE whitelist → execute.
  // Uses DEFAULT_AUTO_APPROVE when input.autoApproveFor is undefined.
  // Explicit list was already checked at step 4.
  if (isAutoApproved(eventKey, input.autoApproveFor)) {
    return { verdict: "execute" };
  }

  // 9. Default → propose (caller supplies its own reasoning).
  return { verdict: "propose" };
}
