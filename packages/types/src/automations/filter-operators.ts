/**
 * Automation TRIGGER-FILTER operator grammar — the ONE vocabulary.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `automations.triggerConfig.filters` is a `Record<string, unknown>` map applied
 * to an event's `data` by the matcher (`@synap/jobs`
 * automation-trigger-matcher.ts). Until 2026-08-16 the matcher evaluated it with
 * a bare `actual !== expected`, while every live event-automation on the pod had
 * been authored with MongoDB-style operator objects
 * (`{ profileSlug: { $in: ["person","contact"] } }`). `"person" !== {…}` is
 * always true, so those automations were PERMANENTLY UNREACHABLE while reporting
 * `status: active` — the create door validated nothing, so the malformed filter
 * sailed straight through into a runtime that could not evaluate it.
 *
 * The operator syntax was not invented by the authors: the executor's QUERY node
 * (`@synap/jobs` workers/query-dsl.ts) has always accepted
 * `$gt/$gte/$lt/$lte/$ne` operator objects on its `filter` field. So the fix is
 * NOT a second dialect — it is ONE vocabulary, declared here, that BOTH the
 * runtime evaluator and the create-door validator import. Per the standing
 * repo rule (runtime-matches must never diverge from create-door-accepts), the
 * constant lives in `@synap-core/types` and every door imports DOWN to it.
 *
 * RELATIONSHIP TO query-dsl.ts (read before adding an operator)
 * ------------------------------------------------------------
 * `query-dsl.ts` compiles its operators to SQL over the `entities` table; this
 * module evaluates them IN MEMORY over an event payload. The two therefore share
 * the operator NAMES and the NUMERIC coercion rule, but they cannot share an
 * implementation — one emits `SQL`, the other returns `boolean`. Extracting a
 * common core would mean abstracting over "compare" itself, which buys nothing
 * and would drag `drizzle-orm` into `@synap-core/types` (a browser-safe package).
 * Sharing the VOCABULARY is what prevents drift; sharing the compiler is not
 * possible. `query-dsl.ts` imports `TRIGGER_FILTER_OPERATORS` from here so a new
 * operator name can never be added to one side alone.
 *
 * Two DELIBERATE differences from the SQL side, both forced:
 *   - `$in` is evaluable here but is NOT compiled by `query-dsl.ts` (it would
 *     need an `inArray`/`ANY` compile on a jsonb text extraction). A query node
 *     that uses `$in` logs a warning and drops the term rather than silently
 *     narrowing — see `query-dsl.ts`.
 *   - `$eq`/`$ne` compare with strict `===` here, where SQL compares `->>` text.
 *     jsonb `->>` is text-typed by construction; an event payload is not. Using
 *     `String()` coercion here would CHANGE the meaning of every plain-value
 *     filter that works today (`5` would start matching `"5"`), which is exactly
 *     the regression this change must not cause. `$eq` is therefore defined as
 *     "identical to a plain value", so the matcher has one equality, not two.
 */

/** The complete operator vocabulary. Adding a name here obliges BOTH the
 * in-memory evaluator below AND `query-dsl.ts`'s SQL compiler to account for it. */
export const TRIGGER_FILTER_OPERATORS = [
  "$eq",
  "$ne",
  "$in",
  "$gt",
  "$gte",
  "$lt",
  "$lte",
  // Relative time window, resolved against NOW at evaluation. See
  // `TRIGGER_FILTER_WINDOWS`. Not compiled by `query-dsl.ts` — it takes that
  // module's existing "in the shared vocabulary but not compiled to SQL"
  // branch, which drops the term with a named warning rather than silently.
  "$within",
  // Substring (on a string) or membership (in an array). Neither is compiled by
  // `query-dsl.ts`; both take its existing "in the shared vocabulary but not
  // compiled to SQL" branch, which drops the term with a named warning.
  "$contains",
  "$starts_with",
] as const;

