/**
 * A `governance_rules` row in WORDS: who it is for, where it holds, what it
 * covers, its verdict and where it came from. ONE home for every surface that
 * lists standing rules (pod admin, the desktop's Approvals, the phone through
 * `@synap-core/hooks/proposal-renderer`).
 *
 * WHY HERE. pod admin kept a copy of the browser's helpers "verbatim, in sync
 * by hand", and within weeks it read a computers rule as "Any agent" (its row
 * type had no `class` principal), "This workspace" for "This space", a raw
 * `Action "@reversible"`, and "From settings" for "Standing override". This
 * module is pure (the vocabulary door only), takes a STRUCTURAL row so each
 * app keeps its own derived row type (api-types in the browser, the router
 * output in pod admin), and every word comes from the vocabulary door.
 *
 * NOT HERE: anything that needs a UI type (the browser's `verdictMark` builds
 * an `OverviewMark`), the retro-impact input, and date formatting.
 */

import {
  buildObjectActionTitle,
  resolveActionLabel,
  resolveGovernanceRungLabel,
  resolveObjectNoun,
  resolveObjectNounPlural,
} from "../vocabulary/index.js";

/**
 * Who a rule is for: one agent, any agent, or a CLASS of agents (0320; today
 * only `machine`, "for all computers"). The router's `principalKind` enum
 * reads this list, and it asserts the stored enum is the same set, so a new
 * kind is a build error in {@link humanizePrincipal} until it is named.
 */
export const GOVERNANCE_PRINCIPAL_KINDS = ["agent", "any", "class"] as const;
export type GovernancePrincipalKind =
  (typeof GOVERNANCE_PRINCIPAL_KINDS)[number];

/** What a rule targets (`governance_rules.target_kind`). */
export type GovernanceRuleTargetKind =
  "action" | "profile" | "capability" | "connection";

/**
 * The fields of a rule row these helpers read. Structural on purpose: the
 * browser derives its row from `@synap-core/api-types`, pod admin from the
 * router output, and both satisfy it.
 */
export interface GovernanceRuleRowLike {
  principalKind: GovernancePrincipalKind;
  agentUserId: string | null;
  agentLabel: string | null;
  /** Set when `principalKind` is `class`: which class (`machine`). */
  principalClass: string | null;
  scopeKind: "workspace" | "pod";
  targetKind: GovernanceRuleTargetKind;
  targetPattern: string;
  targetProfile: string | null;
  verdict: "auto" | "propose" | "deny";
  sourceProposalId: string | null;
}

// ─── An action's run mode (one tool action, every AI, the whole pod) ─────

/**
 * How ONE action of a tool runs when an AI asks for it, as the person sets it
 * on the tool's page or by "Approve always" on one of its requests:
 *   - `auto`  — runs on its own (an active pod-wide `auto` capability rule);
 *   - `ask`   — asks first (no such rule: the gate's default for a tool run);
 *   - `never` — refused (an active pod-wide `deny` capability rule).
 * Stored as ONE `governance_rules` row: principal `any`, scope `pod`, target
 * `capability` naming the action (its stable name). Written only by the
 * person door `governanceRules.setActionMode`; words:
 * `resolveActionRunModeLabel` (vocabulary).
 */
export const ACTION_RUN_MODES = ["auto", "ask", "never"] as const;
export type ActionRunMode = (typeof ACTION_RUN_MODES)[number];

/** The mode a stored verdict means; no active rule asks first. */
export function actionRunModeOf(
  verdict: "auto" | "propose" | "deny" | null | undefined
): ActionRunMode {
  if (verdict === "auto") return "auto";
  if (verdict === "deny") return "never";
  return "ask";
}

// ─── The two class patterns and their words ─────────────────────────────

/**
 * The governance CLASS pattern for the pod default "reversible writes act"
 * (`REVERSIBLE_CLASS_PATTERN` in `@synap/governance-policy`). Pinned equal by
 * that package's `reversible-default.test.ts`.
 */
export const REVERSIBLE_CLASS_PATTERN = "@reversible";

