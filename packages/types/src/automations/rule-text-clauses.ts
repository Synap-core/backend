/**
 * MOVED HERE from `relay-app/src/components/rule-compose/rule-text-clauses.ts`
 * (2026-10-06) so every rule composer — relay, the browser workbench, and the
 * pod's own `parseRuleText` door — reads typed text with ONE phrase book. A
 * second copy of the operator phrases is how "is greater than" and "is" start
 * parsing differently on two surfaces. Pure, zero dependencies beyond the
 * grammar's own `ConditionOperator`.
 *
 * "a task when deadline is today" → an OBJECT and a CONDITION.
 *
 * ── Why this exists beside `rule-text-match.ts` ────────────────────────────
 * That module (`rule-text-match.ts`, beside this one) scores the typed text against whole EVENT LABELS by word
 * coverage. It is good at "an invoice was created" and it returns NOTHING for
 * the founder's own sentence: "a task when deadline is today" shares two words
 * with "A task was updated", scores under the 0.6 threshold, and produces
 * `{ trigger: null, actions: [] }` — no chips at all. Measured, not assumed.
 *
 * The sentence people actually type names an OBJECT and then narrows it. So
 * this module answers the two questions label-coverage cannot:
 *   1. which object is this about (`task`),
 *   2. what narrowing did they say (`deadline` `is_within` `today`).
 *
 * ── It parses SHAPE, it does not resolve MEANING ───────────────────────────
 * A clause comes back with the property words AS TYPED (`"deadline"`), never a
 * slug. Only the caller knows which profile is in force and therefore whether
 * `deadline` is `dueDate`, `deadlineAt`, or nothing at all. A parser that
 * guessed the slug would invent a narrowing the pod cannot honour — and an
 * unresolvable clause must be reported, never silently dropped: dropping the
 * narrowing while keeping the trigger produces a rule that fires on EVERY task,
 * which is the silent-widening defect this codebase keeps paying for.
 *
 * ── Operators come from the matrix, never from the phrase book ─────────────
 * Every phrase below maps to an operator the runtime can actually evaluate. The
 * date phrases exist only because `$within` does; before it, "is today" was
 * unauthorable and a parser that accepted it would have produced a rule that
 * saved green and never fired.
 */
import type { ConditionOperator } from "./sentence.js";

/** A narrowing the text asked for, before any property is resolved. */
export interface ParsedClause {
  /** The property words exactly as typed — `"deadline"`, `"total amount"`. */
  field: string;
  operator: ConditionOperator;
  /** A window key, a literal, or `''` for a valueless operator. */
  value: string;
}

/**
 * Phrases that name an operator, longest first so "is greater than" wins over
 * "is". Each entry is `[phrase, operator, value]`; a `value` of `null` means the
 * words AFTER the phrase are the value.
 */
const OPERATOR_PHRASES: ReadonlyArray<
  readonly [string, ConditionOperator, string | null]
> = [
  // ── dates, and every one of these needs `$within` to exist ──────────────
  ["is overdue", "is_within", "past"],
  ["is in the past", "is_within", "past"],
  ["is past", "is_within", "past"],
  ["is in the future", "is_within", "future"],
  ["is upcoming", "is_within", "future"],
  ["is today", "is_within", "today"],
  ["is due today", "is_within", "today"],
  ["is in the next 7 days", "is_within", "next_7_days"],
  ["is within the next 7 days", "is_within", "next_7_days"],
  ["is this week", "is_within", "next_7_days"],
  ["is in the last 7 days", "is_within", "last_7_days"],
  ["is in the last 24 hours", "is_within", "last_24_hours"],
  ["changed today", "is_within", "today"],
  // ── booleans: the operator IS the value ─────────────────────────────────
  ["is true", "is_true", ""],
  ["is false", "is_false", ""],
  ["is not set", "is_false", ""],
  // ── ordered ─────────────────────────────────────────────────────────────
  ["is greater than", "greater_than", null],
  ["is more than", "greater_than", null],
  ["is over", "greater_than", null],
  ["is above", "greater_than", null],
  ["greater than", "greater_than", null],
  ["more than", "greater_than", null],
  ["is less than", "less_than", null],
  ["is under", "less_than", null],
  ["is below", "less_than", null],
  ["less than", "less_than", null],
  // ── text ────────────────────────────────────────────────────────────────
  ["does not contain", "is_not", null],
  ["starts with", "starts_with", null],
  ["begins with", "starts_with", null],
  ["contains", "contains", null],
  ["includes", "contains", null],
  // ── equality, LAST so every phrase above wins over a bare "is" ──────────
  ["is not", "is_not", null],
  ["is", "is", null],
];

/** Words that introduce a narrowing. Everything after one is a clause. */
const NARROWING_MARKER = /\b(when|where|with|whose|that has|if)\b/i;
/** Clauses are ANDed; the matcher ANDs them too, so the reading matches. */
const CLAUSE_SPLIT = /\s+(?:and|,)\s+/i;

const STRIP_LEADING = /^(?:the|its|their|it|has|have)\s+/i;

function tidy(s: string): string {
  return s
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\s+/g, " ");
}

/**
 * The narrowings the text asked for.
 *
 * Returns `[]` when the sentence has no narrowing marker — a bare "an invoice
 * was created" is a complete rule and must not be mined for clauses that are
 * not there.
 */
export function parseConditionClauses(text: string): ParsedClause[] {
  const marker = text.search(NARROWING_MARKER);
  if (marker < 0) return [];
  const after = text.slice(marker).replace(NARROWING_MARKER, "");

  const out: ParsedClause[] = [];
  for (const raw of after.split(CLAUSE_SPLIT)) {
    const segment = tidy(raw);
    if (!segment) continue;
    const lower = segment.toLowerCase();

    for (const [phrase, operator, fixed] of OPERATOR_PHRASES) {
      const at = lower.indexOf(` ${phrase}`);
      if (at < 0) continue;
      const field = tidy(segment.slice(0, at)).replace(STRIP_LEADING, "");
      if (!field) break; // "is today" with nothing before it names no property
      const rest = tidy(segment.slice(at + phrase.length + 1));
      const value = fixed === null ? rest : fixed;
      // A value-taking operator with nothing after it is a half-typed clause,
      // not a clause. Reporting it as parsed would render a chip that cannot
      // compile.
      if (fixed === null && !value) break;
      out.push({ field, operator, value });
      break;
    }
  }
  return out;
}

/**
 * The OBJECT the text is about — the first event-pattern segment it names.
 *
 * `patterns` are the live event patterns (`task.updated`, `invoice.created`),
 * so the answer can only ever be an object the pod actually emits. Singular and
 * plural both resolve; nothing else does, because inventing an object is how a
 * rule gets authored against events that do not exist.
 */
export function matchObjectSegment(
  text: string,
  patterns: readonly string[]
): string | null {
  const words = text.toLowerCase().match(/[a-z_]+/g) ?? [];
  const segments = new Set(patterns.map((p) => p.split(".")[0]!));
  for (const word of words) {
    const singular = word.endsWith("s") ? word.slice(0, -1) : word;
    for (const candidate of [word, singular, `${word}_item`]) {
      if (segments.has(candidate)) return candidate;
    }
  }
  return null;
}
