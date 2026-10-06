/**
 * MOVED HERE from `relay-app/src/components/rule-compose/rule-text-match.ts`
 * (2026-10-06) so relay, the browser composer and the pod's parse door share
 * ONE matcher. Generic over the option shape: it reads only `label` (and an
 * event's `pattern`), so it takes the pod's own `EventOption` / `ActionOption`
 * without this package owning a mirror of them — and returns the caller's
 * objects back, typed as the caller's.
 *
 * `matchSummary` (the one-line copy under the composer) did NOT move: it says
 * "tap", which is a phone's verb. Each surface words its own hint off
 * `matchGap`, which did move.
 *
 * Typed text → the pieces of a rule. Pure, so every word of it is assertable.
 *
 * ── WHAT THIS IS, AND WHAT IT IS NOT ───────────────────────────────────────
 * It is a MATCHER against the pod's own vocabulary, not a language model and
 * not a parser of English. It scores what the user typed against the labels
 * `automations.availableTriggerEvents` / `.availableActions` actually returned
 * and fills the slots those labels cover. Nothing here invents an event, an
 * action, or a phrasing: a match is always one of the door's own options, so a
 * matched chip is a chip the user could also have reached by tapping.
 *
 * It is the FIRST pass, not the only one. The pod's `automations.parseRuleText`
 * door runs THIS matcher first and asks the intelligence service only for the
 * slots it leaves open — so whatever the matcher resolves, it resolves
 * identically on the phone, the desktop and the server. `matchGap` names the
 * half that could not be filled instead of leaving a silent empty slot.
 *
 * A phrasing whose words are not in the pod's labels will not match, and that
 * is the correct behaviour: the alternative is guessing at a rule the user
 * never wrote, which is worse than an unfilled slot they can tap.
 *
 * ── Why coverage-of-the-LABEL, not overlap ─────────────────────────────────
 * The score is "how much of the option's label did the user say", not "how much
 * of what the user said is in the label". Rule text is mostly filler — "when an
 * invoice is created just let me know about it" — so scoring by the text's own
 * length punishes a long, precise sentence for being long. Coverage of the
 * label asks the question that matters: did they name this thing?
 */

import {
  matchObjectSegment,
  parseConditionClauses,
  type ParsedClause,
} from "./rule-text-clauses.js";

/** The least an event option must carry to be matched: its label and pattern. */
export interface RuleTextEventOption {
  pattern: string;
  label: string;
}

/** The least an action option must carry to be matched: its label. */
export interface RuleTextActionOption {
  label: string;
}

/**
 * Words that carry no rule meaning.
 *
 * Deliberately only closed-class filler and the grammar's own connectives.
 * Domain words are NEVER stopped — "entity", "note", "invoice", "message",
 * "notification" all survive, because they are the whole signal. (An earlier
 * shape of this list dropped "new", which is the only word distinguishing
 * "a new note" from "a note"; a stoplist that eats a distinction is a matcher
 * that quietly answers a different question.)
 */
const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "as",
  "soon",
  "when",
  "whenever",
  "if",
  "after",
  "once",
  "then",
  "do",
  "does",
  "did",
  "to",
  "of",
  "in",
  "on",
  "at",
  "for",
  "with",
  "and",
  "or",
  "but",
  "that",
  "this",
  "it",
  "its",
  "i",
  "me",
  "my",
  "please",
  "always",
  "just",
  "about",
  "gets",
  "get",
  "got",
  "should",
  "would",
  "will",
  "can",
  "have",
  "has",
  "had",
  "from",
  "by",
  "up",
]);

/** Lowercased, punctuation-free, filler-free words. */
export function ruleTextTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0 && !STOPWORDS.has(w));
}

/**
 * How much of `label` the text says, 0..1. `0` when the label has no content
 * words of its own — a label made entirely of filler cannot be matched, and
 * pretending otherwise would make it match EVERYTHING.
 */
export function labelCoverage(
  label: string,
  textTokens: readonly string[]
): number {
  const wanted = ruleTextTokens(label);
  if (wanted.length === 0) return 0;
  const said = new Set(textTokens);
  const hit = wanted.filter((w) => said.has(w)).length;
  return hit / wanted.length;
}

