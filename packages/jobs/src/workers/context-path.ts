/**
 * Dot-path lookup over a `StepContext` — the primitive both template
 * resolution (`template-resolve.ts`) and every step executor's existence
 * probes / value bindings build on. Extracted as a leaf so it has no
 * dependency on the worker or any `steps/*` module.
 */
import {
  recordUnresolvedReference,
  type UnresolvedReferenceReason,
} from "./unresolved-references.js";
import type { StepContext } from "./automation-executor-types.js";

/**
 * Walk a dot-path from context, distinguishing WHY it produced nothing.
 *
 * `miss: "missing"` — a segment does not exist on the context (typo, a step
 * that never ran, or a junk path like the `item.id}} · {{item.title` a
 * mis-anchored regex once captured). `miss: "null"` — every segment existed and
 * the value is null/undefined. `miss: null` — a real value (possibly `""`).
 *
 * The early `in` check is NOT a behavior change: previously a missing segment
 * left `current === undefined`, and the next iteration's null-guard bailed with
 * the same result. It only lets us name the failure.
 */
export function lookupContextPath(
  path: string,
  context: StepContext
): { value: unknown; miss: UnresolvedReferenceReason | null } {
  const parts = path.trim().split(".");
  let current: unknown = context;
  for (const part of parts) {
    if (current == null || typeof current !== "object")
      return { value: undefined, miss: "missing" };
    if (!(part in (current as Record<string, unknown>)))
      return { value: undefined, miss: "missing" };
    current = (current as Record<string, unknown>)[part];
  }
  return { value: current, miss: current == null ? "null" : null };
}

/**
 * Resolve a dot-path from context to its actual value (not stringified).
 *
 * Deliberately NON-recording: several callers use it as an EXISTENCE PROBE
 * (guard-node `check.path`, dedup candidate paths) where "absent" is a normal
 * answer, and recording those would drown the real signal. Sites that resolve a
 * reference the AUTHOR WROTE use `resolveReferencePath` below.
 */
export function resolveContextPath(
  path: string,
  context: StepContext
): unknown {
  return lookupContextPath(path, context).value;
}

/**
 * `resolveContextPath` + diagnostics. Use at every site that resolves a
 * user-authored `{{...}}` value binding (whole-string reference, pipe argument,
 * loop iterator) — the string-interpolation sites are covered by
 * `resolveTemplate`.
 */
export function resolveReferencePath(
  path: string,
  context: StepContext
): unknown {
  const { value, miss } = lookupContextPath(path, context);
  if (miss) recordUnresolvedReference(path.trim(), miss);
  return value;
}
