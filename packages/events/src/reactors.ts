/**
 * Reactor Registry
 *
 * A reactor is a single named side-effect that fires after a successful CRUD
 * operation. `emitSideEffects` (side-effects.ts) iterates the registered
 * reactors in registration order — adding a new reaction means registering a
 * new reactor, never editing the emit loop.
 *
 * BEHAVIOR CONTRACT (must be preserved by the emit loop):
 *   - Reactors run sequentially in registration order.
 *   - A reactor with no `match` runs for every emit; a `match` lets it
 *     self-filter (typically by subjectType/action).
 *   - Error semantics are owned by the caller (`emitSideEffects`), which today
 *     wraps the whole sequence in ONE try/catch — so a throwing reactor aborts
 *     the rest. Reactors themselves do not catch.
 */

import type PgBoss from "pg-boss";
// TYPE-ONLY, and load-bearing: erased at runtime, so the one-way value
// dependency (side-effects.ts → this registry) is unchanged.
import type { SideEffectPayload } from "./side-effects.js";

/** Dependencies handed to every reactor handler. */
export interface ReactorDeps {
  boss: PgBoss;
}

/**
 * The payload `emitSideEffects` receives and forwards to reactors.
 *
 * DERIVED from `SideEffectPayload`, not copied. It used to be a hand-maintained
 * structural twin under a comment asserting the two were "kept in sync" — which
 * is the worst shape available: a mirror ONE FIELD BEHIND still typechecks and
 * still reads as authoritative, so a field added to the emit payload and not to
 * this copy is dropped at the reactor boundary with every type green and the
 * docblock still claiming parity. `eventId` would have been the tenth field to
 * need copying. An alias cannot drift.
 *
 * The import is TYPE-ONLY, so it is erased at runtime and the value-level
 * dependency still runs one way (side-effects.ts imports the registry from
 * here, never the reverse).
 */
export type ReactorPayload = SideEffectPayload;

export interface Reactor {
  /** Stable identifier (matches the existing reaction name). */
  id: string;
  /**
   * Optional self-filter. When omitted, the reactor runs for every emit. When
   * present and it returns false, the reactor's handler is skipped.
   */
  match?(payload: ReactorPayload): boolean;
  /** Enqueue the reactor's side-effect job(s). */
  handler(payload: ReactorPayload, deps: ReactorDeps): Promise<void>;
}

const reactors: Reactor[] = [];

/**
 * Register a reactor. Registration order is preserved and is the order in which
 * `emitSideEffects` runs them — keep this identical when migrating reactions.
 */
export function registerReactor(reactor: Reactor): void {
  reactors.push(reactor);
}

/** Internal ordered list of registered reactors (read-only view for tests). */
export function getReactors(): readonly Reactor[] {
  return reactors;
}