/**
 * The governance CLASS pattern for the pod default "an agent organises its
 * OWN FRESH work directly" (FB1020 B3: filing its records into a project the
 * person named, filing its own session there, closing its own task;
 * `OWN_ORGANISE_CLASS_PATTERN` in `@synap/governance-policy`, pinned the same
 * way).
 */
export const OWN_ORGANISE_CLASS_PATTERN = "@own-organise";

/**
 * The pod's two class defaults in words: THE copy for the switch on the
 * desktop and on the phone ("How agents act"), and for the rule list's title
 * of the row each switch owns. ONE home, so the surfaces cannot word one rule
 * twice (FB1020 wave 2, S5 / S13). "In the last day" is the proof window
 * (`isOwnFreshWork`, 24 h), never "today".
 */
export const POD_DEFAULT_WORDS: Readonly<
  Record<string, { label: string; line: string }>
> = {
  [REVERSIBLE_CLASS_PATTERN]: {
    label: "Act directly on changes that can be undone",
    line: "Agents create, edit and link without asking, each change listed with Undo. Deleting, sharing, new kinds or fields, structure and anything sent outside always ask.",
  },
  [OWN_ORGANISE_CLASS_PATTERN]: {
    label: "Tidy their own new work",
    line: "Agents file what they made in the last day into the project you named, and close their own tasks. Each is listed with Undo; anything you changed since still asks.",
  },
};

/**
 * A governance write MOTIF (`entity.update`, `note.delete`) in words, with the
 * machine pattern kept alongside: the words make the ask answerable ("Update
 * note"), the token is what will literally be written to
 * `governance_rules.target_pattern`, and a reviewer widening an agent's lane
 * is entitled to see the exact string they authorise.
 */
export function describeWritePattern(pattern: string): string {
  if (pattern === REVERSIBLE_CLASS_PATTERN) {
    return `Any change that can be undone (${pattern})`;
  }
  if (pattern === OWN_ORGANISE_CLASS_PATTERN) {
    return `An agent tidying its own new work (${pattern})`;
  }
  // Wildcards are words too: `*` alone, `note.*` and `*.create` each say
  // "any" in words rather than printing the star as a noun or a verb.
  if (pattern === "*") return "Any write (*)";
  const dot = pattern.lastIndexOf(".");
  if (dot <= 0) return pattern;
  if (pattern.slice(dot + 1) === "*") {
    return `Any ${resolveObjectNoun(pattern.slice(0, dot))} write (${pattern})`;
  }
  if (pattern.slice(0, dot) === "*") {
    return `Any ${resolveActionLabel(pattern.slice(dot + 1), "imperative").toLowerCase()} (${pattern})`;
  }
  const title = buildObjectActionTitle({
    action: pattern.slice(dot + 1),
    objectKind: pattern.slice(0, dot),
    mood: "imperative",
  });
  return title ? `${title} (${pattern})` : pattern;
}

/** The words for a write pattern, without the pattern echoed in brackets. */
export function writePatternTitle(pattern: string): string {
  if (pattern === "*") return "Every action";
  const full = describeWritePattern(pattern);
  const suffix = ` (${pattern})`;
  return full.endsWith(suffix) ? full.slice(0, -suffix.length) : full;
}

/**
 * A rule's TITLE, what it covers in words only. An action rule carrying a
 * `targetProfile` matches ONLY that kind, so the kind is part of its name:
 * "Update · Notes". `null` for a non-action rule, whose naming needs data a
 * pure function does not have ({@link ruleTitle} names those).
 */
export function governanceRuleTitle(rule: {
  targetKind: string;
  targetPattern: string;
  targetProfile?: string | null;
  /** The one object it names (0420), by its name, and the version it holds for. */
  targetSubjectLabel?: string | null;
  targetSubjectVersion?: number | null;
}): string | null {
  if (rule.targetKind !== "action") return null;
  // A rule naming ONE object holds for that object at one version only, so
  // both are its name: "Run playbook · Weekly review, version 3".
  if (rule.targetSubjectLabel) {
    const version =
      rule.targetSubjectVersion != null
        ? `, version ${rule.targetSubjectVersion}`
        : "";
    return `${writePatternTitle(rule.targetPattern)} · ${rule.targetSubjectLabel}${version}`;
  }
  // The row a pod switch owns is titled with the switch's own words (S13), so
  // the list and the switch read as one rule.
  const podDefault = rule.targetProfile
    ? undefined
    : POD_DEFAULT_WORDS[rule.targetPattern];
  if (podDefault) return podDefault.label;
  const title = writePatternTitle(rule.targetPattern);
  return rule.targetProfile
    ? `${title} · ${resolveObjectNounPlural(rule.targetProfile)}`
    : title;
}

