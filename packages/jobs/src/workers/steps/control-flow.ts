/**
 * `guard` / `compute` / `select` step executors — pure, DB-free control-flow
 * and arithmetic primitives.
 */
import type { GuardNodeDef } from "@synap/database";
import { resolveContextPath, resolveBoundValue } from "../template-resolve.js";
import type { StepContext } from "../automation-executor-types.js";

class WorkflowGuardBlockedError extends Error {
  constructor(readonly detail: Record<string, unknown>) {
    super(`WORKFLOW_GUARD_BLOCKED:${JSON.stringify(detail)}`);
  }
}

export function executeGuardStep(
  data: GuardNodeDef["data"],
  context: StepContext
): Record<string, unknown> {
  for (const check of data.checks) {
    const value = resolveContextPath(check.path, context);
    const expected = resolveBoundValue(check.equals, context);
    const failed =
      (check.exists !== undefined && (value != null) !== check.exists) ||
      (check.equals !== undefined && value !== expected) ||
      (check.notEquals !== undefined &&
        value === resolveBoundValue(check.notEquals, context)) ||
      (check.arrayIncludes !== undefined &&
        (!Array.isArray(value) ||
          !value.includes(resolveBoundValue(check.arrayIncludes, context)))) ||
      (check.lengthEquals !== undefined &&
        (!Array.isArray(value) || value.length !== check.lengthEquals)) ||
      // `minLength` asserts CONTENT, which `exists` deliberately does not:
      // `exists` is a null check, so "" satisfies it. Strings are trimmed
      // first so a body of whitespace fails like the empty body it is. Any
      // non-string / non-array value fails rather than passing by accident.
      (check.minLength !== undefined &&
        (typeof value === "string"
          ? value.trim().length < check.minLength
          : Array.isArray(value)
            ? value.length < check.minLength
            : true)) ||
      (check.numberGte !== undefined &&
        (!(typeof value === "number") || value < check.numberGte)) ||
      (check.numberLte !== undefined &&
        (!(typeof value === "number") || value > check.numberLte)) ||
      (check.anyOf !== undefined &&
        !check.anyOf.some(
          (candidate) =>
            resolveContextPath(candidate.path, context) ===
            resolveBoundValue(candidate.equals, context)
        ));
    if (failed) {
      throw new WorkflowGuardBlockedError({
        code: "guard_failed",
        path: check.path,
        message: check.message,
        actual: value,
      });
    }
  }
  return { status: "passed", checks: data.checks.length };
}

export function executeComputeStep(
  data: {
    operation: "add" | "subtract" | "multiply" | "divide" | "coalesce" | "now";
    left?: unknown;
    right?: unknown;
    values?: unknown[];
  },
  context: StepContext
): Record<string, unknown> {
  if (data.operation === "now") {
    // Manual/event triggers carry a single invocation timestamp. Reusing it
    // makes a delayed/retried step deterministic for the run; system-created
    // runs without one retain the current-time fallback.
    const triggeredAt = resolveContextPath(
      "trigger.payload.timestamp",
      context
    );
    const date = typeof triggeredAt === "string" ? new Date(triggeredAt) : null;
    return {
      result:
        date && !Number.isNaN(date.getTime())
          ? date.toISOString()
          : new Date().toISOString(),
    };
  }
  if (data.operation === "coalesce") {
    for (const value of data.values ?? []) {
      const candidate = Number(resolveBoundValue(value, context));
      if (Number.isFinite(candidate)) return { result: candidate };
    }
    throw new Error("compute node: coalesce found no finite numeric value");
  }
  const left = Number(resolveBoundValue(data.left, context));
  const right = Number(resolveBoundValue(data.right, context));
  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    throw new Error("compute node: operands must resolve to finite numbers");
  }
  if (data.operation === "divide" && right === 0) {
    throw new Error("compute node: cannot divide by zero");
  }
  const result =
    data.operation === "add"
      ? left + right
      : data.operation === "subtract"
        ? left - right
        : data.operation === "multiply"
          ? left * right
          : left / right;
  if (!Number.isFinite(result))
    throw new Error("compute node: result is not finite");
  return { result };
}

/**
 * A finite, typed alternative to branching a whole graph just to select a
 * value. It accepts an already-resolved boolean, or the explicit 0/1 result of
 * a numeric compute node, without becoming an expression evaluator.
 */
export function executeSelectStep(
  data: { when: unknown; ifTrue: unknown; ifFalse: unknown },
  context: StepContext
): Record<string, unknown> {
  const when = resolveBoundValue(data.when, context);
  const predicate =
    typeof when === "boolean"
      ? when
      : when === 0
        ? false
        : when === 1
          ? true
          : undefined;
  if (predicate === undefined) {
    throw new Error("select node: 'when' must resolve to a boolean or 0/1");
  }
  return {
    value: resolveBoundValue(predicate ? data.ifTrue : data.ifFalse, context),
  };
}