/**
 * The floor a match must clear.
 *
 * 0.6 means "most of the option's words were said". Below it, a one-word
 * accident ("create" alone matching "Create an entity") would fill a slot the
 * user did not ask for — and a wrongly-filled slot is more expensive than an
 * empty one, because an empty slot advertises itself and a wrong one does not.
 */
export const MATCH_THRESHOLD = 0.6;

/**
 * Where the WHEN half of a typed rule ends and the THEN half begins.
 *
 * Splitting matters because "notification" appears in both an event label ("A
 * notification was received") and an action label ("Send a notification"), so
 * scoring both against the whole sentence lets one half steal the other's
 * words. The split points are the connectives people actually type; when none
 * is present both halves are scored against the whole text, which is the
 * honest degradation — no split is not a reason to refuse to match.
 */
const CONNECTIVE = /(?:,|\bthen\b|\bplease\b|->|→)/i;

export interface RuleTextHalves {
  when: string;
  then: string;
  /** Whether a connective was actually found (vs. both halves = whole text). */
  split: boolean;
}

export function splitRuleText(text: string): RuleTextHalves {
  const at = text.search(CONNECTIVE);
  if (at < 0) return { when: text, then: text, split: false };
  const match = text.slice(at).match(CONNECTIVE);
  const after = at + (match?.[0].length ?? 1);
  return { when: text.slice(0, at), then: text.slice(after), split: true };
}

export interface RuleTextMatch<
  E extends RuleTextEventOption = RuleTextEventOption,
  A extends RuleTextActionOption = RuleTextActionOption,
> {
  /** The event option the WHEN half names, or `null`. */
  trigger: E | null;
  /**
   * The OBJECT the sentence is about, when label coverage found no event.
   *
   * ⚠️ THE GAP THIS CLOSES. Coverage scores whole event labels, so "a task when
   * deadline is today" — the founder's own example — shared two words with "A
   * task was updated", scored under threshold, and produced NO chips at all.
   * But the sentence plainly names an object, and the pod's patterns are
   * `<object>.<verb>`. So when no event wins outright we still know WHICH
   * OBJECT, which is exactly rung 1 of the guided path — the text path and the
   * form path converge instead of being two grammars.
   *
   * `null` when the text names no object the pod emits events for. Never a
   * guess: an invented object authors a rule against events that do not exist.
   */
  objectSegment: string | null;
  /**
   * The narrowings the text asked for, UNRESOLVED — property words as typed.
   *
   * Resolving `deadline` to a slug needs the profile in force, which this
   * scorer does not have. `applyRuleTextMatch` resolves them and REPORTS the
   * ones it cannot: dropping a narrowing while keeping the trigger produces a
   * rule that fires on every task, which is the silent-widening defect this
   * codebase keeps paying for.
   */
  clauses: ParsedClause[];
  /** Coverage the winning event scored — `0` when nothing matched. */
  triggerScore: number;
  /** The action options the THEN half names, in the order they were said. */
  actions: A[];
  /**
   * Whether the text was scored at all — true for any non-empty input.
   *
   * NOT a length floor, despite how this once read: a single character is
   * scored, so `matchSummary` can answer "Nothing in that matches a piece your
   * pod offers yet" on the first keystroke. That is noisy rather than wrong,
   * and adding a floor here would change what every caller renders, so it is
   * named as a known rough edge instead of silently claimed as solved.
   */
  attempted: boolean;
  /**
   * The pod returned NOTHING to score against.
   *
   * Distinct from "matched nothing", and the distinction is the whole point: an
   * empty vocabulary means there was no list, so telling the user to "pick from
   * the list" instructs them to do something impossible. A scorer that cannot
   * tell those apart reads its own silence as the user's fault.
   */
  vocabularyEmpty: boolean;
}

const EMPTY: RuleTextMatch<never, never> = {
  trigger: null,
  objectSegment: null,
  clauses: [],
  triggerScore: 0,
  actions: [],
  attempted: false,
  vocabularyEmpty: false,
};

/**
 * Score the typed text against the vocabulary the pod returned.
 *
 * Ties break toward the option the door ranked first: `availableTriggerEvents`
 * already sorts declared → observed (busiest first) → catalog, so "the first
 * one still standing" is the pod's own relevance order rather than a second
 * one invented here.
 */
