/**
 * The vocabulary's ENGLISH catalog: the source and the type of every other
 * locale's (`catalog.fr.ts`), per `@synap-core/types/i18n`.
 *
 * Two halves:
 * - the WORDS, derived from the curated tables this folder already keeps
 *   (`OBJECT_KINDS` + `OBJECT_NOUNS`, `ACTION_VERBS`, `STATUS_LABELS`,
 *   `NEEDS_YOU_ITEM_NOUNS`), so English has ONE home and each row's rationale
 *   stays beside it. Keys are today's tokens: `kind.<slug>.one|other`,
 *   `action.<token>.imperative|past|progressive|present`, `status.<token>`,
 *   `needsYou.count.<kind>`, `runner.<state>`, `waitKind.<kind>`,
 *   `stepRunner.<kind>`, `need.<slug>`, `intent.<slug>`. A row added to a table is a key of this catalog,
 *   and `Catalog<VocabularyEn>` then refuses every translation without it;
 * - the SENTENCES the door used to splice by hand (titles, button labels,
 *   "Private …", "Handed to …"), written here as messages. A sentence that
 *   names a kind reads the noun bundle (`obj`, `Obj`, `objs`, `objG`, `objV`)
 *   so a translation can agree with it.
 *
 * English output is byte-identical to the tables' (`vocabulary.test.ts`).
 * Pure: the tables are passed in by `index.ts`, so this module imports no
 * value from the folder it serves (no import cycle).
 */
import type { ActionVerb } from "./index.js";
import type {
  ActionVerbRows,
  NeedsYouItemNounRows,
  ObjectNounRows,
  RunnerStateLabelRows,
  StatusLabelRows,
  WaitKindLabelRows,
  StepRunnerKindLabelRows,
  NeedLabelRows,
  IntentLabelRows,
} from "./index.js";
import type { ObjectKindRows } from "./object-kinds.js";

/** Every slug the noun catalog holds: the registry's kinds and the backend-only nouns. */
export type NounSlug = (keyof ObjectKindRows | keyof ObjectNounRows) & string;

type NounKey = `kind.${NounSlug}.${"one" | "other"}`;

type ActionKey = {
  [K in keyof ActionVerbRows & string]:
    | `action.${K}.imperative`
    | `action.${K}.past`
    | (ActionVerbRows[K] extends { progressive: string }
        ? `action.${K}.progressive`
        : never)
    | (ActionVerbRows[K] extends { present: string }
        ? `action.${K}.present`
        : never);
}[keyof ActionVerbRows & string];

type StatusKey = `status.${keyof StatusLabelRows & string}`;

type NeedsYouCountKey = `needsYou.count.${keyof NeedsYouItemNounRows & string}`;

type RunnerStateKey = `runner.${keyof RunnerStateLabelRows & string}`;

type WaitKindKey = `waitKind.${keyof WaitKindLabelRows & string}`;
type StepRunnerKey = `stepRunner.${keyof StepRunnerKindLabelRows & string}`;
type NeedKey = `need.${keyof NeedLabelRows & string}`;
type IntentKey = `intent.${keyof IntentLabelRows & string}`;

/**
 * The door's sentences. Each English text reproduces what the door returned
 * before it had a catalog, exactly; the comment on a group names its door.
 */
