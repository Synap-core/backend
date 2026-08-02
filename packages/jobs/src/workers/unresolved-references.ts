/**
 * Unresolved-reference diagnostics for the automation executor.
 *
 * WHY THIS EXISTS — `resolveTemplate` renders ANY unresolvable `{{path}}` as the
 * EMPTY STRING. That is deliberate and load-bearing (the report flow's STEER
 * block interpolates `{{trigger.payload.prompt}}` and reads "" as "no steer
 * given"), but it also means a genuine wiring bug is INVISIBLE: on 2026-07-27 a
 * whole-string-reference regex fault captured a junk path, every projection
 * resolved to `undefined`, every step reported SUCCESS, and the run confidently
 * concluded "the workspace contains no data" while the pod held 706 entities.
 *
 * So: record, never throw. An unresolved reference stays a "" — it just stops
 * being silent. The diagnostics land on the step row so the run UI can show
 * "this step read 4 references that resolved to nothing".
 *
 * WHY AsyncLocalStorage and not a parameter — the resolvers are pure exported
 * functions called from ~40 sites (including inside array-pipe predicates,
 * where the CORRECT context is a synthetic per-item context, not the step's).
 * Threading a sink through every signature would ripple across the whole file
 * and still mis-attribute the pipe sites. ALS keeps the resolvers' signatures
 * and return types untouched, keeps the collector's LIFETIME at the step
 * boundary (where it is created and drained), and — unlike a module-level
 * mutable — cannot cross-contaminate two runs executing concurrently in the
 * same worker process.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Why a reference produced nothing.
 *  - `missing` — the path could not be walked: some segment does not exist on
 *    the context (a typo, a step that never ran, a junk path). Almost always a
 *    bug.
 *  - `null`    — every segment existed and the final value is `null`/`undefined`
 *    (the field is there, it just has no value). Often legitimate.
 *
 * These two are cheaply separable because the walker knows whether it stopped
 * early. We deliberately do NOT report a resolved `""` — an empty string is a
 * real value the author may have meant.
 */
export type UnresolvedReferenceReason = "missing" | "null";

export interface UnresolvedReference {
  /** The inner path exactly as written between the braces, trimmed. */
  path: string;
  reason: UnresolvedReferenceReason;
  /** How many times this path resolved to nothing during the step. */
  count: number;
}

/**
 * Cap what we persist. A loop node can resolve the same broken reference once
 * per item (up to MAX_LOOP_ITERATIONS=100 × N refs); the `count` field carries
 * the volume, so the row never needs to.
 */
export const MAX_PERSISTED_UNRESOLVED_REFS = 20;

/**
 * The reserved key under which diagnostics are merged into
 * `automation_step_runs.resolved_inputs`. Double-underscored so it cannot
 * collide with a user-authored inputMapping key.
 */
export const UNRESOLVED_REFS_KEY = "__unresolvedRefs";

export class UnresolvedReferenceCollector {
  /** keyed by `${reason}:${path}` so a path that is both never double-counts. */
  private readonly hits = new Map<string, UnresolvedReference>();

  record(path: string, reason: UnresolvedReferenceReason): void {
    const key = `${reason}:${path}`;
    const existing = this.hits.get(key);
    if (existing) {
      existing.count += 1;
      return;
    }
    this.hits.set(key, { path, reason, count: 1 });
  }

  get size(): number {
    return this.hits.size;
  }

  /** Most-frequent first, then alphabetical — stable output for assertions. */
  list(): UnresolvedReference[] {
    return [...this.hits.values()]
      .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path))
      .slice(0, MAX_PERSISTED_UNRESOLVED_REFS);
  }
}

const storage = new AsyncLocalStorage<UnresolvedReferenceCollector>();

/**
 * Open a diagnostics scope for ONE step and return its collector.
 *
 * `enterWith` (not `run`) so the executor's node walk needs a single statement
 * per node instead of wrapping its ~700-line switch in a callback: the store
 * binds to the current async context and every awaited descendant of this node's
 * execution — until the next node calls this again and replaces it. Concurrent
 * runs live in separate async contexts (one per pg-boss handler invocation), so
 * they never see each other's collector.
 */
export function beginStepDiagnostics(): UnresolvedReferenceCollector {
  const collector = new UnresolvedReferenceCollector();
  storage.enterWith(collector);
  return collector;
}

/** Explicit scoping — used by tests and by any caller that wants containment. */
export function withStepDiagnostics<T>(
  collector: UnresolvedReferenceCollector,
  fn: () => T
): T {
  return storage.run(collector, fn);
}

