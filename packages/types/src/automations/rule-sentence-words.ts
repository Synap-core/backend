/**
 * Rule sentence → human words. Pure, platform-agnostic.
 *
 * MOVED HERE from `relay-app/src/components/rule-compose/compose-model.ts`
 * (2026-10-06): the clause builder, the operator/window/property labels and
 * the one "As soon as X, Y." phrasing. Relay's sentence card, the browser
 * composer (R3) and the pod's text→rule parse door all render a sentence the
 * same way only if there is one renderer — the rule this module's own
 * docstrings record ("two projections, one of them silently short") is a fork
 * between surfaces just as much as between a card and a record.
 *
 * Everything below reads the SENTENCE (`RuleSentenceValue`-shaped) and never a
 * surface's draft wrapper, so any caller can pass `draft.sentence` or a parsed
 * sentence straight from the pod.
 *
 * `CHANGED_KEY_PREFIX` / `isChangedFlagKey` moved with it: the clause builder
 * needs them, this package may not import synap-app, and
 * `@synap-core/automation-intent`'s `condition-operators.ts` now re-exports
 * them from here — one spelling of the synthetic `changed.<field>` key.
 */

import { humanizeToken } from "../vocabulary/index.js";
import { TRIGGER_FILTER_WINDOW_LABELS } from "./filter-operators.js";
import {
  VALUELESS_CONDITION_OPERATORS,
  type ConditionOperator,
  type ConditionRow,
} from "./sentence.js";

/**
 * `changed.<field>` is a SYNTHETIC event key, not a property def — the update
 * emitter sets it to a boolean. It is matched by PREFIX only: the old
 * `key.includes("changed")` also captured an ordinary property named
 * `lastChangedBy` and forced it into the boolean branch.
 */
export const CHANGED_KEY_PREFIX = "changed.";

/** Is this key the synthetic `changed.<field>` boolean flag? */
export function isChangedFlagKey(key: string): boolean {
  return key.startsWith(CHANGED_KEY_PREFIX);
}

/**
 * Whether this operator needs a value control at all.
 *
 * `is_true`/`is_false` are `VALUELESS_CONDITION_OPERATORS` — the operator IS the
 * value, and the compiler's half-filled check skips them by name. Rendering an
 * empty box beside one would ask for an answer nothing reads.
 */
export function conditionTakesValue(operator: ConditionOperator): boolean {
  return !VALUELESS_CONDITION_OPERATORS.includes(operator);
}

/**
 * ONE derivation of what a narrowing row SAYS — read by the card AND by the
 * stored intent.
 *
 * ⚠️ THIS IS THE FIX FOR A SENTENCE THAT LIED. `draftIntent` used to pass only
 * {@link changedFieldConditions}, so a rule narrowed to `Amount greater than
 * 500` was stored — and shown back on the rules list — as "As soon as an
 * invoice was updated, Tell me." The threshold, which is the entire point of
 * the rule, was absent from the one line the user re-reads. Meanwhile the CARD
 * showed neither. Two projections, one of them silently short: exactly the
 * shape {@link ruleSentenceText}'s own docstring says must not happen.
 *
 * Both now read this. A clause that is not built here reaches neither, so the
 * card and the record cannot disagree about what the rule says.
 */
export interface ConditionClause {
  /** The row's id — unique in the draft, so it is also a stable chip key. */
  id: string;
  /** The narrowed property, humanised through the vocabulary door. */
  field: string;
  /** How it is compared. Chip-cased ("Greater than"); prose lowercases it. */
  comparison: string;
  /** The value, VERBATIM. Absent when the operator takes none. */
  value?: string;
  /**
   * The operator takes a value and none has been typed yet.
   *
   * Not a blocker — `sentenceBlockedReason` owns Save — but the card must be
   * able to mark a half-written clause, because a clause reading "Amount is
   * over" looks finished and narrows nothing.
   */
  incomplete: boolean;
}