// ─── A rule row in words ────────────────────────────────────────────────

/**
 * "For all computers" (MACHINE-IDENTITY-PLAN §2d): a `class` principal naming
 * every agent user of type `machine`. Its picker value and group key, one
 * spelling, so a form and a list cannot disagree.
 */
export const ALL_COMPUTERS_PRINCIPAL = "class:machine";

/** "All computers": the noun from the vocabulary door, never a local word. */
export function allComputersLabel(): string {
  return `All ${resolveObjectNounPlural("machine").toLowerCase()}`;
}

/** A list groups a rule under its agent, or under its class. */
export function principalGroupKey(
  rule: Pick<
    GovernanceRuleRowLike,
    "principalKind" | "agentUserId" | "principalClass"
  >
): string {
  if (rule.principalKind === "class")
    return `class:${rule.principalClass ?? "unknown"}`;
  return rule.agentUserId ?? "unknown";
}

type PrincipalRow = Pick<
  GovernanceRuleRowLike,
  "principalKind" | "agentLabel" | "principalClass"
>;

/** Keyed by every principal kind: a new kind does not build until it has words. */
const PRINCIPAL_WORDS: Readonly<
  Record<GovernancePrincipalKind, (rule: PrincipalRow) => string>
> = {
  agent: (rule) => rule.agentLabel ?? "an agent",
  class: (rule) =>
    rule.principalClass === "machine"
      ? allComputersLabel()
      : "A class of agents",
  any: () => "Any agent",
};

/** Who the rule is for: the agent's name, "All computers", or "Any agent". */
export function humanizePrincipal(rule: PrincipalRow): string {
  return PRINCIPAL_WORDS[rule.principalKind](rule);
}

/** Where the rule holds: pod-wide, or the space (its name when known). */
export function humanizeScope(
  rule: Pick<GovernanceRuleRowLike, "scopeKind">,
  workspaceName?: string
): string {
  if (rule.scopeKind === "pod") return "Pod-wide";
  return workspaceName ?? "This space";
}

export interface HumanizeTargetOptions {
  /**
   * Human label for a connection (registry row id → e.g. "Google"), resolved
   * by the caller from connection data it already holds. Absent or
   * unresolved → the target reads "A connection". The raw uuid is never shown.
   */
  connectionLabel?: (connectionId: string) => string | undefined;
}

type TargetRow = Pick<
  GovernanceRuleRowLike,
  "targetKind" | "targetPattern" | "targetProfile"
> & {
  /** The one object it names (0420), by its name, and the version it holds for. */
  targetSubjectLabel?: string | null;
  targetSubjectVersion?: number | null;
};

/** What the rule matches, in words. */
export function humanizeTarget(
  rule: TargetRow,
  opts: HumanizeTargetOptions = {}
): string {
  if (rule.targetKind === "connection") {
    const label = opts.connectionLabel?.(rule.targetPattern);
    return label ? `Keep syncing · ${label}` : "A connection";
  }
  if (rule.targetKind === "capability") {
    return `${resolveObjectNoun("capability")} "${rule.targetPattern}"`;
  }
  if (rule.targetKind === "profile") {
    return `Everything of type "${rule.targetProfile ?? "?"}"`;
  }
  // A rule naming ONE object reads by that object and its version, never as
  // the whole action ("Run playbook · Weekly review, version 3").
  if (rule.targetSubjectLabel) {
    const title = governanceRuleTitle(rule);
    if (title) return title;
  }
  // Every other action pattern (an exact key, a glob, the `@reversible` class)
  // is named by the ONE write-pattern derivation the proposal cards use: a raw
  // `Action "@reversible"` leaked to rule lists before.
  return rule.targetPattern === "*"
    ? "Every action"
    : describeWritePattern(rule.targetPattern);
}

