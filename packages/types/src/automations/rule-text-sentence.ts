/**
 * A text-matcher reading → a rule SENTENCE. Pure, platform-agnostic.
 *
 * ONE builder for two callers that used to be named twins: the browser
 * composer's `readRuleText` (runs on every keystroke) and the pod's parse door
 * `parseRuleText` (`api/src/services/rules/parse-text.ts`, which may add an AI
 * pass first). Both turn the same reading into the same sentence:
 *
 *   - the WHEN: the chosen event option → its trigger; else a chosen schedule;
 *     else an object with no verb → `<object>.*` (a real, unsaveable trigger
 *     that lands the composer on the right object and leaves the verb open);
 *   - a `kind` binds a GENERIC entity trigger only — never overrides the kind
 *     an event option already carries;
 *   - a clause that restates the WHEN is not a narrowing; any other clause
 *     becomes a WHERE row ONLY on a key the event can be narrowed on
 *     (`filterKeys`) — never a guessed key, because a filter on a field the
 *     event does not carry narrows the rule to never. A clause with no such
 *     key is RETURNED as unresolved, never dropped;
 *   - the THENs through `actionOptionToSentenceAction` (half-declared options
 *     are refused, not half-built).
 */

import { ruleTextTokens } from "./rule-text-match.js";
import type { ParsedClause } from "./rule-text-clauses.js";
import {
  actionOptionToSentenceAction,
  triggerToSentence,
  type ConditionRow,
  type RuleSentenceValue,
  type SentenceAction,
  type SentenceActionOption,
  type SentenceTrigger,
} from "./sentence.js";

/** The least of an event option a WHEN is built from. */
export interface TextMatchEventOption {
  pattern: string;
  label: string;
  profileSlug?: string | null;
  filterKeys?: readonly string[] | null;
}

export interface TextMatchReading {
  /** The event option the words (or the assistant) chose. */
  event: TextMatchEventOption | null;
  /** A schedule the assistant chose, used only when no event was. */
  schedule?: SentenceTrigger | null;
  /** The object the words named when no event won (`task`). */
  objectSegment: string | null;
  /** A kind to bind a generic entity trigger to. */
  kind?: string | null;
  /** The chosen THEN options, in order. */
  actions: readonly SentenceActionOption[];
  /** Every narrowing the words (and the assistant) asked for. */
  clauses: readonly ParsedClause[];
}

export interface SentenceFromTextMatch {
  sentence: RuleSentenceValue;
  /** Clauses that name no field this trigger can be narrowed on. */
  unresolvedClauses: ParsedClause[];
}

const norm = (s: string): string => s.toLowerCase().replace(/[\s_-]+/g, "");

/**
 * "when an invoice is created, …" — the clause parser reads `when` as a
 * narrowing marker, so the WHEN itself comes back as a clause ("invoice" is
 * "created"). The clause splitter only breaks on " , " / " and ", so the value
 * of the restated WHEN usually runs on into the THEN. Hence: every FIELD word
 * is in the trigger's label, and the value STARTS with a label word (the
 * verb). A real narrowing names a field the label does not.
 */
export function clauseRestatesTrigger(
  clause: ParsedClause,
  triggerLabel: string | null | undefined
): boolean {
  if (!triggerLabel) return false;
  const label = new Set(ruleTextTokens(triggerLabel));
  const field = ruleTextTokens(clause.field);
  const firstValueWord = ruleTextTokens(clause.value)[0];
  return (
    field.length > 0 &&
    field.every((w) => label.has(w)) &&
    firstValueWord !== undefined &&
    label.has(firstValueWord)
  );
}

export function sentenceFromTextMatch(
  reading: TextMatchReading
): SentenceFromTextMatch {
  const { event } = reading;

  let trigger: SentenceTrigger | null = null;
  if (event) {
    trigger = triggerToSentence("event", {
      eventPattern: event.pattern,
      ...(event.profileSlug ? { profileSlug: event.profileSlug } : {}),
    });
  } else if (reading.schedule) {
    trigger = reading.schedule;
  } else if (reading.objectSegment) {
    trigger = triggerToSentence("event", {
      eventPattern: `${reading.objectSegment}.*`,
    });
  }
  if (
    reading.kind &&
    trigger?.triggerType === "event" &&
    trigger.subjectCategory === "entity" &&
    !trigger.profileSlug
  ) {
    trigger = { ...trigger, profileSlug: reading.kind };
  }

  const conditions: ConditionRow[] = [];
  const unresolvedClauses: ParsedClause[] = [];
  for (const clause of reading.clauses) {
    if (clauseRestatesTrigger(clause, event?.label)) continue;
    const key = event?.filterKeys?.find((k) => norm(k) === norm(clause.field));
    if (!key) {
      unresolvedClauses.push(clause);
    } else if (!conditions.some((c) => c.key === key)) {
      conditions.push({
        id: key,
        key,
        operator: clause.operator,
        value: clause.value,
      });
    }
  }

  const actions = reading.actions
    .map((a) => actionOptionToSentenceAction(a))
    .filter((a): a is SentenceAction => a !== null);

  return { sentence: { trigger, conditions, actions }, unresolvedClauses };
}