/**
 * ⚠️ `$contains` and `$starts_with` compare CASE-INSENSITIVELY on strings, and
 * they are the only operators here that do.
 *
 * `$eq` stays strict — an exact match that quietly ignored case would change
 * the meaning of every stored equality filter. But a substring test is asked
 * for in the user's own words ("subject contains invoice"), and one that misses
 * "Invoice #42" is a rule that looks right and silently never fires on the very
 * rows it was written for. That is the failure this module exists to remove, so
 * the inconsistency is deliberate and stated rather than tidy and wrong.
 *
 * Array membership is a different comparison and stays EXACT: elements are
 * compared with `===`, the same test `$in` makes in the other direction.
 */

export type TriggerFilterOperator = (typeof TRIGGER_FILTER_OPERATORS)[number];

/**
 * The relative time windows `$within` accepts — a CLOSED set, on purpose.
 *
 * ── Why named windows and not a date expression ────────────────────────────
 * The alternative is letting an author write an absolute instant, which freezes
 * at authoring time ("deadline is today" would mean the day the rule was
 * written, forever) or a mini date language, which is a control that cannot
 * round-trip its own value on a phone (HA frontend#7463). Relative windows are
 * the precedented shape — Notion and Airtable both default to them — and a
 * closed set is one a picker can offer without inventing a parser.
 *
 * ── ZONE HONESTY, which splits this set in two ─────────────────────────────
 * Four of these are ROLLING: anchored on `now` and therefore identical in every
 * timezone. `today` is a CALENDAR window and is not — it needs a day boundary,
 * and the matcher has no per-user zone (the pod runs UTC; `ENV TZ=UTC` is
 * pinned in `deploy/Dockerfile`). So `today` means the UTC day, and any surface
 * offering it MUST say so. Prefer a rolling window wherever one expresses the
 * intent: `last_24_hours` is the same idea as "today" for most rules and is
 * true for every reader.
 */
export const TRIGGER_FILTER_WINDOWS = {
  /** Strictly before now — an overdue date. Rolling. */
  past: "past",
  /** Now or later. Rolling. */
  future: "future",
  /** Within the 24 hours ending now. Rolling. */
  last_24_hours: "last_24_hours",
  /** Within the 7 days ending now. Rolling. */
  last_7_days: "last_7_days",
  /** Between now and 7 days from now. Rolling. */
  next_7_days: "next_7_days",
  /** The current UTC calendar day. ⚠️ Zone-dependent — see the note above. */
  today: "today",
} as const;

export type TriggerFilterWindow = keyof typeof TRIGGER_FILTER_WINDOWS;

/**
 * The words each window reads as.
 *
 * Beside the windows, not in a surface, because a window key exists in the TYPE
 * SYSTEM — the test `.claude/rules/vocabulary.md` gives for "is this vocabulary
 * or copy?" — and two surfaces spelling "next_7_days" differently is the fork
 * that rule exists to prevent. It is NOT in `STATUS_LABELS`: a window is not a
 * lifecycle state, and that table warns against becoming a junk drawer.
 *
 * ⚠️ `today` names its zone. The matcher has no per-user timezone and the pod
 * runs UTC, so a bare "Today" would be a lie for anyone east or west of it —
 * the same defect the cron labels had. `last_24_hours` is offered right beside
 * it precisely so there is an honest option that means almost the same thing.
 */
export const TRIGGER_FILTER_WINDOW_LABELS: Readonly<
  Record<TriggerFilterWindow, string>
> = {
  past: "is in the past",
  future: "is in the future",
  last_24_hours: "is within the last 24 hours",
  last_7_days: "is within the last 7 days",
  next_7_days: "is within the next 7 days",
  today: "is today (UTC)",
};

const WINDOW_SET: ReadonlySet<string> = new Set(
  Object.keys(TRIGGER_FILTER_WINDOWS)
);

const DAY_MS = 86_400_000;

