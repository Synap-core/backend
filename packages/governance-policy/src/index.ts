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
 *   2.5 DESTRUCTIVE_ACTIONS hard floor → always propose (delete/archive/purge/
 *                                    merge), regardless of ANY override rung
 *                                    below (ownership, explicit autoApproveFor,
 *                                     DEFAULT_AUTO_APPROVE, capability
 *                                     governance). EXCEPTION: caller opts in
 *                                     via `allowDestructiveAutoApprove` (the
 *                                     future "Crazy" mode) — see below.
 *   2.6 user_observation by KIND  → INFERENCE propose / EXPLICIT execute
 *                                    (governs by the observation's nature, NOT
 *                                     the routing workspace — see below)
 *   2.7 per-capability governance → auto execute / propose / block deny
 *                                    (capability RUNS only; no-ops for data
 *                                     writes; a channel grant may still tighten
 *                                     an "auto" capability — see below)
 *   2.8 governance_rules store    → additive: auto execute / propose (fires
 *                                    ONLY when the caller resolved a matching
 *                                    rule; undefined = no-op, falls through
 *                                    byte-identical — see below)
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
  "terminal.read_logs",
  // NOTE — `channel.create` and `playbook.create` are DELIBERATELY NOT here.
  // A channel and a playbook are SURFACES, not data: creating one changes what
  // exists in the operator's world (a new room, a new process) in a way they must
  // be able to SEE and ACCEPT — the proposal system is visibility + acceptance,
  // not only governance. So create-NEW of these should route to a proposal even in
  // the permissive tiers ("don't spin up a channel I don't know exists"). RESOLVE
  // of an EXISTING channel is a different action (channel.resolve/ensure/bind) and
  // must stay instant — agent reply / proactive flows that reuse a channel never
  // block.
  //   • playbook.create — ENFORCED: playbooks.ts calls checkPermissionOrPropose
  //     ({subjectType:"playbook", action:"create"}), which reads this list.
  //   • channel.create  — POLICY-ONLY for now: the agent channel-create door (Hub
  //     `resolveOrCreateChannel`) has no governance gate and the builtin verb is
  //     grant-gated (action="run"), so this key isn't consulted yet. Wiring the
  //     create-new→proposal gate on the Hub route (create-vs-resolve + a channel
  //     proposal executor) is a tracked follow-up — see policy.test.ts.
  // Automation/link creates stay instant (they wire existing capabilities, no new
  // durable surface). `tool.create` / `skill.create` were already excluded (they
  // define new EGRESS abilities).
  "automation.create",
  "link.create",
  // Focus-session lifecycle = non-destructive work-orchestration (open a
  // session, advance its stage, update progress), less sensitive than the data
  // creates above. Auto-approving lets an agent open/advance an event-mode
  // session in the capture channel without a proposal ("capture channel = no
  // proposals"). `focus_session.grant_capability` is DELIBERATELY excluded — it
  // widens a session's egress abilities, so it still routes to a proposal.
  // delete/archive remain destructive → proposal.
  "focus_session.create",
  "focus_session.update",
  "focus_session.stage_changed",
  "playbook.read",
  "tool.read",
  "link.read",
  "capability.read",
  // Kind + Facets (Wave 1B): attaching/updating a role-profile facet on an
  // entity is additive and non-destructive — same trust tier as
  // entity.create/update above. `facet.detach` is ALSO auto-approved here:
  // it is a soft-delete (FacetRepository.detach() never hard-deletes), so a
  // re-attach after an unwanted detach is a normal, idempotent-friendly
  // recovery — no different in reversibility from the entity edits already
  // whitelisted. (Contrast with entity/document DELETE, which stays
  // proposal-gated via DESTRUCTIVE_ACTIONS.)
  "facet.attach",
  "facet.update",
  "facet.detach",
];

/**
 * Actions that always require a proposal — hard floor in decideAgentPolicy
 * (rung 2.5), regardless of ownership / autoApproveFor / DEFAULT_AUTO_APPROVE.
 *
 * Includes `merge` so entity near-duplicate merges (pod hygiene) and channel
 * branch merges can never auto-execute. Format used by the floor is the bare
 * action verb; event keys are `${subjectType}.${action}` (e.g. `entity.merge`).
 */
export const DESTRUCTIVE_ACTIONS: readonly string[] = [
  "delete",
  "archive",
  "purge",
  "merge",
];