export const vocabularySentencesEn = {
  // `buildObjectActionTitle`. A title is "<verb> <Noun>", a preposition
  // between them when the verb names the part it acts within
  // (`ACTION_OBJECT_PREPOSITIONS`), and the object's name quoted after it.
  // Keyed by mood because only English can say both moods in one order.
  // With no verb, the title names the request itself (founder G1, 30 Oct):
  // "Request" is also a verb, so the noun is set apart by a colon.
  "vocabulary.title.fallbackVerb": "Request",
  "vocabulary.title.noVerb": "Request: {Obj}",
  "vocabulary.title.noVerb.named": 'Request: {Obj} "{name}"',
  "vocabulary.title.lead": "{verb}: {name}",
  // A capability asked for one of the person's computers
  // (`buildInstallationTitle`): what, and on which computer.
  "vocabulary.title.onComputer": '{verb} "{name}" on {computer}',
  "vocabulary.title.fromComputer": '{verb} "{name}" from {computer}',
  "vocabulary.title.addAndInstallOn":
    'Add "{name}" from the marketplace and install it on {computer}',
  "vocabulary.title.verbOnly.named": '{verb} "{name}"',
  "vocabulary.title.imperative": "{verb} {Obj}",
  "vocabulary.title.imperative.named": '{verb} {Obj} "{name}"',
  "vocabulary.title.imperative.in": "{verb} in {Obj}",
  "vocabulary.title.imperative.in.named": '{verb} in {Obj} "{name}"',
  "vocabulary.title.imperative.of": "{verb} of {Obj}",
  "vocabulary.title.imperative.of.named": '{verb} of {Obj} "{name}"',
  "vocabulary.title.imperative.for": "{verb} for {Obj}",
  "vocabulary.title.imperative.for.named": '{verb} for {Obj} "{name}"',
  "vocabulary.title.past": "{verb} {Obj}",
  "vocabulary.title.past.named": '{verb} {Obj} "{name}"',
  "vocabulary.title.past.in": "{verb} in {Obj}",
  "vocabulary.title.past.in.named": '{verb} in {Obj} "{name}"',
  "vocabulary.title.past.of": "{verb} of {Obj}",
  "vocabulary.title.past.of.named": '{verb} of {Obj} "{name}"',
  "vocabulary.title.past.for": "{verb} for {Obj}",
  "vocabulary.title.past.for.named": '{verb} for {Obj} "{name}"',
  // `buildActionLabel`: a button's words, the noun mid-sentence.
  "vocabulary.button.imperative": "{verb} {obj}",
  "vocabulary.button.imperative.in": "{verb} in {obj}",
  "vocabulary.button.imperative.of": "{verb} of {obj}",
  "vocabulary.button.imperative.for": "{verb} for {obj}",
  "vocabulary.button.past": "{verb} {obj}",
  "vocabulary.button.past.in": "{verb} in {obj}",
  "vocabulary.button.past.of": "{verb} of {obj}",
  "vocabulary.button.past.for": "{verb} for {obj}",
  // `resolveTrackMoveLabel`: a goal's plain move names where it goes.
  "vocabulary.track.moveTo": "Move to {status}",
  // `resolvePrivateObjectLabel`: an object the viewer may not read.
  "vocabulary.private": "Private {obj}",
  "vocabulary.private.unnamed": "Private item",
  // `resolveMembersDecideLabel`: who may decide a proposal the viewer sees.
  "vocabulary.membersDecide": "{Obj} members decide",
  "vocabulary.membersDecide.unnamed": "Item members decide",
  // `resolveHandedToLabel`: a slot handed to an agent (past).
  "vocabulary.handedTo": "Handed to {name}",
  // `resolveDoNotContactRefusal`: why the send door sent nothing to a person
  // marked do not contact (founder, 2026-11-09). The reason, when the person
  // gave one, is said as written.
  "vocabulary.refusal.doNotContact":
    "Nothing was sent: {name} is marked do not contact.",
  "vocabulary.refusal.doNotContact.reason":
    "Nothing was sent: {name} is marked do not contact ({reason}).",
  "vocabulary.refusal.doNotContact.unnamed": "this person",
  // `resolveRunnerStateLabelFor`: a runner's wait read by someone other than
  // the person it waits on (a room member): never "your".
  "vocabulary.runner.needs_permission.named": "Waiting for {name}'s permission",
  "vocabulary.runner.needs_permission.unnamed": "Waiting for permission",
  "vocabulary.runner.needs_answer.named": "Waiting for {name}'s answer",
  "vocabulary.runner.needs_answer.unnamed": "Waiting for an answer",
  // `resolveNextRungOfferLabel`: a trust offer that reaches every space.
  "vocabulary.offer.everySpace": "{offer} in every space",
  // `resolveTemplateNoun`: a template's noun, derived from its scope.
  "vocabulary.templateNoun.goal.one": "Goal process",
  "vocabulary.templateNoun.goal.other": "Goal processes",
  "vocabulary.templateNoun.work.one": "Process",
  "vocabulary.templateNoun.work.other": "Processes",
  "vocabulary.templateNoun.space.one": "Space template",
  "vocabulary.templateNoun.space.other": "Space templates",
  // `resolvePackageNoun`: what installs, named by what it holds (founder,
  // 2026-11-05): ONE object (a capability, a playbook, a cell, a kind, an
  // automation) is a template; several (a space with its kinds and views, a
  // set of workflows) are a pack.
  "vocabulary.packageNoun.template.one": "Template",
  "vocabulary.packageNoun.template.other": "Templates",
  "vocabulary.packageNoun.pack.one": "Pack",
  "vocabulary.packageNoun.pack.other": "Packs",
  // `resolveGrantPermissionSentence`: a permission the person reads as its
  // act, not as a verb and a subject.
  "vocabulary.grant.packageInstall": "Add packs and templates to your pod",
  // `resolveNeedsYouItemCount` for a kind no table names: its words are a
  // humanized token, counted with English plural rules.
  "vocabulary.needsYou.count.uncurated":
    "{n, plural, one {# {noun}} other {# {nouns}}}",
  // `resolveProcessHealthLabel` / `resolveProcessHealthReason`: a process
  // health's words, keyed by its reason code (`PROCESS_HEALTH_REASONS`,
  // `@synap-core/types/processes`). `waiting_on_you`'s label is the status
  // label door's (`status.waiting_on_you`), so it has no row here.
  "vocabulary.processHealth.config_invalid.label": "Configuration error",
  "vocabulary.processHealth.config_invalid.reason":
    "The saved definition is invalid or cannot be activated.",
  "vocabulary.processHealth.running.label": "Running",
  "vocabulary.processHealth.running.reason":
    "At least one execution is currently in progress.",
  "vocabulary.processHealth.running_after_failure.label":
    "Running · previous run failed",
  "vocabulary.processHealth.running_after_failure.reason":
    "An execution is in progress after the previous known outcome failed.",
  "vocabulary.processHealth.waiting_on_you.reason":
    "The latest run is paused until you answer what its session asked of you.",
  "vocabulary.processHealth.blocked_by_policy.label": "Blocked by policy",
  "vocabulary.processHealth.blocked_by_policy.reason":
    "Governance refused the latest run’s effect — it needs your review.",
  "vocabulary.processHealth.latest_failed.label": "Latest run failed",
  "vocabulary.processHealth.latest_failed.reason":
    "No newer successful outcome resolves the latest failure.",
  "vocabulary.processHealth.draft.label": "Draft",
  "vocabulary.processHealth.draft.reason":
    "The definition still needs to be completed or activated.",
  "vocabulary.processHealth.paused.label": "Paused",
  "vocabulary.processHealth.paused.reason":
    "The definition is paused and will not start new runs.",
  "vocabulary.processHealth.archived.label": "Archived",
  "vocabulary.processHealth.archived.reason":
    "The definition is archived and will not start new runs.",
  "vocabulary.processHealth.healthy.label": "Healthy",
  "vocabulary.processHealth.healthy.reason":
    "The latest known outcome completed without failure.",
  "vocabulary.processHealth.latest_unresolved.label":
    "Latest status unresolved",
  "vocabulary.processHealth.latest_unresolved.reason":
    "The latest execution is {status}; Synap cannot classify it as healthy or failed yet.",
  "vocabulary.processHealth.never_run.label": "Never run",
  "vocabulary.processHealth.never_run.reason":
    "This saved definition has no executions yet.",
  "vocabulary.processHealth.not_enough_activity.label": "Status unknown",
  "vocabulary.processHealth.not_enough_activity.reason":
    "There is not enough loaded activity to determine current health.",
  // `resolveJobsStartedHereLabel`: a job's folded child jobs on its Activity
  // line (plan 5207fbb6: a child job is drawn as a fork, never named a
  // "branch"), counted with the Job word.
  "vocabulary.job.startedHere":
    "{n, plural, one {# job started from here} other {# jobs started from here}}",
} as const;

