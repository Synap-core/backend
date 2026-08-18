/**
 * `{{...}}` template resolution over a `StepContext` — shared by every step
 * executor. Extracted as a leaf (only depends on `context-path.ts` and
 * `unresolved-references.ts`, never on the worker or a `steps/*` module).
 */
import { recordUnresolvedReference } from "./unresolved-references.js";
import {
  lookupContextPath,
  resolveContextPath,
  resolveReferencePath,
} from "./context-path.js";
import type { StepContext } from "./automation-executor-types.js";

/**
 * Resolve template variables in a string.
 * Supports: {{trigger.payload.field}}, {{steps.stepId.output.field}}, {{loop.item}}
 */
export function resolveTemplate(
  template: string,
  context: StepContext
): string {
  return template.replace(/\{\{(.+?)\}\}/g, (_, path: string) => {
    const { value: current, miss } = lookupContextPath(path, context);
    // UNCHANGED BEHAVIOR: anything that resolves to nothing still renders "".
    // Flows depend on it (an absent `{{trigger.payload.prompt}}` means "no
    // steer given"). We only stop being SILENT about it — see
    // unresolved-references.ts for why that mattered.
    if (miss) {
      recordUnresolvedReference(path.trim(), miss);
      return "";
    }
    // A Date renders as an ISO string (not JSON-quoted) — keep the old
    // human-readable passthrough for raw Date fields (e.g. a query step's
    // createdAt), since JSON.stringify would wrap it in quotes.
    if (current instanceof Date) return current.toISOString();
    // Other non-scalars (arrays/objects) are JSON-encoded, NOT String()-ed — a
    // bare `String({...})` yields "[object Object]", silently corrupting any
    // object interpolated into a prompt/config (e.g. graph relations to an AI step).
    if (typeof current === "object") return JSON.stringify(current);
    return String(current);
  });
}

/**
 * Is this string ONE whole-string `{{path}}` reference (a value binding), as
 * opposed to text that merely CONTAINS placeholders (an interpolation)?
 *
 * Returns the inner path for a value binding, or `null` for interpolation.
 *
 * WHY `[^{}]` AND NOT `.+?` — this is the fix for a silent data-loss bug.
 * The obvious pattern `/^\{\{(.+?)\}\}$/` looks non-greedy but is anchored at
 * BOTH ends, so the engine backtracks until the trailing `\}\}` lines up with
 * the LAST `}}` in the string. That means a genuine interpolation like
 *   "{{item.id}} · {{item.title}}"
 * MATCHES, and captures the nonsense path `item.id}} · {{item.title` — which
 * resolves to `undefined`. Not an error, not a warning: a null, silently, in
 * place of the user's data.
 *
 * Observed live 2026-07-27: every projection node in the report automation
 * emitted `[null, null, …]`, so all three AI rounds were handed empty lists and
 * faithfully reported "the workspace contains no data" — while the `query`
 * steps upstream had in fact returned 15 notes, 25 tasks, and so on, and every
 * step reported SUCCESS. The data was fetched, then destroyed in transit.
 *
 * Requiring the captured path to contain NO braces makes a value binding
 * exactly what it claims to be: one reference, nothing else. Any string with a
 * second placeholder in it is interpolation and takes the string path.
 */
export function matchWholeStringReference(value: string): string | null {
  const m = value.match(/^\{\{([^{}]+)\}\}$/);
  return m ? m[1] : null;
}

/**
 * Deep-resolve templates in any value (string, object, array).
 */
export function deepResolveTemplates(
  value: unknown,
  context: StepContext
): unknown {
  if (typeof value === "string") {
    // An exact placeholder is a value binding, not text interpolation. Preserve
    // its native number/boolean/object shape for governed output verbs; only an
    // embedded placeholder is rendered as a human string.
    const exactReference = matchWholeStringReference(value);
    return exactReference !== null
      ? resolveReferencePath(exactReference, context)
      : resolveTemplate(value, context);
  }
  if (Array.isArray(value))
    return value.map((v) => deepResolveTemplates(v, context));
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = deepResolveTemplates(v, context);
    }
    return result;
  }
  return value;
}

/**
 * Resolve all input mappings for a command step.
 *
 * `mapping` is OPTIONAL at runtime even though most callers have one: a flow
 * node authored without an `inputMapping` (the shipped
 * `relay-new-contact-enrichment` command node is one) reaches here as
 * `undefined`, and `Object.entries(undefined)` throws "Cannot convert
 * undefined or null to object" — which killed the whole run at step 1.
 *
 * Three of the four call sites already defended with `?? {}` / a ternary, so
 * the optionality was known; only the extracted command-step path did not, and
 * the non-optional signature meant tsc could never say so. Absorbing it here
 * fixes every caller and makes a fourth guard unnecessary.
 */
export function resolveInputMapping(
  mapping: Record<string, string> | null | undefined,
  context: StepContext
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, template] of Object.entries(mapping ?? {})) {
    resolved[key] = resolveTemplate(template, context);
  }
  return resolved;
}

/**
 * Resolve a value binding that may be a plain value, a whole-string `{{...}}`
 * reference (returns the native value), or embedded template text (returns the
 * rendered string). Shared by the entity-lookup, control-flow and query step
 * families for their `equals` / `when` / property-match arguments.
 */
export function resolveBoundValue(
  value: unknown,
  context: StepContext
): unknown {
  if (typeof value !== "string") return value;
  const exactReference = matchWholeStringReference(value);
  return exactReference !== null
    ? resolveReferencePath(exactReference, context)
    : resolveTemplate(value, context);
}

// resolveContextPath is re-exported here for convenience so step modules that
// need BOTH template resolution and a raw existence-probe path lookup can
// import from one place; the canonical definition lives in context-path.ts.
export { resolveContextPath };