/**
 * The ONE canonical reader of `workspaces.settings.governanceMode`. Both
 * `resolveAgentGovernanceDecision` (@synap/database) and
 * `getEffectiveGovernance` (@synap/api's permission-check.ts) used to read
 * this field with their own inline cast — this collapses them to one typed
 * accessor. Structurally typed (not `WorkspaceSettings`) so this
 * dependency-free package never has to import a database schema type.
 * Unrecognized/absent values normalize to "standard" (the canonical default),
 * matching both callers' prior behavior.
 */
export function getWorkspaceGovernanceMode(
  settings: { governanceMode?: unknown } | null | undefined
): "standard" | "agent-owned" {
  return settings?.governanceMode === "agent-owned"
    ? "agent-owned"
    : "standard";
}

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
 * Read-only action verbs actually passed into `requiredPermissionFor` across
 * the codebase (search.entities, memory.recall, entity.read, and the explicit
 * "read" verb used by filesystem.read-style checks). Kept as an exported list
 * so the read set and the fail-closed fallback below are provably exhaustive
 * against the same inventory the tests assert on.
 */
const READ_ACTIONS: readonly string[] = ["read", "recall", "entities"];

/**
 * The complete inventoried action-verb vocabulary (see policy.test.ts's
 * INVENTORIED_VERBS for the regenerate recipe). The soft-union parameter type
 * on requiredPermissionFor gives call sites autocomplete + typo detection
 * without breaking dynamic (string-typed) callers — a new verb still compiles,
 * still fail-closes to "write", and should then be added here + to the
 * explicit mapping + the test fixture.
 */
export type KnownGovernanceAction =
  | "read"
  | "recall"
  | "entities"
  | "delete"
  | "purge"
  | "create"
  | "update"
  | "archive"
  | "restore"
  | "add"
  | "place"
  | "remove"
  | "updateRole"
  | "renderer.set"
  | "attach"
  | "detach"
  | "updateCapabilities"
  | "merge"
  | "create_branch"
  | "create_external"
  | "join"
  | "link"
  | "setState"
  | "execute"
  | "run"
  | "grant_capability"
  | "register"
  | "arrange"
  | "invite"
  | "recap"
  | "declare_source"
  | "configure_public_projection"
  | "write";

/**
 * Map an action verb → the RBAC permission it requires.
 *
 * NOTE: this is the CANONICAL gate's mapping (it includes "place"). The old
 * jobs fork omitted "place" — a silent divergence this consolidation removes by
 * adopting the canonical superset. Automations only emit create/update, so the
 * fork's effective behavior is unchanged.
 *
 * Wave 2F hardening: this used to fall through unmatched verbs to "read" —
 * under-gating any write verb nobody had thought to enumerate yet (RBAC would
 * only require read permission for it). The fallback below now returns
 * "write" instead: a full inventory of every `action` string passed to
 * checkPermissionOrPropose / checkAutomationWriteOrPropose across
 * packages/api and packages/jobs was taken (see policy.test.ts's
 * `INVENTORIED_VERBS` fixture for the regenerate recipe) and every verb found
 * is now listed explicitly below, so the fallback should be unreachable for
 * known call sites — it exists purely as a fail-closed floor for a future verb
 * nobody has enumerated yet. Conservative-by-design: an unrecognized verb now
 * demands "write" (propose/deny for under-privileged agents) rather than
 * silently passing as a read.
 */