export type VocabularySentencesEn = typeof vocabularySentencesEn;

/** The English vocabulary catalog's type: every derived word, then the sentences. */
export type VocabularyEn = Readonly<
  Record<
    | NounKey
    | ActionKey
    | StatusKey
    | NeedsYouCountKey
    | RunnerStateKey
    | WaitKindKey
    | StepRunnerKey
    | NeedKey
    | IntentKey,
    string
  >
> &
  VocabularySentencesEn;

/** The tables the English words are derived from (passed in by `index.ts`). */
export interface VocabularyTables {
  readonly kinds: Readonly<
    Record<string, { readonly label: string; readonly labelPlural: string }>
  >;
  readonly nouns: Readonly<Record<string, string>>;
  readonly nounPlurals: Readonly<Record<string, string>>;
  readonly verbs: Readonly<Record<string, ActionVerb>>;
  readonly statuses: Readonly<Record<string, string>>;
  readonly needsYouNouns: Readonly<Record<string, readonly [string, string]>>;
  readonly runnerStates: Readonly<Record<string, string>>;
  readonly waitKinds: Readonly<Record<string, string>>;
  readonly stepRunners: Readonly<Record<string, string>>;
  readonly needs: Readonly<Record<string, string>>;
  readonly intents: Readonly<Record<string, string>>;
}

