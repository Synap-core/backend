/**
 * The automation `condition`/`switch` expression grammar. Extracted as a leaf
 * (depends only on `context-path.ts` + `template-resolve.ts`) so both the
 * run-loop (`automation-executor.ts`) and the `transform` step's `filter:`/
 * `map:` pipes (`steps/transform.ts`) share ONE evaluator.
 */
import { resolveReferencePath } from "./context-path.js";
import { resolveTemplate } from "./template-resolve.js";
import type { StepContext } from "./automation-executor-types.js";

function resolveOperandList(raw: string, context: StepContext): string[] {
  const trimmed = raw.trim();
  const unquote = (s: string): string => {
    const t = s.trim();
    if (
      (t.startsWith("'") && t.endsWith("'")) ||
      (t.startsWith('"') && t.endsWith('"'))
    ) {
      return t.slice(1, -1);
    }
    return t;
  };

  // Bare context path → resolve to its native value.
  if (/^(trigger|steps|automation|loop|item)\./.test(trimmed)) {
    const value = resolveReferencePath(trimmed, context);
    if (value == null) return [];
    if (Array.isArray(value))
      return value.filter((v) => v != null).map((v) => String(v));
    return [String(value)];
  }

  // Inline comma-separated literal list.
  if (trimmed.includes(",")) {
    return trimmed
      .split(",")
      .map(unquote)
      .filter((s) => s !== "");
  }

  // Single literal.
  const single = unquote(trimmed);
  return single === "" ? [] : [single];
}

export function evaluateCondition(
  expression: string,
  context: StepContext
): boolean {
  // Parse simple comparison: left op right
  const match = expression.match(/^(.+?)\s*(===|!==|==|!=|>=|<=|>|<)\s*(.+)$/);

  // Membership operators (list-based) — `in` / `not-in` / `contains` /
  // `contains-any`. Both operands are coerced to string lists (a scalar → a
  // one-element list) and the check is a NON-EMPTY INTERSECTION, so `in`,
  // `contains` and `contains-any` are ergonomic aliases that read naturally by
  // position (value ∈ list / list ∋ value / either side a list) — they compute
  // the SAME thing. `not-in` is the negation (a deny-list keep-gate:
  // `trigger.payload.from not-in trigger.payload.denylist`).
  const memberMatch = expression.match(
    /^(.+?)\s+(contains-any|contains|not-in|in)\s+(.+)$/
  );
  // Disambiguate when BOTH parse (e.g. `k === 'fell in love'` — a `===` compare
  // whose literal contains " in "): the operator that appears LEFTMOST wins
  // (the shorter left operand = the earlier operator).
  if (memberMatch && (!match || memberMatch[1].length < match[1].length)) {
    const [, leftRaw, memberOp, rightRaw] = memberMatch;
    const leftList = resolveOperandList(leftRaw, context);
    const rightSet = new Set(resolveOperandList(rightRaw, context));
    const intersects = leftList.some((v) => rightSet.has(v));
    return memberOp === "not-in" ? !intersects : intersects;
  }

  if (!match) {
    throw new Error(
      `Automation condition could not be parsed (fail-closed): "${expression}"`
    );
  }

  const [, leftPath, operator, rightRaw] = match;
  const leftValue = resolveTemplate(`{{${leftPath.trim()}}}`, context);

  // Parse right side: quoted → string literal, numeric → number, a bare
  // context path (trigger./steps./automation./loop./item.) → resolve it as a
  // template too so a condition can compare two resolved paths, e.g.
  // `trigger.payload.subjectId !== trigger.payload.data.channelId`. The left
  // operand is always resolved; without this the right path would be compared
  // as the literal string "trigger.payload.data.channelId" and never match.
  // Anything else (e.g. `true`, `active`) stays a bare string literal.
  let rightValue: string | number = rightRaw.trim();
  if (
    (rightValue.startsWith("'") && rightValue.endsWith("'")) ||
    (rightValue.startsWith('"') && rightValue.endsWith('"'))
  ) {
    rightValue = rightValue.slice(1, -1);
  } else if (rightValue !== "" && !isNaN(Number(rightValue))) {
    rightValue = Number(rightValue);
  } else if (/^(trigger|steps|automation|loop|item)\./.test(rightValue)) {
    rightValue = resolveTemplate(`{{${rightValue}}}`, context);
  }

  // Empty string → NaN (not 0) so a missing operand fails a numeric compare
  // instead of silently satisfying `< N`.
  const toNum = (v: string | number): number => (v === "" ? NaN : Number(v));

  const left = typeof rightValue === "number" ? toNum(leftValue) : leftValue;

  switch (operator) {
    case "===":
    case "==":
      return left === rightValue;
    case "!==":
    case "!=":
      return left !== rightValue;
    case ">":
      return toNum(left) > toNum(rightValue);
    case "<":
      return toNum(left) < toNum(rightValue);
    case ">=":
      return toNum(left) >= toNum(rightValue);
    case "<=":
      return toNum(left) <= toNum(rightValue);
    default:
      throw new Error(
        `Automation condition has an unknown operator "${operator}" (fail-closed): "${expression}"`
      );
  }
}