/**
 * Does `value` fall inside `window`, as of `now`?
 *
 * Exported so the authoring surfaces can PREVIEW a window without duplicating
 * the arithmetic — a second implementation of "what does today mean" is exactly
 * the fork the shared vocabulary exists to prevent.
 */
export function isWithinWindow(
  value: unknown,
  window: string,
  now: number
): boolean {
  const at = toComparableNumber(value);
  if (at === undefined || !WINDOW_SET.has(window)) return false;
  switch (window as TriggerFilterWindow) {
    case "past":
      return at < now;
    case "future":
      return at >= now;
    case "last_24_hours":
      return at > now - DAY_MS && at <= now;
    case "last_7_days":
      return at > now - 7 * DAY_MS && at <= now;
    case "next_7_days":
      return at >= now && at < now + 7 * DAY_MS;
    case "today": {
      // UTC day boundaries — see the zone note on TRIGGER_FILTER_WINDOWS.
      const start = Date.UTC(
        new Date(now).getUTCFullYear(),
        new Date(now).getUTCMonth(),
        new Date(now).getUTCDate()
      );
      return at >= start && at < start + DAY_MS;
    }
  }
}

const OPERATOR_SET: ReadonlySet<string> = new Set(TRIGGER_FILTER_OPERATORS);

/** Operators whose operand is compared NUMERICALLY (mirrors query-dsl.ts, whose
 * `numericPropertyExpr` casts the stored value to `numeric` for exactly these). */
const NUMERIC_OPERATORS: ReadonlySet<string> = new Set([
  "$gt",
  "$gte",
  "$lt",
  "$lte",
]);

/**
 * The numeric-text shape `query-dsl.ts` accepts (`numericPropertyExpr`'s
 * `~ '^-?[0-9]+(\.[0-9]+)?$'`). Kept byte-identical in intent so a string
 * payload value compares the same way whether it is read from jsonb by SQL or
 * from an event payload by the matcher.
 */
const NUMERIC_TEXT = /^-?[0-9]+(\.[0-9]+)?$/;

/**
 * ISO-8601 instants and plain dates, STRICTLY.
 *
 * Not `Date.parse`: it is engine-dependent and accepts things like
 * `"March 3"` and `"2026 foo"` on some runtimes, which would make a filter's
 * meaning depend on which Node built the pod. A filter that matches on one host
 * and not another is worse than one that never matches.
 */
const ISO_DATE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * Coerce for an ordered comparison, or `undefined` when the value does not
 * participate — the in-memory equivalent of SQL's `NULL`, which drops the row.
 *
 * ── DATES PARTICIPATE NOW, AND THAT IS THE WHOLE DATE UNLOCK ────────────────
 * This returned `undefined` for every ISO string, so `$gt/$gte/$lt/$lte`
 * ALWAYS failed closed on a date and the authoring grammar had to refuse the
 * whole `date` type (`CONDITION_OPERATORS_BY_VALUE_TYPE.date` was `[]`, with the
 * comment "numeric coercion fails on every ISO string"). Comparing dates
 * therefore needs no new operator NAMES — only a coercion that understands
 * them. Epoch milliseconds order identically to instants, so `$lt` on two dates
 * means exactly what a reader expects.
 *
 * ⚠️ STRICTLY WIDENING, and it must stay that way: every value that already
 * coerced still coerces to the SAME number, and only values that previously
 * returned `undefined` can now return one. So no stored automation can change
 * meaning — it can only start matching where it previously could not match at
 * all. NUMERIC TEXT KEEPS PRECEDENCE for the same reason: `"2026"` stays the
 * number 2026 and does not silently become a year.
 */
function toComparableNumber(value: unknown): number | undefined {
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    // Numeric first — see the precedence note above.
    if (NUMERIC_TEXT.test(trimmed)) return Number(trimmed);
    if (ISO_DATE.test(trimmed)) {
      const ms = Date.parse(trimmed);
      return Number.isNaN(ms) ? undefined : ms;
    }
    return undefined;
  }
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : undefined;
  }
  return undefined;
}

