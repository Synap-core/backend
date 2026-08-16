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
] as const;

export type TriggerFilterOperator = (typeof TRIGGER_FILTER_OPERATORS)[number];

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

/** Coerce for a numeric comparison, or `undefined` when the value does not
 * participate — the in-memory equivalent of SQL's `NULL`, which drops the row. */
function toComparableNumber(value: unknown): number | undefined {
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && NUMERIC_TEXT.test(value.trim())) {
    return Number(value.trim());
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
  expected: unknown
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
      if (NUMERIC_OPERATORS.has(op)) {
        if (toComparableNumber(operand) === undefined) {
          return {
            ok: false,
            error: `${where}.${op} must be a number (or a numeric string) — it is compared numerically.`,
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