/** A rule pattern's human TITLE, without the machine token. */
export const ruleTitleForPattern = writePatternTitle;

/**
 * A rule's title in a list: what it covers, in words only. Action rules go
 * through {@link governanceRuleTitle} (a profiled grant reads "Update ·
 * Notes"); the other targets through {@link humanizeTarget}.
 */
export function ruleTitle(
  rule: TargetRow,
  opts: HumanizeTargetOptions = {}
): string {
  return governanceRuleTitle(rule) ?? humanizeTarget(rule, opts);
}

/** The exact pattern a rule matches (its detail page), or null when it has none worth showing. */
export function rulePattern(rule: TargetRow): string | null {
  if (rule.targetKind === "connection") return null;
  if (rule.targetKind === "profile") return rule.targetProfile ?? null;
  // The profile narrows an action rule, so it is part of what it matches.
  return rule.targetProfile
    ? `${rule.targetPattern} · ${rule.targetProfile}`
    : rule.targetPattern;
}

/**
 * Is this the row BEHIND a root switch ("Act directly on changes that can be
 * undone", "Tidy their own new work")? `setReversibleDefault` /
 * `setOwnOrganiseDefault` own every row with exactly this shape (principal
 * any · scope pod · action · the class pattern), so revoking it anywhere else
 * would silently flip the switch.
 */
export function isRootSwitchRule(
  rule: Pick<
    GovernanceRuleRowLike,
    "principalKind" | "scopeKind" | "targetKind" | "targetPattern"
  >
): boolean {
  return (
    rule.principalKind === "any" &&
    rule.scopeKind === "pod" &&
    rule.targetKind === "action" &&
    (rule.targetPattern === REVERSIBLE_CLASS_PATTERN ||
      rule.targetPattern === OWN_ORGANISE_CLASS_PATTERN)
  );
}

/**
 * The user word for the governance-rules section: "Approvals" (concepts.md,
 * "which AI writes wait for me?"), through the vocabulary door. Never "Trust
 * rules", and never "Rules", which is the automation's word.
 */
export const APPROVALS_TITLE = resolveObjectNounPlural("governance_rule");

/** Product copy: where the root switch's rule is changed. */
export const ROOT_SWITCH_LINE = `Set by the switch on ${APPROVALS_TITLE}`;

/**
 * What revoking a rule does, in product words, for the rules whose
 * consequence is known: a connection rule is "keep syncing" for that
 * connection. `null` = the caller keeps its generic sentence.
 */
export function revokeConsequence(
  rule: Pick<GovernanceRuleRowLike, "targetKind" | "targetPattern">,
  opts: HumanizeTargetOptions = {}
): string | null {
  if (rule.targetKind !== "connection") return null;
  const label = opts.connectionLabel?.(rule.targetPattern) ?? "This connection";
  return `${label} will stop adding new items without review. Each sync waits for your review.`;
}

export type RuleProvenance = "settings" | "proposal";

/**
 * `sourceProposalId` is a clean binary: NULL = authored directly (a setting,
 * a manual `create`), non-NULL = authored by approving a proposal.
 */
export function ruleProvenance(
  rule: Pick<GovernanceRuleRowLike, "sourceProposalId">
): RuleProvenance {
  return rule.sourceProposalId ? "proposal" : "settings";
}

/** Where the rule came from. A rule set directly is a "Standing override" (founder, F3). */
export function provenanceLabel(
  rule: Pick<GovernanceRuleRowLike, "sourceProposalId">
): string {
  return ruleProvenance(rule) === "proposal"
    ? "From a proposal"
    : "Standing override";
}

/** A rule's verdict, or a dry run's outcome, in words: a `deny` reads the ladder's word for never. */
export function verdictLabel(verdict: string): string {
  if (verdict === "deny") return resolveGovernanceRungLabel("denied-by-rule");
  return verdict === "auto" ? "Auto-approve" : "Require proposal";
}

