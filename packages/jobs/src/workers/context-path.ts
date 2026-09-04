/**
 * Context-path lookup over a `StepContext` (dot + bracket segments) — the
 * primitive both template resolution (`template-resolve.ts`) and every step
 * executor's existence probes / value bindings build on. Extracted as a leaf so it has no
 * dependency on the worker or any `steps/*` module.
 */
import {
  recordUnresolvedReference,
  type UnresolvedReferenceReason,
} from "./unresolved-references.js";
import type { StepContext } from "./automation-executor-types.js";

/**
 * The context ROOTS a path may start from. Exported so the condition grammar
 * (`condition-eval.ts`) recognises the same set of bare operand paths this
 * resolver can walk — including bracket-rooted ones (`steps["query-1"]...`),
 * which a `^root\.` test silently rejected.
 */
export const CONTEXT_ROOT_PATTERN = /^(trigger|steps|automation|loop|item)[.[]/;

/** One bare `.`-separated segment: anything that is not a separator. */
const BARE_SEGMENT_RE = /^[^.[\]]+/;
/** One bracket accessor: `["k"]`, `['k']` or `[0]`. */
const BRACKET_SEGMENT_RE = /^\[\s*(?:"([^"]*)"|'([^']*)'|(\d+))\s*\]/;

/**
 * Parse a context path into its segments.
 *
 * GRAMMAR — a bare `.`-separated path where any segment may be followed by one
 * or more bracket accessors:
 *
 *   steps.query1.output.count
 *   steps["query-1"].output.count      ← double-quoted key
 *   steps['query-1'].output.entities   ← single-quoted key
 *   steps["query-1"].output.entities[0].id
 *
 * WHY brackets exist: a flow NODE ID may contain a hyphen (`query-1` is the id
 * the relay flow templates ship with), and `steps.query-1.output` cannot express
 * it — `query-1` is a single key, not two. Until 2026-09-03 this function was a
 * pure `split(".")`, so every authored `steps["query-1"]…` reference resolved to
 * `miss: "missing"` and rendered `""` — which made `… > 0` constantly false and
 * pruned the whole downstream branch of two shipped flows while the run still
 * finalized `completed`.
 *
 * NUMERIC INDEX — `a[0]` is looked up as the KEY `"0"`, exactly like the already
 * legal `a.0`. On an array that IS the array index (`0 in ["x"]` is true, and an
 * out-of-range index misses); on an object it is the `"0"` property. One
 * uniform rule, no array/object special-casing.
 *
 * Returns `null` for a malformed path (an unterminated or non-literal bracket,
 * an empty segment, a leading `.`/`[`). Callers treat that as `miss: "missing"`,
 * which is what a junk path already produced under the dot-split.
 */
export function parseContextPath(path: string): string[] | null {
  let rest = path.trim();
  const first = BARE_SEGMENT_RE.exec(rest);
  if (!first) return null;
  const segments: string[] = [first[0]];
  rest = rest.slice(first[0].length);

  while (rest.length > 0) {
    if (rest[0] === ".") {
      const m = BARE_SEGMENT_RE.exec(rest.slice(1));
      if (!m) return null;
      segments.push(m[0]);
      rest = rest.slice(1 + m[0].length);
      continue;
    }
    const b = BRACKET_SEGMENT_RE.exec(rest);
    if (!b) return null;
    segments.push(b[1] ?? b[2] ?? b[3]);
    rest = rest.slice(b[0].length);
  }
  return segments;
}

/**
 * Walk a context path (see `parseContextPath` for the grammar), distinguishing
 * WHY it produced nothing.
 *
 * `miss: "missing"` — a segment does not exist on the context (typo, a step
 * that never ran, a junk path like the `item.id}} · {{item.title` a
 * mis-anchored regex once captured, or a malformed bracket). `miss: "null"` —
 * every segment existed and the value is null/undefined. `miss: null` — a real
 * value (possibly `""`).
 *
 * The early `in` check is NOT a behavior change: previously a missing segment
 * left `current === undefined`, and the next iteration's null-guard bailed with
 * the same result. It only lets us name the failure.
 */
export function lookupContextPath(
  path: string,
  context: StepContext
): { value: unknown; miss: UnresolvedReferenceReason | null } {
  const parts = parseContextPath(path);
  if (!parts) return { value: undefined, miss: "missing" };
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
 * Resolve a context path to its actual value (not stringified).
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
