/**
 * Miss diagnostics for the command-template grammar (`@{arg:…}` / `{name}`).
 *
 * WHY THIS EXISTS — `ParsedTemplate.substitute()` renders EVERY unresolvable
 * reference as the empty string. That is deliberate and load-bearing (an
 * optional param that was not supplied must vanish, not blow up the prompt),
 * but it also means a genuine authoring bug is INVISIBLE: a renamed argument
 * silently empties half a prompt and the model is handed the mutilated text
 * with no signal that anything went wrong. Grammar #3 (`{{path}}`, the
 * automation DAG) paid for that lesson on 2026-07-27 and answered it with
 * `packages/jobs/src/workers/unresolved-references.ts`. This is the same
 * answer, applied to grammar #1.
 *
 * So: record, never throw. A miss keeps its substituted value EXACTLY as it
 * was — it just stops being silent.
 *
 * WHY AsyncLocalStorage and not a parameter — `substitute()` has a published
 * 4-argument signature with live callers (`playbook-lifecycle.resolveGoal`,
 * `intelligence.runCommand`) and is part of `ParsedTemplate`. Threading a sink
 * through it would break every caller and every implementor of the interface.
 * ALS leaves the signature untouched, keeps the collector's LIFETIME at the
 * call boundary where it is created and drained, and — unlike a module-level
 * mutable — cannot cross-contaminate two requests served concurrently by the
 * same process.
 *
 * This mirrors `unresolved-references.ts` on purpose. It is NOT an import of
 * it: that module lives in `@synap/jobs` (the api package does not depend on
 * jobs) and its `path`/`reason` vocabulary describes DAG paths, not template
 * arguments.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Why a reference produced nothing.
 *  - `unknown-arg`        — `@{arg:X}` / `{argument name="X"}` had no value in
 *    `argValues`. Substituted `""`. Almost always a rename or a caller that
 *    forgot to pass the param.
 *  - `unresolved-context` — `@{context:…}` / `{selection}` had no selection
 *    context, resolved URL, or resolved entity to draw on. Substituted `""`.
 *  - `unresolved-entity`  — `@{entity:ID:NAME}` whose ID was not in
 *    `resolvedEntities`. Substituted the author-time display name (a stale
 *    label, not nothing) — worth knowing, never fatal.
 *  - `literal-brace`      — a bare `{name}` that matches no declared argument.
 *    Left EXACTLY as written and delivered to the model as literal text. This
 *    is the failure mode that shipped in all 12 live playbooks.
 */
export type TemplateMissKind =
  "unknown-arg" | "unresolved-context" | "unresolved-entity" | "literal-brace";

export interface TemplateMiss {
  /** The reference as the author wrote it, e.g. `competitor` or `context:url`. */
  name: string;
  kind: TemplateMissKind;
  /** How many times this reference missed during the substitution. */
  count: number;
}

/**
 * Cap what any caller persists. A template can repeat the same broken
 * reference dozens of times; the `count` field carries the volume, so a row
 * never needs to.
 */
export const MAX_PERSISTED_TEMPLATE_MISSES = 20;

export class TemplateMissCollector {
  /** keyed by `${kind}:${name}` so a name that misses two ways never merges. */
  private readonly hits = new Map<string, TemplateMiss>();

  record(name: string, kind: TemplateMissKind): void {
    const key = `${kind}:${name}`;
    const existing = this.hits.get(key);
    if (existing) {
      existing.count += 1;
      return;
    }
    this.hits.set(key, { name, kind, count: 1 });
  }

  get size(): number {
    return this.hits.size;
  }

  /** Most-frequent first, then alphabetical — stable output for assertions. */
  list(): TemplateMiss[] {
    return [...this.hits.values()]
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, MAX_PERSISTED_TEMPLATE_MISSES);
  }
}

const storage = new AsyncLocalStorage<TemplateMissCollector>();

/** Explicit scoping. `substituteWithMisses()` is the door most callers want. */
export function withTemplateDiagnostics<T>(
  collector: TemplateMissCollector,
  fn: () => T
): T {
  return storage.run(collector, fn);
}

/**
 * Open a diagnostics scope bound to the current async context and return its
 * collector — for a caller that wants every substitution under it recorded
 * without wrapping each one in a callback.
 */
export function beginTemplateDiagnostics(): TemplateMissCollector {
  const collector = new TemplateMissCollector();
  storage.enterWith(collector);
  return collector;
}

/**
 * Record a reference that resolved to nothing. A no-op outside a diagnostics
 * scope — `substitute()` is called from tests and from callers that do not care,
 * and diagnostics must never be a reason for those to behave differently.
 */
export function recordTemplateMiss(name: string, kind: TemplateMissKind): void {
  storage.getStore()?.record(name, kind);
}

/**
 * The misses worth telling a human about: the ones an AUTHOR can fix.
 *
 * `unresolved-context` is deliberately dropped. Whether `@{context:url}` /
 * `@{context:text}` has anything to resolve is decided by the SURFACE, not by
 * the template: a browser run supplies a URL, a CLI/agent/automation run
 * legitimately supplies none, and `resolveGoal` never supplies any context at
 * all. Reporting those would make every playbook whose goal reads context warn
 * on its canonical happy path — and grammar #3 already paid for that lesson
 * (`unresolved-references.ts`, `isCallerSuppliedInput`): a diagnostic that fires
 * when nothing is wrong teaches the reader to ignore the ones that matter.
 *
 * THE TRADEOFF, stated rather than hidden: a genuine `@{context:urI}` typo is
 * invisible here — it parses as an unknown context type and resolves to `""`.
 * The right fix for that is author-time validation of the context vocabulary,
 * not a runtime warning nobody trusts. The collector still RECORDS context
 * misses; a caller that knows context was offered (an authoring preview) can
 * read `collector.list()` and show them.
 */
export function authoringMisses(misses: TemplateMiss[]): TemplateMiss[] {
  return misses.filter((m) => m.kind !== "unresolved-context");
}

/** The collector for the substitution currently executing, if any. */
export function currentTemplateDiagnostics():
  TemplateMissCollector | undefined {
  return storage.getStore();
}