export function requiredPermissionFor(
  action: KnownGovernanceAction | (string & {})
): RequiredPermission {
  if (action === "delete" || action === "purge") return "delete";
  if (READ_ACTIONS.includes(action)) return "read";
  if (
    action === "create" ||
    action === "update" ||
    action === "archive" ||
    action === "restore" ||
    action === "add" ||
    action === "place" ||
    action === "remove" ||
    action === "updateRole" ||
    action === "renderer.set" ||
    // Kind + Facets (Wave 1B): facet.attach / facet.update / facet.detach.
    // "detach" is a soft-delete (reversible), so it maps to "write" here, not
    // "delete" — the DESTRUCTIVE_ACTIONS floor in decideAgentPolicy only
    // checks for the literal verbs "delete"/"archive"/"purge", so detach is
    // correctly NOT hard-floored to always-propose.
    action === "attach" ||
    action === "detach" ||
    // Wave 2F additions — every other mutating verb found in the inventory.
    action === "updateCapabilities" ||
    action === "merge" ||
    action === "create_branch" ||
    action === "create_external" ||
    action === "join" ||
    action === "link" ||
    action === "setState" ||
    action === "execute" ||
    action === "run" ||
    action === "grant_capability" ||
    action === "register" ||
    action === "arrange" ||
    action === "invite" ||
    // run-session-recap.ts gates the recap write under this verb.
    action === "recap" ||
    // Enterprise-OS Wave 0: declaring a workspace data edge
    // (synap_declare_workspace_source / Hub source-edges) is a governed write.
    action === "declare_source" ||
    // Setting a workspace's public-projection config (Hub
    // public-projection door) is a governed write — same editor+ floor.
    action === "configure_public_projection" ||
    action === "write"
  ) {
    return "write";
  }
  // Fail-closed floor: an unrecognized verb demands "write" rather than
  // silently under-gating as "read". See the doc comment above.
  return "write";
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
      ? eventKey.startsWith(pattern.slice(0, -1))
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
      ? eventKey.startsWith(pattern.slice(0, -1))
      : eventKey === pattern
  );
}

/**
 * Validate a caller-supplied `autoApproveFor` list for entries that EXPLICITLY
 * name a DESTRUCTIVE action (delete/archive/purge/merge). Used by the write-side
 * gates (agent-users governance PATCH, workspace settings writer) to reject a
 * grant BEFORE it is persisted.
 *
 * Only explicit destructive verbs are rejected — e.g. "delete", "purge",
 * "entity.delete", "document.archive", "entity.merge". Wildcards ("*", "*.*",
 * "entity.*") are ALLOWED: the `decideAgentPolicy` DESTRUCTIVE_ACTIONS hard
 * floor (rung 2.5) is the real backstop — it blocks destructive auto-approval
 * regardless of the whitelist, so no wildcard can ever auto-approve a
 * delete/merge. Rejecting wildcards here (an earlier iteration did) would break
 * the built-in "Crazy" governance preset, whose value is literally `["*"]`. This
 * validator therefore only stops an operator from EXPLICITLY listing a
 * destructive verb — a setting the floor would silently override anyway, so
 * blocking it keeps the config honest.
 *
 * Entries are trimmed + lower-cased before matching. Returns the (original)
 * entries that failed validation (empty = all OK).
 */
