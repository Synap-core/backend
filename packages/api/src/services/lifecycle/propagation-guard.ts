/**
 * Re-entrancy guard for status-link propagation (Phase 0/1 of the dynamic
 * status links plan, decision aa0de6e6).
 *
 * A status move may ripple to linked entities through the governed
 * `moveStatus` door (see `propagate-status-link.ts`). That ripple is itself a
 * status move and would re-trigger propagation — one hop only is Phase 0/1's
 * behaviour — so the guard is set for the duration of one propagation pass
 * and the re-entrant call site in `move-status.ts` skips.
 *
 * Scoped to the propagation's async context (AsyncLocalStorage) so a nested
 * `moveStatus` inside the propagation chain sees the flag and skips, while an
 * unrelated top-level `moveStatus` in a concurrent request never does.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage<{ active: boolean }>();

/**
 * Enter the propagation async scope. All downstream `moveStatus` calls in the
 * same async chain see `isPropagationActive() === true` and skip their own
 * propagation. Nesting is safe: the propagation entry point is the first
 * scope; nested calls inherit it; when the scope exits the context is gone.
 */
export function withPropagationScope<T>(fn: () => Promise<T>): Promise<T> {
  return storage.run({ active: true }, () => fn());
}

export function isPropagationActive(): boolean {
  return storage.getStore()?.active === true;
}
