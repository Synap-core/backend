/**
 * The governance engine's "why a person must approve" sentences, keyed by the
 * code stored as `proposals.governance_reason`.
 *
 * WHY THIS EXISTS. Until 2026-10-12 the pod stored the sentence as the
 * proposal's `data.reasoning` whenever the proposer gave none, and the review
 * page drew it as the agent's own WHY ("An agent is creating a workspace …").
 * New rows no longer carry it (`permission-check.ts` passes it as
 * `policyReason`); rows already written still do. A reader uses
 * `isGovernancePolicySentence` to tell the policy's words from the proposer's.
 *
 * HOME: `PROPOSE_REASON` in `@synap/governance-policy`. This is a MIRROR, not a
 * re-export: governance-policy cannot depend on @synap-core/types (types →(dev)
 * @synap/database → governance-policy → types is a build cycle). The api
 * tripwire `governance-policy-sentences-mirror.test.ts` imports BOTH and fails
 * on any drift: edit PROPOSE_REASON, then copy the object here.
 */
export const GOVERNANCE_POLICY_SENTENCES = {
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
  CRITERIA_CHANGE:
    "An agent is changing the acceptance criteria its own work is graded against; a person must approve them.",
  DESTRUCTIVE_HARD_FLOOR:
    "Destructive action (delete/archive/purge/merge) always requires human approval.",
  GOVERNANCE_RULE: "Matched a governance rule requiring human approval.",
  UNTRUSTED_ORIGIN:
    "This write originates from an untrusted channel (external / bridge) and requires human approval before it is applied.",
  DAILY_WRITE_CEILING:
    "This agent has reached its daily auto-execute write ceiling; further writes require human approval today.",
  HUMAN_GATE:
    "This is a human gate — a person must approve it, and no governance rule can widen it.",
  ARBITRARY_EXECUTION:
    "This runs an arbitrary shell command inside the pod's API container and always requires human approval; no governance rule can widen it.",
  POD_ADMIN_SCHEMA_CHANGE:
    "This adds a required field or a default to a system kind, which changes every workspace at once; a pod admin must approve it.",
  AGENT_SCHEMA_DEFINITION:
    "An agent is defining a new kind or role, which changes what the pod can hold; a person must approve it, and no governance rule can widen it.",
  HUMAN_ONLY_STATUS:
    "Only a person may move this into that status; no governance rule can widen it.",
  LIFECYCLE_TERMINAL:
    "An agent is closing this (moving it into a done or lost status); a person approves that by default.",
  AGENT_STRUCTURE_WRITE:
    "An agent is creating a workspace, cell, playbook or automation (or switching one on), which changes what the pod does; a person must approve it, and no governance rule can widen it.",
} as const;

const SENTENCES: ReadonlySet<string> = new Set(
  Object.values(GOVERNANCE_POLICY_SENTENCES)
);

/** True when `text` is one of the policy's own sentences, not a proposer's words. */
export function isGovernancePolicySentence(
  text: string | null | undefined
): boolean {
  return typeof text === "string" && SENTENCES.has(text.trim());
}

// ─── The pod's other system-written "why" sentences ──────────────────────────
//
// Besides the engine's sentence above, the gate wrote two DEFAULTS of its own
// into `data.reasoning` when the proposer gave none: the generic placeholder,
// and the RBAC "exceeds your workspace role" line. Both read on the review page
// as the proposer's own WHY. The pod now returns them to the caller and the
// notification only (`policyReason`); rows already written still carry them.
// The builders below are the ONE spelling — `permission-check.ts` composes its
// sentences with them, so the recognizer cannot drift from the writer.

/** "<action> <type> requires your approval" — the gate's no-reason placeholder. */
export function defaultApprovalSentence(action: string, type: string): string {
  return `${action} ${type} requires your approval`;
}

/**
 * The RBAC role-exceed sentence: a member (agent or person) whose workspace
 * role cannot run this write directly, so it was proposed instead.
 */
export function roleExceedSentence(opts: {
  action: string;
  subjectType: string;
  role: string;
  proposer: "agent" | "person";
}): string {
  return opts.proposer === "agent"
    ? `${opts.action} ${opts.subjectType} exceeds the agent's workspace role (${opts.role}) — proposed for your approval`
    : `${opts.action} ${opts.subjectType} exceeds your workspace role (${opts.role}) — proposed for a reviewer's approval`;
}

// Tokens are single words (`create`, `focus_session`, `renderer.set`) — no space.
const DEFAULT_APPROVAL_RE = /^\S+ \S+ requires your approval\.?$/;
const ROLE_EXCEED_RE =
  /^\S+ \S+ exceeds (?:the agent's|your) workspace role \([^)]*\) — proposed for (?:your|a reviewer's) approval$/;

/**
 * True when `text` was written by the pod, not by the proposer: the engine's
 * policy sentence, the no-reason placeholder, or the role-exceed line. A
 * reader drops it rather than drawing it as the proposer's WHY.
 */
export function isSystemReasoning(text: string | null | undefined): boolean {
  if (typeof text !== "string") return false;
  const t = text.trim();
  return (
    isGovernancePolicySentence(t) ||
    DEFAULT_APPROVAL_RE.test(t) ||
    ROLE_EXCEED_RE.test(t)
  );
}