export function findUnsafeAutoApproveEntries(
  entries: readonly string[]
): string[] {
  return entries.filter((raw) => {
    const entry = raw.trim().toLowerCase();
    const action = entry.includes(".")
      ? entry.slice(entry.lastIndexOf(".") + 1)
      : entry;
    return (DESTRUCTIVE_ACTIONS as readonly string[]).includes(action);
  });
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
   * Destructive actions (delete/archive/purge/merge) still propose even for the owner.
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
   * Absent → not a capability run → rung 2.7 no-ops (data-write paths unchanged).
   */
  capabilityGovernance?: "auto" | "propose" | "block" | null;
  /**
   * The GRANT's exec-mode (the `grant_exec_mode` enum / `@synap/playbooks
   * ExecMode` — the PERSISTABLE truth: `auto | propose`). Narrows the
   * capability's own approval-state for THIS grant: "propose" forces a reviewable
   * per-run proposal even if the capability is "auto". When present it takes
   * precedence over capabilityGovernance in rung 2.7.
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
  /**
   * Force a PROPOSAL even when the action would otherwise auto-approve. Set by a
   * caller for a scope/identity-bearing write that must always be reviewed
   * (e.g. promoting an entity workspace→pod-wide, or changing its profile TYPE).
   * Honored AFTER the CBAC deny (rung 1) and ADMIN (rung 2) rungs, so a
   * capability-denied or admin action is unaffected, but BEFORE every execute
   * path below. Absent/false → no effect (all existing verdicts unchanged).
   */
  forcePropose?: boolean;
  /**
   * Explicit opt-in that lets a DESTRUCTIVE action (delete/archive/purge/merge)
   * be resolved to "execute" by a downstream override rung (ownership, explicit
   * autoApproveFor, DEFAULT_AUTO_APPROVE, capability governance). Absent/false
   * (the default) → destructive actions ALWAYS propose, mirroring the
   * ADMIN_ACTIONS hard floor. This is the raw escape hatch for a future
   * "Crazy" mode, which is not yet first-class on the agent/workspace record.
   * TODO: wire to a first-class Crazy mode instead of a raw boolean once one
   * becomes a persisted, resolvable setting.
   */
  allowDestructiveAutoApprove?: boolean;
  /**
   * The resolved `governance_rules` store verdict for this
   * (principal, scope, target) tuple — rung 2.8. Resolved by the caller
   * (`resolveGovernanceRule` in @synap/database, which has `db`; this engine
   * stays pure). `"auto"` executes, `"propose"` proposes; absent/undefined
   * means no rule matched and the rung no-ops, falling through
   * byte-identical to every rung below. NEVER `"deny"` — a rule can only
   * widen or keep-reviewable, never close a door a floor already opened.
   */
  governanceRuleVerdict?: "auto" | "propose";
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
  SCOPE_IDENTITY_CHANGE:
    "This change alters the record's scope or identity and requires human approval.",
  DESTRUCTIVE_HARD_FLOOR:
    "Destructive action (delete/archive/purge/merge) always requires human approval.",
  GOVERNANCE_RULE: "Matched a governance rule requiring human approval.",
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

  // 2.1 CALLER-FORCED PROPOSAL — a scope/identity-bearing write.
  // The caller signalled that this edit changes the record's SCOPE or IDENTITY
  // (not a field patch), e.g. promoting a workspace entity to pod-wide, or
  // changing its profile TYPE. Such a change must always be reviewed even when
  // the action would otherwise auto-approve. Sits after CBAC (rung 1) and ADMIN
  // (rung 2) so a capability-denied action still denies and admin actions are
  // unaffected, but BEFORE every execute path below.
  if (input.forcePropose === true) {
    return { verdict: "propose", reason: PROPOSE_REASON.SCOPE_IDENTITY_CHANGE };
  }

  // 2.5 DESTRUCTIVE_ACTIONS hard floor — mirrors ADMIN_ACTIONS: a destructive
  // action (delete/archive/purge/merge) can NEVER be resolved to "execute" by
  // ANY override rung below — ownership (rung 3), explicit autoApproveFor
  // (rung 4), capability governance (rung 2.7), or DEFAULT_AUTO_APPROVE
  // (rung 8). Without this floor, an operator whitelisting a broad pattern
  // like "entity.*" or "*" via autoApproveFor would silently auto-approve
  // deletes/merges (rung 4 had no destructive check, unlike rungs 3 and 6).
  // EXCEPTION: `allowDestructiveAutoApprove` is the raw opt-in for the future
  // "Crazy" mode. Default (absent/false) → always propose.
  // TODO: wire to a first-class Crazy mode instead of a raw boolean.
  if (
    DESTRUCTIVE_ACTIONS.includes(action) &&
    input.allowDestructiveAutoApprove !== true
  ) {
    return {
      verdict: "propose",
      reason: PROPOSE_REASON.DESTRUCTIVE_HARD_FLOOR,
    };
  }

  // 2.6 GOVERNANCE BY KIND — user_observation.
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

  // 2.7 PER-CAPABILITY GOVERNANCE (capability runs only).
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

  // 2.8 GOVERNANCE_RULES store — additive; fires ONLY when the caller resolved
  // a matching rule (`resolveGovernanceRule`, @synap/database — has `db`; this
  // engine stays pure). Sits after every floor (2 ADMIN, 2.1 forcePropose, 2.5
  // DESTRUCTIVE, 2.6 by-kind) and after 2.7 (capability governance), but BEFORE
  // ownership (rung 3) and autoApproveFor (rungs 4/8): a stored rule is a more
  // specific, operator-authored signal than the routing workspace's ownership
  // or blanket whitelist, so it should win over them — but it can never
  // override a floor (all four floors already returned above) and can never
  // deny (the store's verdict enum is auto|propose only, never deny). When no
  // rule matched, `governanceRuleVerdict` is undefined and this rung no-ops,
  // falling through byte-identical to every rung below.
  if (input.governanceRuleVerdict) {
    return input.governanceRuleVerdict === "auto"
      ? { verdict: "execute" }
      : { verdict: "propose", reason: PROPOSE_REASON.GOVERNANCE_RULE };
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