/**
 * Record a reference that resolved to nothing. A no-op outside a step scope —
 * `resolveTemplate` is exported and called from tests and other workers, and
 * diagnostics must never be a reason for those to behave differently.
 */
export function recordUnresolvedReference(
  path: string,
  reason: UnresolvedReferenceReason
): void {
  if (isCallerSuppliedInput(path)) return;
  if (isEntityPropertyBagRead(path)) return;
  storage.getStore()?.record(path, reason);
}

/**
 * Is this path reading the CALLER'S INPUT rather than the flow's own WIRING?
 *
 * `trigger.payload.*` is whatever the caller passed when starting the run. On a
 * manually-triggered automation with no payload, every one of those references
 * legitimately resolves to nothing — that is an input condition, not a fault.
 *
 * WHY THIS MATTERS ENOUGH TO SPECIAL-CASE: the report flow's STEER block reads
 * three payload keys in each of three AI rounds, and running it with no steer
 * is its DOCUMENTED default. Without this rule a perfectly healthy report
 * produces NINE "could not be resolved" warnings — and a diagnostic that fires
 * on the canonical happy path of the very feature it was built for is not a
 * diagnostic, it is noise that teaches the reader to ignore the panel. The
 * signal is only worth having if it stays rare.
 *
 * THE TRADEOFF, stated rather than hidden: a genuine TYPO in a payload path
 * (`trigger.payload.promt`) is now invisible here. That is the deliberate
 * lesser evil — it still renders as empty text the author can see in the
 * step's resolved inputs, whereas a panel nobody trusts catches nothing at
 * all. The real fix for that case is letting a flow DECLARE a reference
 * required, which is a config-level change, not a recording-level one.
 *
 * Wiring references — `steps.*`, `loop.*`, `automation.*` — are unaffected:
 * those are authored by the flow, and a miss there is almost always a bug.
 */
function isCallerSuppliedInput(path: string): boolean {
  return path === "trigger.payload" || path.startsWith("trigger.payload.");
}

/**
 * The SAME rule as `isCallerSuppliedInput`, applied to the other sparse bag in
 * the engine: an ITERATION ITEM'S ENTITY PROPERTY BAG.
 *
 * `entities.properties` is an OPEN, per-record key/value map. A task with no due
 * date simply has no `dueDate` key — that is normal DATA SPARSITY, not a wiring
 * fault, and `lookupContextPath` cannot tell the two apart because an absent
 * object key is `missing` either way.
 *
 * WHY THIS MATTERS ENOUGH TO SPECIAL-CASE — measured, not hypothesised. The
 * report flow's per-kind projections (`ensure-report-automation.ts`,
 * `projectionNode`) render `status`/`priority`/`dueDate`/`email`/
 * `lastInteractionAt`/`industry`/`location` for EVERY row of a `map:` pipe. A
 * healthy run on 2026-08-01 recorded 88 "missing" hits across 7 such paths and
 * SATURATED `MAX_PERSISTED_UNRESOLVED_REFS` (20) — so the run UI reported a
 * wiring fault on a correct report, and the genuine wiring miss it was built to
 * catch (the 2026-07-27 silent-empty run) would have been pushed off the list
 * entirely. A diagnostic that fires on the happy path of the feature it guards
 * is noise.
 *
 * WHY THIS EXACT PREFIX AND NOT `item.*` — the item's OWN shape is fixed
 * (`id`, `title`, `updatedAt`, …), so a miss there IS a wiring fault and stays
 * recorded. Only the open bag hanging off it is exempt. Concretely:
 *   - `item.properties.dueDate`      → exempt (unset field on this record)
 *   - `item.propertyz.status`        → STILL RECORDED (typo'd segment)
 *   - `item.titel`                   → STILL RECORDED (typo on a fixed field)
 *   - `steps.q1.output.properties.x` → STILL RECORDED (not an iteration item)
 * `loop.item.*` is covered too: the loop node and the array pipes bind the same
 * object under both names, so the two spellings must behave identically.
 *
 * THE TRADEOFF, stated rather than hidden: a typo INSIDE the bag
 * (`item.properties.duDate`) is now invisible here. That is unavoidable at this
 * layer — the bag is open, so "the profile has no such property slug" and "this
 * record has not set it" are the SAME observation unless the resolver consults
 * the property-def registry, which it does not have. Catching that class needs
 * projection-time slug validation against `getEffectiveProperties`, which is a
 * config-level check, not a recording-level one.
 */
function isEntityPropertyBagRead(path: string): boolean {
  return /^(?:loop\.)?item\.properties(?:\.|$)/.test(path);
}

/** The collector for the step currently executing, if any. */
export function currentStepDiagnostics():
  UnresolvedReferenceCollector | undefined {
  return storage.getStore();
}
