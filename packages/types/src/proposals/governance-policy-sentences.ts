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
  PROJECT_FILING:
    "Filing these records into a project shows them to the project's members, so a person approves it.",
  CRITERIA_CHANGE:
    "An agent is changing the acceptance criteria its own work is graded against; a person must approve them.",
  POSSIBLE_DUPLICATE:
    "This looks like something that already exists or is already waiting for review; a person decides whether to keep both.",
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

// ─── Automation defaults ─────────────────────────────────────────────────────
//
// The jobs-side gate (`automation-governance.ts`, `steps/output.ts`,
// `lifecycle-move.ts`) wrote its own placeholders as `reasoning` too: a rule
// "asks before starting this playbook", "Automation proposed updating an
// entity." They describe the MECHANISM, never the cause — the review page now
// names the rule as the proposal's origin, so drawing them as the WHY repeats
// it in worse words. Same contract as above: the writers compose them with
// these builders, the recognizer below reads the same spellings.

/** A propose-mode rule matched one subject and asks before running its playbook. */
export function ruleRunSentence(): string {
  return "A rule set to propose matched — it asks before starting this playbook.";
}

/** A propose-mode rule's batch: several subjects arrived together. */
export function ruleBatchRunSentence(opts: {
  /** Who arrived: the first names ("Ada, Grace + 2 more") or a count. */
  who: string;
  /** What approving starts: the quoted playbook name, or "this playbook". */
  what: string;
}): string {
  return `${opts.who} arrived together and matched this rule — approving starts ${opts.what} on each; rejecting starts none.`;
}

/** The automation gate's no-reason placeholder. */
export function automationWriteSentence(): string {
  return "This automation write matched no auto-approve rule, so it was routed here for your review.";
}

/** An automation output step's write that was proposed: "creating an entity". */
export function automationProposedSentence(doing: string): string {
  return `Automation proposed ${doing}.`;
}

/** An automation's lifecycle move with no reason of its own. */
export function automationMovesSentence(property: string, to: string): string {
  return `Automation moves ${property} to "${to}".`;
}

const RULE_BATCH_RUN_RE =
  /^.+ arrived together and matched this rule — approving starts .+ on each; rejecting starts none\.$/;
const AUTOMATION_PROPOSED_RE = /^Automation proposed [a-z]+ an? [a-z_ ]+\.$/;
const AUTOMATION_MOVES_RE = /^Automation moves \S+ to ".*"\.$/;
const AUTOMATION_FIXED: ReadonlySet<string> = new Set([
  ruleRunSentence(),
  automationWriteSentence(),
]);

// Tokens are single words (`create`, `focus_session`, `renderer.set`) — no space.
const DEFAULT_APPROVAL_RE = /^\S+ \S+ requires your approval\.?$/;
const ROLE_EXCEED_RE =
  /^\S+ \S+ exceeds (?:the agent's|your) workspace role \([^)]*\) — proposed for (?:your|a reviewer's) approval$/;

/**
 * True when `text` was written by the pod, not by the proposer: the engine's
 * policy sentence, the no-reason placeholder, the role-exceed line, or one of
 * the automation gate's defaults (a rule's run ask, a batch, an output step's
 * write, a lifecycle move). A
 * reader drops it rather than drawing it as the proposer's WHY.
 */
export function isSystemReasoning(text: string | null | undefined): boolean {
  if (typeof text !== "string") return false;
  const t = text.trim();
  return (
    isGovernancePolicySentence(t) ||
    DEFAULT_APPROVAL_RE.test(t) ||
    ROLE_EXCEED_RE.test(t) ||
    AUTOMATION_FIXED.has(t) ||
    RULE_BATCH_RUN_RE.test(t) ||
    AUTOMATION_PROPOSED_RE.test(t) ||
    AUTOMATION_MOVES_RE.test(t)
  );
}
