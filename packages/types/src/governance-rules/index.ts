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
  createT,
  type Catalog,
  type Catalogs,
} from "../i18n/translator.js";
import type { Locale } from "../i18n/locale.js";
import {
  buildObjectActionTitle,
  humanizeToken,
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
 * The two floor families a pod may switch (`FLOOR_CLASS_PATTERNS` in
 * `@synap/governance-policy`, pinned the same way): switched on, an agent's
 * kind definitions / its playbook, automation and space creates and automation
 * activations are no longer always asked; the other approval rules still apply.
 */
export const AGENT_DEFINES_KINDS_CLASS_PATTERN = "@agent-defines-kinds";
export const AGENT_BUILDS_STRUCTURE_CLASS_PATTERN = "@agent-builds-structure";

/** The class patterns whose pod row a Settings switch owns, each its own door. */
export const ROOT_SWITCH_PATTERNS = [
  REVERSIBLE_CLASS_PATTERN,
  OWN_ORGANISE_CLASS_PATTERN,
  AGENT_DEFINES_KINDS_CLASS_PATTERN,
  AGENT_BUILDS_STRUCTURE_CLASS_PATTERN,
] as const;
export type RootSwitchPattern = (typeof ROOT_SWITCH_PATTERNS)[number];

export function isRootSwitchPattern(
  pattern: string
): pattern is RootSwitchPattern {
  return (ROOT_SWITCH_PATTERNS as readonly string[]).includes(pattern);
}

/** Each switch's slot in {@link POD_SWITCH_WORDS}. */
const SWITCH_SLOT = {
  [REVERSIBLE_CLASS_PATTERN]: "reversible",
  [OWN_ORGANISE_CLASS_PATTERN]: "ownOrganise",
  [AGENT_DEFINES_KINDS_CLASS_PATTERN]: "definesKinds",
  [AGENT_BUILDS_STRUCTURE_CLASS_PATTERN]: "buildsStructure",
} as const satisfies Record<RootSwitchPattern, string>;

/**
 * THE words of the pod's switches and of the governance numbers they read
 * (`governanceRules.podFloorDefaults` settings, by key): one catalog for the
 * desktop, the phone and pod admin, so no surface words one switch twice.
 * Read through {@link podSwitchWords} and {@link podSettingWords}.
 */
const podSwitchWordsEn = {
  "reversible.label": "Act directly on changes that can be undone",
  "reversible.line":
    "Agents create, edit and link without asking, each change listed with Undo. Deleting, sharing and anything sent outside always ask.",
  "ownOrganise.label": "Tidy their own new work",
  "ownOrganise.line":
    "Agents file what they made {hours, plural, =24 {in the last day} one {in the last hour} other {in the last # hours}} into the project you named, and close their own tasks. Each is listed with Undo; anything you changed since still asks.",
  "ownOrganise.lineUnread":
    "Agents file what they made recently into the project you named, and close their own tasks. Each is listed with Undo; anything you changed since still asks.",
  "definesKinds.label": "Define new kinds without always asking",
  "definesKinds.line":
    "Off, an agent always asks before it defines a kind or a role. On, your approval rules decide.",
  "buildsStructure.label":
    "Create playbooks, automations and spaces without always asking",
  "buildsStructure.line":
    "Off, an agent always asks before it creates a playbook, an automation or a space, or turns an automation on. On, your approval rules decide.",
  "ownWorkHours.label": "How long their work counts as new",
  "ownWorkHours.line":
    "While “Tidy their own new work” is on, an agent tidies what it made within this time.",
  "ownWorkHours.unit": "Hours",
  "ownWorkHours.value": "{n, plural, one {# hour} other {# hours}}",
  "evidenceMin.label":
    "Records an agent’s project needs before your rules may approve it",
  "evidenceMin.line":
    "A project an agent proposes with fewer records than this always comes to you.",
  "evidenceMin.unit": "Records",
  "evidenceMin.value": "{n, plural, one {# record} other {# records}}",
} as const;

const podSwitchWordsFr: Catalog<typeof podSwitchWordsEn> = {
  "reversible.label": "Agir directement sur ce qui peut être annulé",
  "reversible.line":
    "Elles créent, modifient et relient sans demander, chaque modification avec Annuler. Supprimer, partager et tout ce qui part à l’extérieur demande toujours.",
  "ownOrganise.label": "Ranger leur propre travail récent",
  "ownOrganise.line":
    "Elles classent ce qu’elles ont créé {hours, plural, =24 {depuis un jour} one {depuis une heure} other {depuis # heures}} dans le projet que vous avez indiqué et ferment leurs propres tâches, chaque fois avec Annuler. Ce que vous avez modifié depuis demande toujours.",
  "ownOrganise.lineUnread":
    "Elles classent ce qu’elles ont créé récemment dans le projet que vous avez indiqué et ferment leurs propres tâches, chaque fois avec Annuler. Ce que vous avez modifié depuis demande toujours.",
  "definesKinds.label": "Définir de nouveaux types sans toujours demander",
  "definesKinds.line":
    "Désactivé, une IA demande toujours avant de définir un type ou un rôle. Activé, vos règles d’approbation décident.",
  "buildsStructure.label":
    "Créer playbooks, automatisations et espaces sans toujours demander",
  "buildsStructure.line":
    "Désactivé, une IA demande toujours avant de créer un playbook, une automatisation ou un espace, ou d’activer une automatisation. Activé, vos règles d’approbation décident.",
  "ownWorkHours.label": "Combien de temps leur travail reste récent",
  "ownWorkHours.line":
    "Tant que « Ranger leur propre travail récent » est activé, une IA range ce qu’elle a créé pendant ce délai.",
  "ownWorkHours.unit": "Heures",
  "ownWorkHours.value": "{n, plural, one {# heure} other {# heures}}",
  "evidenceMin.label":
    "Éléments qu’un projet d’IA doit réunir avant que vos règles puissent l’approuver",
  "evidenceMin.line":
    "Un projet proposé par une IA avec moins d’éléments vous est toujours soumis.",
  "evidenceMin.unit": "Éléments",
  "evidenceMin.value": "{n, plural, one {# élément} other {# éléments}}",
};

export const POD_SWITCH_WORDS: Catalogs<typeof podSwitchWordsEn> = {
  en: podSwitchWordsEn,
  fr: podSwitchWordsFr,
};

/**
 * A switch in words. The own-organise line names its window from the pod's
 * own-work hours; `null` (that read failed) says "recently", never a guess.
 */
export function podSwitchWords(
  pattern: RootSwitchPattern,
  opts: { locale?: Locale; ownWorkHours?: number | null } = {}
): { label: string; line: string } {
  const t = createT(opts.locale ?? "en", POD_SWITCH_WORDS);
  const slot = SWITCH_SLOT[pattern];
  if (slot === "ownOrganise") {
    return {
      label: t("ownOrganise.label"),
      line:
        opts.ownWorkHours == null
          ? t("ownOrganise.lineUnread")
          : t("ownOrganise.line", { hours: opts.ownWorkHours }),
    };
  }
  return { label: t(`${slot}.label`), line: t(`${slot}.line`) };
}

/** Each governance number's slot, by its `config_settings` key. */
const SETTING_SLOT: Readonly<Record<string, "ownWorkHours" | "evidenceMin">> =
  {
    "governance.own_work_fresh_hours": "ownWorkHours",
    "governance.project_evidence_min": "evidenceMin",
  };

/** A governance number in words; a key with no words reads as its humanized token. */
export function podSettingWords(
  key: string,
  locale: Locale = "en"
): {
  label: string;
  line: string | null;
  unit: string | null;
  value: (n: number) => string;
} {
  const slot = Object.prototype.hasOwnProperty.call(SETTING_SLOT, key)
    ? SETTING_SLOT[key]!
    : null;
  if (!slot) {
    return {
      label: humanizeToken(key.slice(key.lastIndexOf(".") + 1)),
      line: null,
      unit: null,
      value: (n) => String(n),
    };
  }
  const t = createT(locale, POD_SWITCH_WORDS);
  return {
    label: t(`${slot}.label`),
    line: t(`${slot}.line`),
    unit: t(`${slot}.unit`),
    value: (n) => t(`${slot}.value`, { n }),
  };
}

/**
 * The switches in English with the pod's default window, for the surfaces
 * that do not read the locale or the hours yet. New code reads
 * {@link podSwitchWords}.
 */
export const POD_DEFAULT_WORDS: Readonly<
  Record<RootSwitchPattern, { label: string; line: string }>
> = Object.fromEntries(
  ROOT_SWITCH_PATTERNS.map((p) => [p, podSwitchWords(p, { ownWorkHours: 24 })])
) as Record<RootSwitchPattern, { label: string; line: string }>;

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
  if (pattern === AGENT_DEFINES_KINDS_CLASS_PATTERN) {
    return `An agent defining a kind or role (${pattern})`;
  }
  if (pattern === AGENT_BUILDS_STRUCTURE_CLASS_PATTERN) {
    return `An agent creating a playbook, automation or space (${pattern})`;
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
  // `entity.<action>` names no kind: it covers every kind, so its object is
  // "anything" ("Create anything"), never the bare verb (finding b0bb38d4:
  // an approval on `entity.create` read "Create", saying nothing).
  const everyKind = everyKindAction(pattern);
  if (everyKind) return `${everyKind} ${EVERY_KIND_OBJECT} (${pattern})`;
  const title = buildObjectActionTitle({
    action: pattern.slice(dot + 1),
    objectKind: pattern.slice(0, dot),
    mood: "imperative",
  });
  return title ? `${title} (${pattern})` : pattern;
}

/** The object of a write on every kind (`entity.<action>`), in words. */
const EVERY_KIND_OBJECT = "anything";

/**
 * The verb of `entity.<action>` (a write on every kind: the generic base
 * kind names none), imperative: "Create" for `entity.create`. null for any
 * other pattern.
 */
function everyKindAction(pattern: string): string | null {
  const dot = pattern.lastIndexOf(".");
  if (dot <= 0 || pattern.slice(0, dot).toLowerCase() !== "entity") return null;
  const action = pattern.slice(dot + 1);
  if (!action || action === "*") return null;
  return resolveActionLabel(action, "imperative") || null;
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
  if (!rule.targetProfile && isRootSwitchPattern(rule.targetPattern)) {
    return podSwitchWords(rule.targetPattern).label;
  }
  // A rule narrowed to one kind names that kind, so an every-kind write reads
  // as its verb and the kind ("Update · Notes"), never "Update anything".
  if (rule.targetProfile) {
    const head =
      everyKindAction(rule.targetPattern) ??
      writePatternTitle(rule.targetPattern);
    return `${head} · ${resolveObjectNounPlural(rule.targetProfile)}`;
  }
  return writePatternTitle(rule.targetPattern);
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
 * undone", "Tidy their own new work", the two floor switches)?
 * `setReversibleDefault`, `setOwnOrganiseDefault` and `setPodFloorDefault`
 * own every row with exactly this shape (principal
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
    isRootSwitchPattern(rule.targetPattern)
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