/**
 * Is this filter value an OPERATOR OBJECT (as opposed to a plain literal)?
 *
 * The test is deliberately strict — a plain object, not an array, with at least
 * one key and EVERY own key `$`-prefixed. Anything else (an array, a nested
 * literal object, a mixed `{ $in: [], name: "x" }`) is treated as a plain value
 * and compared with `===`, which is byte-identical to the pre-2026-08-16
 * behaviour: `!==` against any object is always true, so such a filter never
 * matched then and never matches now. No existing automation can change meaning.
 */
export function isTriggerFilterOperatorObject(
  value: unknown
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value as Record<string, unknown>);
  return keys.length > 0 && keys.every((k) => k.startsWith("$"));
}

/**
 * Evaluate ONE filter term against the value pulled out of the event payload.
 *
 * PLAIN-VALUE FALLBACK IS EXACTLY TODAY'S BEHAVIOUR (`actual === expected`), so
 * every automation that fires today keeps firing.
 *
 * FAIL-CLOSED on anything unevaluable: an operator object carrying an unknown
 * operator (`{ $regex: … }`) or a malformed operand returns `false` rather than
 * matching. That is also the pre-change outcome for such a filter (`!==` against
 * an object), so a fail-closed default cannot start firing something that was
 * previously inert. The create-door validator (`validateTriggerFilters`) rejects
 * these shapes up front; the runtime guard is for rows persisted before it.
 */
export function evaluateTriggerFilterValue(
  actual: unknown,
  expected: unknown,
  /**
   * Evaluation instant. Injected rather than read inside, so a `$within` filter
   * is deterministic under test — a time-dependent matcher that calls
   * `Date.now()` internally can only be tested by mocking the clock, and the
   * tests that result pin the mock instead of the rule.
   */
  now: number = Date.now()
): boolean {
  if (!isTriggerFilterOperatorObject(expected)) {
    return actual === expected;
  }

  for (const [op, operand] of Object.entries(expected)) {
    if (!OPERATOR_SET.has(op)) return false; // unknown operator — fail closed

    if (NUMERIC_OPERATORS.has(op)) {
      const a = toComparableNumber(actual);
      const b = toComparableNumber(operand);
      if (a === undefined || b === undefined) return false;
      if (op === "$gt" && !(a > b)) return false;
      if (op === "$gte" && !(a >= b)) return false;
      if (op === "$lt" && !(a < b)) return false;
      if (op === "$lte" && !(a <= b)) return false;
      continue;
    }

    if (op === "$contains") {
      if (!isPrimitive(operand)) return false;
      if (Array.isArray(actual)) {
        // Membership. `===` against each element, the same comparison `$in`
        // makes in the other direction.
        if (!actual.some((el) => el === operand)) return false;
        continue;
      }
      if (typeof actual !== "string" || typeof operand !== "string")
        return false;
      if (!actual.toLowerCase().includes(operand.toLowerCase())) return false;
      continue;
    }

    if (op === "$starts_with") {
      if (typeof actual !== "string" || typeof operand !== "string")
        return false;
      if (!actual.toLowerCase().startsWith(operand.toLowerCase())) return false;
      continue;
    }

    if (op === "$within") {
      if (
        typeof operand !== "string" ||
        !isWithinWindow(actual, operand, now)
      ) {
        return false;
      }
      continue;
    }

    if (op === "$in") {
      if (!Array.isArray(operand)) return false;
      if (!operand.some((candidate) => candidate === actual)) return false;
      continue;
    }

    if (op === "$eq" && actual !== operand) return false;
    if (op === "$ne" && actual === operand) return false;
  }

  return true;
}

/** A plain literal a filter may compare against. Anything else is either an
 * operator object or unevaluable. */
