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
  ADMIN: "This changes how your pod is run, so it waits for you.",
  WRITES_REQUIRE_PROPOSAL: "This agent asks before every change.",
  AGENT_OWNED_DESTRUCTIVE:
    "This removes something from an agent's workspace, so it waits for you.",
  CHANNEL_PROPOSE:
    "In this channel a teammate can suggest changes, but only you can apply them.",
  USER_OBSERVATION_INFERENCE:
    "The AI guessed this about you, so it is only saved if you confirm it.",
  CAPABILITY_PROPOSE: "Running this tool needs your OK first.",
  SCOPE_IDENTITY_CHANGE:
    "This changes what the record is or where it shows, so it waits for you.",
  PROJECT_FILING:
    "Filing these into a project shows them to its members, so you approve it.",
  CRITERIA_CHANGE:
    "An agent wants to change the criteria its own work is checked against, so you decide.",
  POSSIBLE_DUPLICATE:
    "This looks like something you already have or that is already waiting for review, so you decide whether to keep both.",
  DESTRUCTIVE_HARD_FLOOR:
    "This deletes, archives, purges or merges something, so it always waits for you.",
  GOVERNANCE_RULE: "One of your rules says to ask you first.",
  UNTRUSTED_ORIGIN:
    "This came from outside, such as an external app or a bridge, so nothing is applied until you approve it.",
  DAILY_WRITE_CEILING:
    "This agent used up today's automatic writes, so the rest wait for you.",
  HUMAN_GATE: "This is a decision only you can make, and no rule can skip it.",
  ARBITRARY_EXECUTION:
    "This runs a shell command on your pod, so it always waits for you.",
  POD_ADMIN_SCHEMA_CHANGE:
    "This adds a required field or a default to a built-in kind and changes every workspace, so a pod admin must approve it.",
  AGENT_SCHEMA_DEFINITION:
    "An agent wants to define a new kind of thing for your pod, so you approve it, and no rule can skip that.",
  HUMAN_ONLY_STATUS: "Only you can move this into that status.",
  LIFECYCLE_TERMINAL:
    "An agent wants to close this (done or lost), so it waits for you unless you have said otherwise.",
  AGENT_STRUCTURE_WRITE:
    "An agent wants to create or switch on a workspace, cell, playbook or automation, which changes what your pod does, so you approve it, and no rule can skip that.",
} as const;

/**
 * The engine's sentences as they read until 2026-10-21. Proposals written
 * before the rewording still carry one of these as `data.reasoning`, so the
 * recognizer keeps matching them; nothing writes them any more. Frozen: never
 * edit, only drop once no pod holds such a row.
 */
const LEGACY_GOVERNANCE_POLICY_SENTENCES: readonly string[] = [
  "Administrative action requires human approval.",
  "Agent requires proposal for all write operations.",
  "Destructive action in agent-owned workspace requires human approval.",
  "Teammate may propose in this channel; write requires human approval.",
  "AI-inferred observation about the user requires human validation before it is stored.",
  "Capability execution requires human approval.",
  "This change alters the record's scope or identity and requires human approval.",
  "Filing these records into a project shows them to the project's members, so a person approves it.",
  "An agent is changing the acceptance criteria its own work is graded against; a person must approve them.",
  "This looks like something that already exists or is already waiting for review; a person decides whether to keep both.",
  "Destructive action (delete/archive/purge/merge) always requires human approval.",
  "Matched a governance rule requiring human approval.",
  "This write originates from an untrusted channel (external / bridge) and requires human approval before it is applied.",
  "This agent has reached its daily auto-execute write ceiling; further writes require human approval today.",
  "This is a human gate — a person must approve it, and no governance rule can widen it.",
  "This runs an arbitrary shell command inside the pod's API container and always requires human approval; no governance rule can widen it.",
  "This adds a required field or a default to a system kind, which changes every workspace at once; a pod admin must approve it.",
  "An agent is defining a new kind or role, which changes what the pod can hold; a person must approve it, and no governance rule can widen it.",
  "Only a person may move this into that status; no governance rule can widen it.",
  "An agent is closing this (moving it into a done or lost status); a person approves that by default.",
  "An agent is creating a workspace, cell, playbook or automation (or switching one on), which changes what the pod does; a person must approve it, and no governance rule can widen it.",
];

const SENTENCES: ReadonlySet<string> = new Set([
  ...Object.values(GOVERNANCE_POLICY_SENTENCES),
  ...LEGACY_GOVERNANCE_POLICY_SENTENCES,
]);

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
