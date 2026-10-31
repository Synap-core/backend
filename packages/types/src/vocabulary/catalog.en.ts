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
 *   `needsYou.count.<kind>`. A row added to a table is a key of this catalog,
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
  StatusLabelRows,
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
  // `resolveNextRungOfferLabel`: a trust offer that reaches every space.
  "vocabulary.offer.everySpace": "{offer} in every space",
  // `resolveTemplateNoun`: a template's noun, derived from its scope.
  "vocabulary.templateNoun.goal.one": "Goal template",
  "vocabulary.templateNoun.goal.other": "Goal templates",
  "vocabulary.templateNoun.work.one": "Work template",
  "vocabulary.templateNoun.work.other": "Work templates",
  // `resolveNeedsYouItemCount` for a kind no table names: its words are a
  // humanized token, counted with English plural rules.
  "vocabulary.needsYou.count.uncurated":
    "{n, plural, one {# {noun}} other {# {nouns}}}",
} as const;

export type VocabularySentencesEn = typeof vocabularySentencesEn;

/** The English vocabulary catalog's type: every derived word, then the sentences. */
export type VocabularyEn = Readonly<
  Record<NounKey | ActionKey | StatusKey | NeedsYouCountKey, string>
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
  return { ...words, ...vocabularySentencesEn } as VocabularyEn;
}