export function matchRuleText<
  E extends RuleTextEventOption,
  A extends RuleTextActionOption,
>(
  text: string,
  vocabulary: {
    events: readonly E[];
    actions: readonly A[];
  }
): RuleTextMatch<E, A> {
  const vocabularyEmpty =
    vocabulary.events.length === 0 && vocabulary.actions.length === 0;

  const trimmed = text.trim();
  if (trimmed.length === 0) return { ...EMPTY, vocabularyEmpty };

  /**
   * ⚠️ THE SPLIT MUST NEVER LOSE A MATCH THE UNSPLIT TEXT HAD.
   *
   * `splitRuleText` cuts on the first connective, which is right for the order
   * people usually write ("when X, notify me"). But English is happily
   * reversed — "notify me, when an invoice is created" — and there the cut puts
   * the ACTION in the WHEN half and the TRIGGER in the THEN half. Both sides
   * then score zero, so BOTH chips vanish the instant the comma is typed,
   * after matching fine while the same words were unpunctuated.
   *
   * A user cannot be expected to know which half the parser calls which. So
   * try the split, and if it finds strictly less than the unsplit text, keep
   * the unsplit reading. A punctuation mark may never empty the card.
   */
  const halves = splitRuleText(trimmed);
  const allTokens = ruleTextTokens(trimmed);
  const covers = (labels: readonly { label: string }[], tokens: string[]) =>
    labels.some((o) => labelCoverage(o.label, tokens) >= MATCH_THRESHOLD);
  const splitWhen = ruleTextTokens(halves.when);
  const splitThen = ruleTextTokens(halves.then);
  const splitFinds =
    covers(vocabulary.events, splitWhen) ||
    covers(vocabulary.actions, splitThen);
  const useSplit = !halves.split || splitFinds;
  const whenTokens = useSplit ? splitWhen : allTokens;
  const thenTokens = useSplit ? splitThen : allTokens;

  let trigger: E | null = null;
  let triggerScore = 0;
  for (const event of vocabulary.events) {
    const score = labelCoverage(event.label, whenTokens);
    if (score >= MATCH_THRESHOLD && score > triggerScore) {
      trigger = event;
      triggerScore = score;
    }
  }

  /**
   * Every action whose label the THEN half covers, in the order the user said
   * them — a rule is an ordered list of THENs, so "notify me and create a
   * task" must not come back as create-then-notify. Position is the index of
   * the label's FIRST content word in the half, which is the only ordering
   * signal a bag-of-words match has.
   */
  const scored = vocabulary.actions.flatMap((action) => {
    const score = labelCoverage(action.label, thenTokens);
    if (score < MATCH_THRESHOLD) return [];
    const first = ruleTextTokens(action.label).find((w) =>
      thenTokens.includes(w)
    );
    const at = first ? thenTokens.indexOf(first) : Number.MAX_SAFE_INTEGER;
    return [{ action, score, at }];
  });
  scored.sort((a, b) => a.at - b.at || b.score - a.score);

  // The object is read from the WHEN half only. "notify me about the invoice"
  // names an object in its THEN, and triggering on it would be a rule the user
  // never asked for.
  const objectSegment = trigger
    ? null
    : matchObjectSegment(
        halves.when,
        vocabulary.events.map((e) => e.pattern)
      );

  return {
    trigger,
    objectSegment,
    // Clauses come from the WHOLE sentence: "when …" can precede or follow the
    // action half, and the narrowing marker is what delimits them, not position.
    clauses: parseConditionClauses(trimmed),
    triggerScore,
    actions: scored.map((s) => s.action),
    attempted: true,
    vocabularyEmpty,
  };
}

/** Which half of the sentence the text failed to fill. */
export type RuleTextGap = "trigger" | "actions" | "both" | null;

export function matchGap(
  match: Pick<
    RuleTextMatch<RuleTextEventOption, RuleTextActionOption>,
    "attempted" | "trigger" | "actions"
  >
): RuleTextGap {
  if (!match.attempted) return null;
  const noTrigger = match.trigger === null;
  const noActions = match.actions.length === 0;
  if (noTrigger && noActions) return "both";
  if (noTrigger) return "trigger";
  if (noActions) return "actions";
  return null;
}