/**
 * The English catalog, derived from the tables. A needs-you count becomes a
 * plural message ("{n, plural, one {# decision} other {# decisions}}"), the
 * rest are words.
 */
export function buildVocabularyEn(tables: VocabularyTables): VocabularyEn {
  const words: Record<string, string> = {};
  for (const [slug, def] of Object.entries(tables.kinds)) {
    words[`kind.${slug}.one`] = def.label;
    words[`kind.${slug}.other`] = def.labelPlural;
  }
  for (const [slug, noun] of Object.entries(tables.nouns)) {
    words[`kind.${slug}.one`] = noun;
    words[`kind.${slug}.other`] = tables.nounPlurals[slug] ?? noun;
  }
  for (const [token, verb] of Object.entries(tables.verbs)) {
    words[`action.${token}.imperative`] = verb.imperative;
    words[`action.${token}.past`] = verb.past;
    if (verb.progressive !== undefined) {
      words[`action.${token}.progressive`] = verb.progressive;
    }
    if (verb.present !== undefined) {
      words[`action.${token}.present`] = verb.present;
    }
  }
  for (const [token, label] of Object.entries(tables.statuses)) {
    words[`status.${token}`] = label;
  }
  for (const [kind, [one, other]] of Object.entries(tables.needsYouNouns)) {
    words[`needsYou.count.${kind}`] =
      `{n, plural, one {# ${one}} other {# ${other}}}`;
  }
  for (const [state, label] of Object.entries(tables.runnerStates)) {
    words[`runner.${state}`] = label;
  }
  for (const [kind, label] of Object.entries(tables.waitKinds)) {
    words[`waitKind.${kind}`] = label;
  }
  for (const [kind, label] of Object.entries(tables.stepRunners)) {
    words[`stepRunner.${kind}`] = label;
  }
  for (const [slug, label] of Object.entries(tables.needs)) {
    words[`need.${slug}`] = label;
  }
  for (const [slug, label] of Object.entries(tables.intents)) {
    words[`intent.${slug}`] = label;
  }
  return { ...words, ...vocabularySentencesEn } as VocabularyEn;
}
