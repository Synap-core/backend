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

/** Dependencies handed to every reactor handler. */
export interface ReactorDeps {
  boss: PgBoss;
}

/**
 * The payload `emitSideEffects` receives and forwards to reactors.
 * Kept structurally in sync with `SideEffectPayload` (side-effects.ts) — the
 * canonical definition lives there and is re-exported as the public type.
 */
export interface ReactorPayload {
  subjectType: string;
  action: string;
  subjectId: string;
  userId: string;
  workspaceId?: string | null;
  data?: Record<string, unknown>;
  automationContext?: {
    automationRunId: string;
    automationId: string;
    chainDepth: number;
    rootRunId?: string;
    chainAutomationIds?: string[];
  };
  sessionId?: string | null;
}

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