function isPrimitive(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

const SUPPORTED = TRIGGER_FILTER_OPERATORS.join(", ");
const SUPPORTED_WINDOWS = Object.keys(TRIGGER_FILTER_WINDOWS).join(", ");

export type TriggerFilterValidation =
  { ok: true } | { ok: false; error: string };

/**
 * CREATE-DOOR VALIDATOR — reject at authoring time anything
 * `evaluateTriggerFilterValue` cannot evaluate to a meaningful `true`.
 *
 * This exists because `automation.create` is on the pod's auto-approve list: an
 * agent-authored automation lands `status: active` with no human review, so the
 * door is the ONLY place a malformed filter can be caught. An automation whose
 * filter can never match is indistinguishable, from the outside, from one whose
 * event has simply not happened yet (`runCount: 0` on an `active` row) — which
 * is why silence here costs so much and why every rejection below names the
 * supported grammar in its message.
 *
 * Every rejected shape is one that matches ZERO events under BOTH the old and
 * the new matcher, so this can never reject an automation that works.
 */
export function validateTriggerFilters(
  filters: unknown
): TriggerFilterValidation {
  if (filters === undefined || filters === null) return { ok: true };
  if (
    typeof filters !== "object" ||
    Array.isArray(filters) ||
    filters instanceof Date
  ) {
    return {
      ok: false,
      error:
        "triggerConfig.filters must be an object mapping event-data keys (dot-notation supported) to a value or an operator object.",
    };
  }

  for (const [key, value] of Object.entries(
    filters as Record<string, unknown>
  )) {
    const where = `triggerConfig.filters["${key}"]`;

    if (isPrimitive(value)) continue;

    if (value === undefined) {
      return {
        ok: false,
        error: `${where} is undefined. Use a value, or an operator object (${SUPPORTED}).`,
      };
    }

    if (Array.isArray(value)) {
      return {
        ok: false,
        error: `${where} is an array, which is compared by identity and can never match an event value. Use { "$in": [...] } to match any of several values.`,
      };
    }

    if (!isTriggerFilterOperatorObject(value)) {
      return {
        ok: false,
        error: `${where} is a nested object, which is compared by identity and can never match an event value. Address nested event data with a dot-notation KEY (e.g. "channel.contextObjectType"), and compare it to a value or an operator object (${SUPPORTED}).`,
      };
    }

    for (const [op, operand] of Object.entries(
      value as Record<string, unknown>
    )) {
      if (!OPERATOR_SET.has(op)) {
        return {
          ok: false,
          error: `${where} uses unsupported operator "${op}". Supported operators: ${SUPPORTED}.`,
        };
      }
      if (op === "$in") {
        if (!Array.isArray(operand) || operand.length === 0) {
          return {
            ok: false,
            error: `${where}.$in must be a non-empty array of values.`,
          };
        }
        if (!operand.every(isPrimitive)) {
          return {
            ok: false,
            error: `${where}.$in must contain only strings, numbers, booleans or null.`,
          };
        }
        continue;
      }
      if (op === "$within") {
        // Rejected HERE rather than at evaluation. An unknown window fails
        // closed in the matcher, which looks exactly like "the rule is fine,
        // nothing matched yet" — the failure mode this whole module exists to
        // remove. The door names the windows so a typo is fixable.
        if (typeof operand !== "string" || !WINDOW_SET.has(operand)) {
          return {
            ok: false,
            error: `${where}.$within must be one of: ${SUPPORTED_WINDOWS}.`,
          };
        }
        continue;
      }
      if (NUMERIC_OPERATORS.has(op)) {
        if (toComparableNumber(operand) === undefined) {
          return {
            ok: false,
            error: `${where}.${op} must be a number, a numeric string, or an ISO-8601 date — it is compared as an ordered value.`,
          };
        }
        continue;
      }
      // $eq / $ne
      if (!isPrimitive(operand)) {
        return {
          ok: false,
          error: `${where}.${op} must be a string, number, boolean or null.`,
        };
      }
    }
  }

  return { ok: true };
}