// ─── Letting agents run one playbook without asking (0420) ──────────────

/** The governed write an agent's playbook launch is (`playbooks.run`). */
export const PLAYBOOK_RUN_ACTION = "playbook.run";

/**
 * Why an agent's run is held although its person allowed the playbook (or an
 * earlier version) for agents. All but `version_changed` also say why a
 * playbook cannot be pre-approved at all (`governanceRules.forSubject`'s
 * `preApproval.reason`): it uses tools beyond the pod's data, runs on another
 * agent or computer, runs another playbook, or could not be checked.
 */
export const PRE_APPROVAL_HELD_REASONS = [
  "version_changed",
  "declares_tools",
  "runs_elsewhere",
  "runs_other_playbook",
  "could_not_check",
] as const;
export type PreApprovalHeldReason = (typeof PRE_APPROVAL_HELD_REASONS)[number];
/** Why a playbook cannot be pre-approved for agents, whatever its rules. */
export type PreApprovalIneligibleReason = Exclude<
  PreApprovalHeldReason,
  "version_changed"
>;

/** Is this stored value a {@link PreApprovalHeldReason}? */
export function isPreApprovalHeldReason(
  value: unknown
): value is PreApprovalHeldReason {
  return (
    typeof value === "string" &&
    (PRE_APPROVAL_HELD_REASONS as readonly string[]).includes(value)
  );
}

/**
 * The `governanceRules.create` input that lets agents run ONE playbook at ONE
 * version without asking (founder decision, 10 Nov 2026): any of the person's
 * OWN agents (the create door records the person as the rule's
 * `principalOwnerId`; another member's agent never matches), the playbook's
 * own space (pod-wide for a pod-wide playbook), the
 * exact action narrowed to that playbook. Any edit that bumps its version
 * leaves the rule matching nothing, so the next launch asks again. Built here
 * once, so no surface writes its own shape.
 */
export function playbookPreApprovalRule(playbook: {
  id: string;
  version: number;
  workspaceId: string | null;
}) {
  return {
    principalKind: "any" as const,
    ...(playbook.workspaceId
      ? { scopeKind: "workspace" as const, workspaceId: playbook.workspaceId }
      : { scopeKind: "pod" as const }),
    targetKind: "action" as const,
    targetPattern: PLAYBOOK_RUN_ACTION,
    targetSubjectId: playbook.id,
    targetSubjectVersion: playbook.version,
    verdict: "auto" as const,
  };
}

/** Whether agents may run a playbook without asking, read from its rules. */
export type PlaybookPreApprovalState =
  | { state: "allowed"; ruleId: string; version: number }
  /** Allowed for an earlier version: it changed since, so agents ask again. */
  | { state: "outdated"; allowedVersion: number }
  | { state: "none" };

/**
 * The state of a playbook's pre-approval from its ACTIVE rules
 * (`governanceRules.forSubject`): an `auto` rule on `playbook.run` naming it
 * at its current version allows it; one at another version is outdated. The
 * resolver matches on the same three facts (`scoreRuleTarget`).
 */
export function playbookPreApprovalState(
  rules: ReadonlyArray<{
    id: string;
    targetPattern: string;
    verdict: string;
    targetSubjectId?: string | null;
    targetSubjectVersion?: number | null;
  }>,
  playbook: { id: string; version: number }
): PlaybookPreApprovalState {
  const named = rules.filter(
    (r): r is typeof r & { targetSubjectVersion: number } =>
      r.targetPattern === PLAYBOOK_RUN_ACTION &&
      r.verdict === "auto" &&
      r.targetSubjectId === playbook.id &&
      r.targetSubjectVersion != null
  );
  const current = named.find(
    (r) => r.targetSubjectVersion === playbook.version
  );
  if (current) {
    return { state: "allowed", ruleId: current.id, version: playbook.version };
  }
  const earlier = named[0];
  return earlier
    ? { state: "outdated", allowedVersion: earlier.targetSubjectVersion }
    : { state: "none" };
}