/**
 * The word a `changed.<field>` row reads as.
 *
 * NOT an operator label. The row's operator is `is_true`, and rendering "Is
 * true" beside a field name would be a sentence about a boolean the user never
 * typed — the key itself is what carries the meaning. So the word is taken
 * from `CHANGED_KEY_PREFIX` (the grammar's own spelling) through the SAME
 * humaniser every other token here goes through, rather than typed as a
 * literal: rename the prefix upstream and this word follows it.
 */
const CHANGED_CLAUSE_COMPARISON = humanizeToken(
  CHANGED_KEY_PREFIX.replace(/\.$/, "")
).toLowerCase();

/**
 * The words a stored window key reads as, from the SHARED table so the sentence,
 * the picker and the pod cannot disagree about what "next_7_days" means.
 *
 * An unrecognised key returns '' rather than the raw token: the create door
 * refuses an unknown window by name, so a clause showing one would be
 * describing a rule that cannot be saved.
 */
export function conditionWindowLabel(value: string): string {
  return (
    TRIGGER_FILTER_WINDOW_LABELS[
      value as keyof typeof TRIGGER_FILTER_WINDOW_LABELS
    ] ?? ""
  );
}

/**
 * An operator's TWO MOODS — one derivation, two presentations.
 *
 * ⚠️ NOT two label tables. `.claude/rules/vocabulary.md` forbids a second map
 * for a value that exists in the type system, and it ALSO records that a verb
 * carries two moods which are not interchangeable (`imperative` for a button,
 * `past` for a receipt). An operator is the same shape of problem:
 *
 *   `standalone` — "Greater than". A PICKER ROW, which starts a line and is
 *                  read on its own. `humanizeToken`, exactly as before.
 *   `inline`     — "greater than". MID-CLAUSE, inside "Amount greater than
 *                  500", where a capital reads as the start of a sentence that
 *                  is not there.
 *
 * Lower-casing here is safe in a way it is NOT for a door label: a
 * `ConditionOperator` is a closed machine enum and can never be a proper noun.
 * This file's header records the opposite case — "Otter finished a transcript"
 * must never become "otter…" — which is why the card renders door labels
 * VERBATIM and only ever lowercases words it owns itself.
 *
 * Doing it at the render site instead was considered and rejected: the STORED
 * INTENT needs the inline form too, and a `.toLowerCase()` at two call sites is
 * the `charAt(0).toUpperCase()` anti-pattern with the sign flipped.
 */
export type OperatorMood = "standalone" | "inline";

export function conditionOperatorLabel(
  operator: ConditionOperator,
  mood: OperatorMood = "standalone"
): string {
  const word = humanizeToken(operator);
  return mood === "inline"
    ? word.charAt(0).toLowerCase() + word.slice(1)
    : word;
}

/**
 * Every narrowing row the rule carries, in draft order, as readable clauses.
 *
 * Both row shapes, one list: the `changed.<field>` flags and the general
 * property comparisons are ANDed by the matcher exactly alike, so a reader has
 * no business being shown them as two different kinds of thing.
 */
export function conditionClauses(
  /** The rule sentence — only its `conditions` are read. */
  sentence: { readonly conditions: readonly ConditionRow[] },
  /**
   * The trigger profile's effective property defs, when the caller has them.
   *
   * ⚠️ A slug is NOT a label. The desktop renders `budget` raw in its field
   * pill; relay must not. Precedence is the SSOT's own —
   * `uiHints.displayName` → `uiHints.label` → humanised slug — which
   * `resolvePropertyLabel` owns in `@synap-core/property-renderer`. That
   * package is a WEB BARREL relay may not value-import (it reaches
   * `localStorage` at module scope and crashes Hermes at startup), and it
   * publishes no leaf subpath for `utils/fieldFormatters`. So the PRECEDENCE
   * is mirrored — three lines, no table — rather than the module. If a leaf
   * subpath ever appears, import it and delete this.
   *
   * Optional so the builder stays pure and callable with nothing loaded: the
   * fallback is the same `humanizeToken` every other slug on this screen goes
   * through, so an absent list is a plainer label, never a different rule.
   */
  properties: readonly PropertyLabelSource[] = []
): ConditionClause[] {
  return sentence.conditions.map((row) => {
    if (isChangedFlagKey(row.key)) {
      const slug = row.key.slice(CHANGED_KEY_PREFIX.length);
      return {
        id: row.id,
        field: propertyLabel(slug, properties),
        comparison: CHANGED_CLAUSE_COMPARISON,
        incomplete: false,
      };
    }
    const takesValue = conditionTakesValue(row.operator);
    const value = row.value.trim();

    // ── A WINDOW IS ITS OWN PREDICATE ─────────────────────────────────────
    // `is_within`'s value is a `TRIGGER_FILTER_WINDOWS` key whose label is a
    // full predicate ("is today (UTC)", "is in the past"). Rendering the
    // operator word too gives "Deadline is within is today (UTC)" — two verbs
    // for one comparison. The window carries the whole phrase, so the operator
    // stays out of the clause; it is still shown in the OPERATOR PICKER, where
    // "Is within" is a sensible menu entry.
    if (row.operator === "is_within") {
      const label = value ? conditionWindowLabel(value) : "";
      return {
        id: row.id,
        field: propertyLabel(row.key, properties),
        comparison: label || "is within",
        incomplete: label.length === 0,
      };
    }

    return {
      id: row.id,
      field: propertyLabel(row.key, properties),
      // The INLINE mood: this word lands inside "Amount greater than 500".
      comparison: conditionOperatorLabel(row.operator, "inline"),
      ...(takesValue && value ? { value } : {}),
      incomplete: takesValue && value.length === 0,
    };
  });
}

/** Just enough of an effective property def to name it. */
export interface PropertyLabelSource {
  slug: string;
  uiHints?: { displayName?: string; label?: string } | null | undefined;
}

/**
 * The words a property reads as: what its author called it, else the slug
 * humanised through the vocabulary door.
 */
export function propertyLabel(
  slug: string,
  properties: readonly PropertyLabelSource[] = []
): string {
  const hints = properties.find((p) => p.slug === slug)?.uiHints;
  // `uiHints` is untyped JSONB on the wire (`Record<string, unknown>` at the
  // hook), so the structural type here accepts a def whose hint is not a
  // string. `typeof` rather than `?.trim()`: a number in that column would
  // throw and take the whole card down for a cosmetic field.
  const authored = [hints?.displayName, hints?.label]
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .find((v) => v.length > 0);
  return authored ?? humanizeToken(slug);
}

/** One clause as prose, for the stored intent AND for its chip. */
export function clauseText(clause: ConditionClause): string {
  const words = [clause.field, clause.comparison];
  if (clause.value) words.push(clause.value);
  return words.join(" ");
}

/** What an empty THEN reads as in the phrasing. Card glue, so lowercase. */
const FIRST_ACTION_PROMPT = "an action";

/**
 * The one sentence phrasing, from labels the door owns.
 *
 * Shared with the starter rows so a starter READS AS the sentence it produces
 * when tapped. They used to render `<event> → <action>`, which taught a
 * flow-arrow grammar the screen uses nowhere else — on the one element whose
 * whole job is to teach "As soon as X, Y."
 */
export function ruleSentenceText(
  when: string,
  thens: readonly string[],
  /**
   * The WHOLE narrowing, as {@link ConditionClause}s.
   *
   * ⚠️ It used to be `changedFields: string[]` — the `changed.<k>` flags ONLY —
   * and `draftIntent` passed exactly those. A rule narrowed to `Amount greater
   * than 500` was therefore stored as "As soon as an invoice was updated, Tell
   * me": the threshold, the entire point of the rule, absent from the one line
   * the rules list shows back. Taking clauses rather than field names is what
   * makes that unrepresentable — there is one builder, and both the card and
   * this string read it.
   *
   * Joined with "and" because the matcher ANDs conditions, never ORs them.
   * NEVER truncated: this is the record, and the elision on a chip is a layout
   * decision that must not reach it.
   */
  clauses: readonly ConditionClause[] = []
): string {
  const narrowed = clauses.length
    ? `${when} and ${clauses.map(clauseText).join(" and ")}`
    : when;
  return `As soon as ${narrowed}, ${
    thens.length ? thens.join(" and ") : FIRST_ACTION_PROMPT
  }.`;
}
